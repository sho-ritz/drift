import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DriftEngine } from "./engine.js";
import type { Symbol } from "./types.js";

/** A link declaration discovered by one of the pluggable strategies (Q3). */
export interface LinkDeclaration {
  symbol: string;
  anchorId: string;
  origin: "annotation" | "mapping";
  sourceFile: string;
  line: number;
}

/** Result of scanning code files for @spec: annotations. */
export interface AnnotationScan {
  declarations: LinkDeclaration[];
  warnings: string[];
  /** number of files actually read (exists + had symbols) */
  scannedFiles: number;
}

/**
 * Symbol kinds an @spec: annotation is expected to document. Binding to
 * anything else (type alias, constant, variable, property) is usually the
 * line-order heuristic latching onto the wrong neighbor, so it warns.
 */
const LINKABLE_KINDS = new Set([
  "function",
  "method",
  "class",
  "component",
  "interface",
  "struct",
  "enum",
  "trait",
  "module",
]);

/**
 * An annotation is expected to sit directly above its symbol. If the
 * nearest symbol starts further than this many lines below, the binding
 * is suspect and warns.
 */
const MAX_ANNOTATION_DISTANCE = 5;

/**
 * Strategy 1: lightweight code annotations.
 * Scans for `@spec: docs/auth.md#token-refresh` in comments on the lines
 * directly above a symbol. The symbol is whichever CodeGraph node starts
 * closest below the annotation line — preferring linkable kinds
 * (function/class/…) so an interposed type alias or constant doesn't
 * steal the link.
 */
const ANNOTATION_RE = /@spec:\s*([^\s*]+\.md#[\w-]+)/g;
// non-global twin for one-off tests (a /g regex is stateful under .test())
const ANNOTATION_TEST_RE = /@spec:\s*[^\s*]+\.md#[\w-]+/;

function pickTarget(symbols: Symbol[], annotationLine: number): {
  target: Symbol | null;
  skipped: Symbol[];
} {
  const below = symbols
    .filter((s) => s.startLine > annotationLine)
    .sort((a, b) => a.startLine - b.startLine);
  if (below.length === 0) return { target: null, skipped: [] };

  // Prefer the first linkable symbol within the proximity window, even if a
  // non-linkable one (type alias, const) sits between it and the annotation.
  const nearest = below[0];
  const windowEnd = annotationLine + MAX_ANNOTATION_DISTANCE;
  const linkable = below.find(
    (s) => LINKABLE_KINDS.has(s.kind) && s.startLine <= windowEnd,
  );
  if (linkable) {
    return {
      target: linkable,
      skipped: below.filter(
        (s) => s.startLine < linkable.startLine && !LINKABLE_KINDS.has(s.kind),
      ),
    };
  }
  return { target: nearest, skipped: [] };
}

export function scanAnnotations(
  engine: DriftEngine,
  codeFiles: string[],
): AnnotationScan {
  const declarations: LinkDeclaration[] = [];
  const warnings: string[] = [];
  let scannedFiles = 0;

  for (const rel of codeFiles) {
    const abs = join(engine.repoRoot, rel);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, "utf8").split("\n");
    const symbols = engine.codegraph.symbolsInFile(rel);
    scannedFiles++;
    if (symbols.length === 0) {
      if (lines.some((l) => ANNOTATION_TEST_RE.test(l))) {
        warnings.push(
          `${rel}: has @spec: annotations but no symbols in CodeGraph — ` +
            `is the file indexed? (run: codegraph index)`,
        );
      }
      continue;
    }

    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(ANNOTATION_RE)) {
        const lineNo = i + 1;
        const { target, skipped } = pickTarget(symbols, i + 1);
        if (!target) {
          warnings.push(
            `${rel}:${lineNo} @spec: ${m[1]} has no symbol below it — annotation ignored`,
          );
          continue;
        }
        if (!LINKABLE_KINDS.has(target.kind)) {
          warnings.push(
            `${rel}:${lineNo} @spec: ${m[1]} binds to ${target.kind} '${target.qualifiedName}' — ` +
              `expected a function/class/component; move the comment directly above the intended symbol ` +
              `or link explicitly with 'drift link'`,
          );
        }
        if (target.startLine - lineNo > MAX_ANNOTATION_DISTANCE) {
          warnings.push(
            `${rel}:${lineNo} @spec: ${m[1]} is ${target.startLine - lineNo} lines above ` +
              `'${target.qualifiedName}' — bindings further than ${MAX_ANNOTATION_DISTANCE} lines are suspect`,
          );
        }
        for (const s of skipped) {
          warnings.push(
            `${rel}:${lineNo} @spec: ${m[1]} skipped ${s.kind} '${s.qualifiedName}' and ` +
              `bound to '${target.qualifiedName}' (nearest linkable symbol)`,
          );
        }
        declarations.push({
          symbol: target.qualifiedName,
          anchorId: m[1],
          origin: "annotation",
          sourceFile: rel,
          line: lineNo,
        });
      }
    }
  }
  return { declarations, warnings, scannedFiles };
}

/**
 * Strategy 2: standalone mapping file (.drift/links.json).
 * Zero-touch for both code and docs.
 */
export function loadMappingFile(repoRoot: string): LinkDeclaration[] {
  const path = join(repoRoot, ".drift", "links.json");
  if (!existsSync(path)) return [];
  const entries = JSON.parse(readFileSync(path, "utf8")) as Array<{
    symbol: string;
    spec: string;
  }>;
  return entries.map((e, i) => ({
    symbol: e.symbol,
    anchorId: e.spec,
    origin: "mapping" as const,
    sourceFile: ".drift/links.json",
    line: i + 1,
  }));
}

/**
 * Apply declarations to the store. Existing links keep their approved
 * hashes (re-running sync is idempotent and never resets staleness);
 * new declarations create links pinned at current hashes.
 */
export function syncDeclarations(
  engine: DriftEngine,
  decls: LinkDeclaration[],
): { created: number; kept: number; errors: string[] } {
  let created = 0;
  let kept = 0;
  const errors: string[] = [];
  for (const d of decls) {
    try {
      const symbol = engine.codegraph.findSymbol(d.symbol);
      if (!symbol) throw new Error(`symbol not found: ${d.symbol}`);
      const existing = engine.store.getLinkBySymbolAnchor(symbol.id, d.anchorId);
      if (existing) {
        kept++;
        continue;
      }
      engine.link(d.symbol, d.anchorId, d.origin);
      created++;
    } catch (e) {
      errors.push(`${d.sourceFile}:${d.line} ${(e as Error).message}`);
    }
  }
  return { created, kept, errors };
}
