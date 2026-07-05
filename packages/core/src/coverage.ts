import type { DriftEngine } from "./engine.js";

/**
 * drift coverage: how much of the codebase is spec-linked — the number
 * that makes drift's value measurable (like test coverage, but for docs).
 * 100% is NOT the goal; the metric exists to track the trend on the
 * public/important surface, not to force specs onto every helper.
 */

/** Kinds counted as coverable — mirrors the suggest strategy's set. */
export const COVERABLE_KINDS = [
  "function",
  "method",
  "class",
  "component",
  "interface",
  "struct",
  "enum",
  "trait",
];

export interface CoverageReport {
  /** coverable symbols in the index */
  totalSymbols: number;
  /** symbols with at least one link */
  linkedSymbols: number;
  /** linkedSymbols / totalSymbols, 0-100, one decimal */
  percent: number;
  byKind: Record<string, { total: number; linked: number }>;
  /** freshness of the links that exist */
  links: { total: number; fresh: number; stale: number; broken: number };
}

// @spec: docs/design.md#coverage-metric
export function coverage(engine: DriftEngine, kinds: string[] = COVERABLE_KINDS): CoverageReport {
  const symbols = engine.symbols.listSymbols(kinds);
  const linkedIds = new Set(engine.store.allLinks().map((l) => l.symbolId));
  // ids drift across builtin-index rebuilds when lines shift; fall back to
  // qualified-name matching so coverage doesn't undercount
  const linkedNames = new Set(engine.store.allLinks().map((l) => l.symbolQualifiedName));

  const byKind: Record<string, { total: number; linked: number }> = {};
  let linkedSymbols = 0;
  for (const s of symbols) {
    const k = (byKind[s.kind] ??= { total: 0, linked: 0 });
    k.total++;
    if (linkedIds.has(s.id) || linkedNames.has(s.qualifiedName)) {
      k.linked++;
      linkedSymbols++;
    }
  }

  const links = { total: 0, fresh: 0, stale: 0, broken: 0 };
  for (const ev of engine.evaluateAll()) {
    links.total++;
    links[ev.status]++;
  }

  return {
    totalSymbols: symbols.length,
    linkedSymbols,
    percent: symbols.length === 0 ? 0 : Math.round((linkedSymbols / symbols.length) * 1000) / 10,
    byKind,
    links,
  };
}
