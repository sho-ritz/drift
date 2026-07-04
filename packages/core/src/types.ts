/** Status of a single link between a code symbol and a spec anchor. */
export type LinkStatus = "fresh" | "stale" | "broken";

/** How a link came to exist. Pluggable strategies chosen at `drift init`. */
export type LinkOrigin = "annotation" | "mapping" | "ai-suggested";

/** A code symbol as known to CodeGraph (read-only view). */
export interface Symbol {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string | null;
}

/** A spec anchor: one heading section inside a markdown document. */
export interface SpecAnchor {
  /** e.g. "docs/auth.md#token-refresh" */
  id: string;
  filePath: string;
  /** slugified heading */
  slug: string;
  heading: string;
  headingLevel: number;
  startLine: number;
  endLine: number;
  /** section body text (cached for zero-cost context queries) */
  body: string;
  /** sha256 of normalized body */
  bodyHash: string;
}

/** A corresponds_to edge between a symbol and a spec anchor. Many-to-many. */
export interface Link {
  id: number;
  symbolId: string;
  symbolQualifiedName: string;
  symbolFilePath: string;
  anchorId: string;
  origin: LinkOrigin;
  /** sha256 of normalized symbol source at last approval */
  approvedSymbolHash: string;
  /** sha256 of normalized anchor body at last approval */
  approvedAnchorHash: string;
  approvedAt: number;
  approvedBy: string | null;
  createdAt: number;
}

/** Result of evaluating one link's current status. */
export interface LinkEvaluation {
  link: Link;
  status: LinkStatus;
  /** which side drifted (only for stale) */
  drift: { symbol: boolean; anchor: boolean };
  /** which side disappeared (only for broken) */
  missing: { symbol: boolean; anchor: boolean };
}

/**
 * Minimal context response (Q9: minimal by default).
 * `inferred` marks hierarchical-fallback results (Q21).
 */
export interface SpecContext {
  symbol: string;
  /** true when resolved via containment fallback (method -> class -> file) */
  inferred: boolean;
  /** symbol the links were actually found on (differs when inferred) */
  resolvedSymbol: string;
  entries: Array<{
    anchorId: string;
    heading: string;
    body: string;
    status: LinkStatus;
  }>;
  /** "3/4 fresh" style partial freshness (Q11) */
  freshness: { fresh: number; total: number };
}

export interface DriftConfig {
  /** repo-relative path to the docs vault (Q16) */
  docsDir: string;
  /** enabled link-acquisition strategies (Q3) */
  strategies: LinkOrigin[];
  /** agents whose instruction files drift manages (Q23) */
  agents: AgentKind[];
  /** path to CodeGraph db, relative to repo root */
  codegraphDb: string;
}

export type AgentKind = "claude-code" | "codex" | "gemini-cli";

export const AGENT_INSTRUCTION_FILES: Record<AgentKind, string> = {
  "claude-code": "CLAUDE.md",
  codex: "AGENTS.md",
  "gemini-cli": "GEMINI.md",
};
