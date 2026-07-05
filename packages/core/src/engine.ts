import { extractAnchors } from "./anchors.js";
import { hashCode, sha256 } from "./hash.js";
import { DriftStore } from "./store.js";
import type { SymbolIndex } from "./symbol-index.js";
import type {
  Link,
  LinkEvaluation,
  LinkStatus,
  SpecContext,
  Symbol,
} from "./types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Drift engine ties a read-only symbol index (CodeGraph or the built-in
 * tree-sitter backend) and Drift's own store together. Every operation here
 * is hash comparison + indexed lookups — no LLM calls, no full-text scans
 * (the core token-efficiency claim).
 */
export class DriftEngine {
  constructor(
    public readonly symbols: SymbolIndex,
    public readonly store: DriftStore,
    public readonly repoRoot: string,
  ) {}

  /** Hash a symbol's source, preferring the backend's AST normalization. */
  hashSymbolSource(source: string, filePath: string): string {
    return this.symbols.normalizeSource
      ? sha256(this.symbols.normalizeSource(source, filePath))
      : hashCode(source);
  }

  /**
   * Does this source still match an approved hash? Checks the backend's
   * normalization AND the regex fallback, so links approved under one
   * backend (e.g. CodeGraph locally) don't flag as falsely stale when
   * evaluated under the other (e.g. builtin in CI).
   */
  private sourceMatchesHash(source: string, filePath: string, approvedHash: string): boolean {
    if (this.hashSymbolSource(source, filePath) === approvedHash) return true;
    return this.symbols.normalizeSource ? hashCode(source) === approvedHash : false;
  }

  // ---- indexing ------------------------------------------------------

  /** Re-extract anchors for one markdown file into the store. */
  indexSpecFile(relPath: string): number {
    const markdown = readFileSync(join(this.repoRoot, relPath), "utf8");
    const anchors = extractAnchors(relPath, markdown);
    this.store.replaceAnchorsForFile(relPath, anchors);
    return anchors.length;
  }

  // ---- status (Q4 hash detection, Q13 broken) -------------------------

  // @spec: docs/design.md#hash-based-staleness-detection
  evaluateLink(link: Link): LinkEvaluation {
    const symbol = this.symbols.getSymbolById(link.symbolId)
      ?? this.symbols.findSymbol(link.symbolQualifiedName);
    const anchor = this.store.getAnchor(link.anchorId);

    const missing = { symbol: symbol === null, anchor: anchor === null };
    if (missing.symbol || missing.anchor) {
      const movedTo = missing.symbol ? this.findMovedSymbol(link) : null;
      return {
        link,
        status: "broken",
        drift: { symbol: false, anchor: false },
        missing,
        movedTo: movedTo
          ? { symbol: movedTo.qualifiedName, filePath: movedTo.filePath }
          : undefined,
      };
    }

    const source = this.symbols.readSymbolSource(symbol!);
    if (source === null) {
      return {
        link,
        status: "broken",
        drift: { symbol: false, anchor: false },
        missing: { symbol: true, anchor: false },
      };
    }

    const drift = {
      symbol: !this.sourceMatchesHash(source, symbol!.filePath, link.approvedSymbolHash),
      anchor: anchor!.bodyHash !== link.approvedAnchorHash,
    };
    return {
      link,
      status: drift.symbol || drift.anchor ? "stale" : "fresh",
      drift,
      missing: { symbol: false, anchor: false },
    };
  }

  evaluateAll(): LinkEvaluation[] {
    return this.store.allLinks().map((l) => this.evaluateLink(l));
  }

  /** Evaluate only links touched by the given changed files (PR bot path). */
  evaluateForChangedFiles(changedFiles: string[]): LinkEvaluation[] {
    const seen = new Set<number>();
    const out: LinkEvaluation[] = [];
    for (const f of changedFiles) {
      const links = f.endsWith(".md")
        ? this.store.linksForSpecFile(f)
        : this.store.linksForCodeFile(f);
      for (const l of links) {
        if (seen.has(l.id)) continue;
        seen.add(l.id);
        out.push(this.evaluateLink(l));
      }
    }
    return out;
  }

  // ---- rename tracking -------------------------------------------------

  /**
   * When a linked symbol vanished, look for a symbol whose CURRENT source
   * hashes to the link's approved hash. Two forms match: an unchanged body
   * (file move), and a pure rename — detected by substituting the
   * candidate's name back to the old name before hashing, which also covers
   * self-references like recursion. Same file first, then the whole index.
   */
  // @spec: docs/design.md#rename-tracking
  findMovedSymbol(link: Link): Symbol | null {
    const target = link.approvedSymbolHash;
    const oldName = link.symbolQualifiedName.split("::").pop() ?? link.symbolQualifiedName;
    const fileCache = new Map<string, string[] | null>();

    const sourceOf = (s: Symbol): string | null => {
      let lines = fileCache.get(s.filePath);
      if (lines === undefined) {
        try {
          lines = readFileSync(join(this.repoRoot, s.filePath), "utf8").split("\n");
        } catch {
          lines = null;
        }
        fileCache.set(s.filePath, lines);
      }
      return lines ? lines.slice(s.startLine - 1, s.endLine).join("\n") : null;
    };

    const matches = (s: Symbol): boolean => {
      const src = sourceOf(s);
      if (src === null) return false;
      if (this.sourceMatchesHash(src, s.filePath, target)) return true; // moved, same name
      if (s.name === oldName) return false;
      const escaped = s.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const renamed = src.replace(new RegExp(`\\b${escaped}\\b`, "g"), oldName);
      return this.sourceMatchesHash(renamed, s.filePath, target);
    };

    for (const s of this.symbols.symbolsInFile(link.symbolFilePath)) {
      if (matches(s)) return s;
    }
    // repo-wide pass, capped so a pathological index can't stall a status call
    const all = this.symbols.listSymbols();
    if (all.length > 5000) return null;
    for (const s of all) {
      if (s.filePath === link.symbolFilePath) continue;
      if (matches(s)) return s;
    }
    return null;
  }

  /**
   * Re-point a broken link at a renamed/moved symbol, keeping the approved
   * anchor hash and origin. Target defaults to the moved-symbol candidate.
   */
  relink(linkId: number, toSymbolName?: string, actor?: string): LinkEvaluation {
    const link = this.store.getLink(linkId);
    if (!link) throw new Error(`link not found: ${linkId}`);

    let target: Symbol | null;
    if (toSymbolName) {
      target = this.symbols.findSymbol(toSymbolName);
      if (!target) throw new Error(`symbol not found: ${toSymbolName}`);
    } else {
      target = this.findMovedSymbol(link);
      if (!target) {
        throw new Error(
          `no moved candidate found for link ${linkId}; ` +
            `pass the new symbol explicitly: drift relink ${linkId} <symbol>`,
        );
      }
    }
    const source = this.symbols.readSymbolSource(target);
    if (source === null) throw new Error(`cannot read source for ${target.qualifiedName}`);

    this.store.relinkSymbol(
      linkId,
      {
        symbolId: target.id,
        symbolQualifiedName: target.qualifiedName,
        symbolFilePath: target.filePath,
        approvedSymbolHash: this.hashSymbolSource(source, target.filePath),
      },
      actor,
    );
    return this.evaluateLink(this.store.getLink(linkId)!);
  }

  // ---- lookup: code -> spec (Q21 hierarchical fallback) ----------------

  /**
   * Resolve the spec context for a symbol. Walks corresponds_to edges;
   * if the symbol has none, climbs the containment chain
   * (method -> class -> file) and marks the result as inferred.
   * Cost: O(degree) indexed lookups. Never scans documents.
   */
  // @spec: docs/design.md#hierarchical-context-fallback
  specContext(symbolName: string): SpecContext | null {
    const symbol = this.symbols.findSymbol(symbolName);
    if (!symbol) return null;

    let resolved: Symbol = symbol;
    let inferred = false;
    let links = this.store.linksForSymbol(symbol.id);

    if (links.length === 0) {
      for (const parent of this.symbols.containmentChain(symbol)) {
        const parentLinks = this.store.linksForSymbol(parent.id);
        if (parentLinks.length > 0) {
          resolved = parent;
          inferred = true;
          links = parentLinks;
          break;
        }
      }
    }
    if (links.length === 0) {
      return {
        symbol: symbol.qualifiedName,
        inferred: false,
        resolvedSymbol: symbol.qualifiedName,
        entries: [],
        freshness: { fresh: 0, total: 0 },
      };
    }

    const entries = links.map((link) => {
      const ev = this.evaluateLink(link);
      const anchor = this.store.getAnchor(link.anchorId);
      return {
        anchorId: link.anchorId,
        heading: anchor?.heading ?? "(missing)",
        body: anchor?.body ?? "",
        status: ev.status,
      };
    });
    const fresh = entries.filter((e) => e.status === "fresh").length;
    return {
      symbol: symbol.qualifiedName,
      inferred,
      resolvedSymbol: resolved.qualifiedName,
      entries,
      freshness: { fresh, total: entries.length },
    };
  }

  // ---- lookup: spec -> code (reverse edge walk) ------------------------

  /** All symbols documented by a spec anchor (or any anchor in a file). */
  codeForSpec(anchorOrFile: string): Array<{
    linkId: number;
    anchorId: string;
    heading: string;
    symbol: string;
    filePath: string;
    status: LinkStatus;
    origin: Link["origin"];
  }> {
    const links = anchorOrFile.includes("#")
      ? this.store.linksForAnchor(anchorOrFile)
      : this.store.linksForSpecFile(anchorOrFile);
    return links.map((link) => ({
      linkId: link.id,
      anchorId: link.anchorId,
      heading: this.store.getAnchor(link.anchorId)?.heading ?? "(missing)",
      symbol: link.symbolQualifiedName,
      filePath: link.symbolFilePath,
      status: this.evaluateLink(link).status,
      origin: link.origin,
    }));
  }

  /**
   * Links anchored in one CODE file, with current symbol line spans —
   * the editor-integration view (VS Code CodeLens).
   */
  linksForCodeFile(filePath: string): Array<{
    linkId: number;
    symbol: string;
    anchorId: string;
    heading: string;
    status: LinkStatus;
    startLine: number | null;
    endLine: number | null;
    movedTo?: { symbol: string; filePath: string };
  }> {
    return this.store.linksForCodeFile(filePath).map((link) => {
      const ev = this.evaluateLink(link);
      const symbol =
        this.symbols.getSymbolById(link.symbolId) ??
        this.symbols.findSymbol(link.symbolQualifiedName);
      return {
        linkId: link.id,
        symbol: link.symbolQualifiedName,
        anchorId: link.anchorId,
        heading: this.store.getAnchor(link.anchorId)?.heading ?? "(missing)",
        status: ev.status,
        startLine: symbol?.startLine ?? null,
        endLine: symbol?.endLine ?? null,
        movedTo: ev.movedTo,
      };
    });
  }

  // ---- link creation ---------------------------------------------------

  /** Create (or re-pin) a link, pinning both current hashes as approved. */
  link(symbolName: string, anchorId: string, origin: Link["origin"], actor?: string): Link {
    const symbol = this.symbols.findSymbol(symbolName);
    if (!symbol) throw new Error(`symbol not found in index: ${symbolName}`);
    const anchor = this.store.getAnchor(anchorId);
    if (!anchor) throw new Error(`spec anchor not found: ${anchorId} (run drift index first)`);
    const source = this.symbols.readSymbolSource(symbol);
    if (source === null) throw new Error(`cannot read source for ${symbol.qualifiedName}`);
    return this.store.createLink({
      symbolId: symbol.id,
      symbolQualifiedName: symbol.qualifiedName,
      symbolFilePath: symbol.filePath,
      anchorId,
      origin,
      symbolHash: this.hashSymbolSource(source, symbol.filePath),
      anchorHash: anchor.bodyHash,
      actor,
    });
  }

  /** One-click approve (Q7): re-pin current hashes on an existing link. */
  // @spec: docs/design.md#approval-workflow
  approve(linkId: number, actor?: string): LinkEvaluation {
    const link = this.store.getLink(linkId);
    if (!link) throw new Error(`link not found: ${linkId}`);
    const ev = this.evaluateLink(link);
    if (ev.status === "broken") {
      throw new Error(
        `link ${linkId} is broken (missing ${ev.missing.symbol ? "symbol" : "anchor"}); ` +
          `remove it with 'drift unlink ${linkId}' instead`,
      );
    }
    const symbol = this.symbols.getSymbolById(link.symbolId)
      ?? this.symbols.findSymbol(link.symbolQualifiedName)!;
    const source = this.symbols.readSymbolSource(symbol)!;
    const anchor = this.store.getAnchor(link.anchorId)!;
    this.store.approveLink(
      linkId,
      this.hashSymbolSource(source, symbol.filePath),
      anchor.bodyHash,
      actor,
    );
    return this.evaluateLink(this.store.getLink(linkId)!);
  }
}
