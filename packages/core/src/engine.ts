import { extractAnchors } from "./anchors.js";
import { CodeGraphReader } from "./codegraph.js";
import { hashCode } from "./hash.js";
import { DriftStore } from "./store.js";
import type {
  Link,
  LinkEvaluation,
  SpecContext,
  Symbol,
} from "./types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The Drift engine ties the read-only CodeGraph view and Drift's own store
 * together. Every operation here is hash comparison + indexed lookups —
 * no LLM calls, no full-text scans (the core token-efficiency claim).
 */
export class DriftEngine {
  constructor(
    public readonly codegraph: CodeGraphReader,
    public readonly store: DriftStore,
    public readonly repoRoot: string,
  ) {}

  // ---- indexing ------------------------------------------------------

  /** Re-extract anchors for one markdown file into the store. */
  indexSpecFile(relPath: string): number {
    const markdown = readFileSync(join(this.repoRoot, relPath), "utf8");
    const anchors = extractAnchors(relPath, markdown);
    this.store.replaceAnchorsForFile(relPath, anchors);
    return anchors.length;
  }

  // ---- status (Q4 hash detection, Q13 broken) -------------------------

  evaluateLink(link: Link): LinkEvaluation {
    const symbol = this.codegraph.getSymbolById(link.symbolId)
      ?? this.codegraph.findSymbol(link.symbolQualifiedName);
    const anchor = this.store.getAnchor(link.anchorId);

    const missing = { symbol: symbol === null, anchor: anchor === null };
    if (missing.symbol || missing.anchor) {
      return { link, status: "broken", drift: { symbol: false, anchor: false }, missing };
    }

    const source = this.codegraph.readSymbolSource(symbol!);
    if (source === null) {
      return {
        link,
        status: "broken",
        drift: { symbol: false, anchor: false },
        missing: { symbol: true, anchor: false },
      };
    }

    const drift = {
      symbol: hashCode(source) !== link.approvedSymbolHash,
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

  // ---- lookup: code -> spec (Q21 hierarchical fallback) ----------------

  /**
   * Resolve the spec context for a symbol. Walks corresponds_to edges;
   * if the symbol has none, climbs the containment chain
   * (method -> class -> file) and marks the result as inferred.
   * Cost: O(degree) indexed lookups. Never scans documents.
   */
  specContext(symbolName: string): SpecContext | null {
    const symbol = this.codegraph.findSymbol(symbolName);
    if (!symbol) return null;

    let resolved: Symbol = symbol;
    let inferred = false;
    let links = this.store.linksForSymbol(symbol.id);

    if (links.length === 0) {
      for (const parent of this.codegraph.containmentChain(symbol)) {
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
    anchorId: string;
    symbol: string;
    filePath: string;
    status: string;
  }> {
    const links = anchorOrFile.includes("#")
      ? this.store.linksForAnchor(anchorOrFile)
      : this.store.linksForSpecFile(anchorOrFile);
    return links.map((link) => ({
      anchorId: link.anchorId,
      symbol: link.symbolQualifiedName,
      filePath: link.symbolFilePath,
      status: this.evaluateLink(link).status,
    }));
  }

  // ---- link creation ---------------------------------------------------

  /** Create (or re-pin) a link, pinning both current hashes as approved. */
  link(symbolName: string, anchorId: string, origin: Link["origin"], actor?: string): Link {
    const symbol = this.codegraph.findSymbol(symbolName);
    if (!symbol) throw new Error(`symbol not found in CodeGraph: ${symbolName}`);
    const anchor = this.store.getAnchor(anchorId);
    if (!anchor) throw new Error(`spec anchor not found: ${anchorId} (run drift index first)`);
    const source = this.codegraph.readSymbolSource(symbol);
    if (source === null) throw new Error(`cannot read source for ${symbol.qualifiedName}`);
    return this.store.createLink({
      symbolId: symbol.id,
      symbolQualifiedName: symbol.qualifiedName,
      symbolFilePath: symbol.filePath,
      anchorId,
      origin,
      symbolHash: hashCode(source),
      anchorHash: anchor.bodyHash,
      actor,
    });
  }

  /** One-click approve (Q7): re-pin current hashes on an existing link. */
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
    const symbol = this.codegraph.getSymbolById(link.symbolId)
      ?? this.codegraph.findSymbol(link.symbolQualifiedName)!;
    const source = this.codegraph.readSymbolSource(symbol)!;
    const anchor = this.store.getAnchor(link.anchorId)!;
    this.store.approveLink(linkId, hashCode(source), anchor.bodyHash, actor);
    return this.evaluateLink(this.store.getLink(linkId)!);
  }
}
