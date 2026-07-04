import { createHash } from "node:crypto";

/**
 * Hash code with formatting noise removed, so pure reformats don't flag
 * links as stale (Q4). v1 approximates AST normalization by stripping
 * comments and collapsing whitespace; a tree-sitter based normalizer can
 * replace this without changing stored-hash semantics (hashes are simply
 * recomputed on upgrade).
 */
export function normalizeCode(source: string): string {
  let s = source;
  // strip block comments, line comments, python-style comments
  s = s.replace(/\/\*[\s\S]*?\*\//g, "");
  s = s.replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  s = s.replace(/(^|\s)#[^\n]*/g, "$1");
  // collapse all whitespace runs
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** Normalize spec text: trailing whitespace and blank-line runs don't count as edits. */
export function normalizeSpecText(text: string): string {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function hashCode(source: string): string {
  return sha256(normalizeCode(source));
}

export function hashSpecText(text: string): string {
  return sha256(normalizeSpecText(text));
}
