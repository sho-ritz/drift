import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DriftEngine } from "./engine.js";

/** A link declaration discovered by one of the pluggable strategies (Q3). */
export interface LinkDeclaration {
  symbol: string;
  anchorId: string;
  origin: "annotation" | "mapping";
  sourceFile: string;
  line: number;
}

/**
 * Strategy 1: lightweight code annotations.
 * Scans for `@spec: docs/auth.md#token-refresh` in comments on the lines
 * directly above a symbol. The symbol is whichever CodeGraph node starts
 * closest below the annotation line.
 */
const ANNOTATION_RE = /@spec:\s*([^\s*]+\.md#[\w-]+)/g;

export function scanAnnotations(
  engine: DriftEngine,
  codeFiles: string[],
): LinkDeclaration[] {
  const out: LinkDeclaration[] = [];
  for (const rel of codeFiles) {
    const abs = join(engine.repoRoot, rel);
    if (!existsSync(abs)) continue;
    const lines = readFileSync(abs, "utf8").split("\n");
    const symbols = engine.codegraph.symbolsInFile(rel);
    if (symbols.length === 0) continue;

    for (let i = 0; i < lines.length; i++) {
      for (const m of lines[i].matchAll(ANNOTATION_RE)) {
        // nearest symbol starting at or below the annotation line
        const target = symbols
          .filter((s) => s.startLine > i)
          .sort((a, b) => a.startLine - b.startLine)[0];
        if (!target) continue;
        out.push({
          symbol: target.qualifiedName,
          anchorId: m[1],
          origin: "annotation",
          sourceFile: rel,
          line: i + 1,
        });
      }
    }
  }
  return out;
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
