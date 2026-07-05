import { hashSpecText } from "./hash.js";
import type { SpecAnchor } from "./types.js";

/**
 * GitHub-compatible heading slugification (Q10: anchors are derived from
 * heading structure, no authoring cost on the spec side).
 */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
// RegExp-constructor form on purpose: a regex literal starting with `<!--`
// trips tree-sitter's legacy html-comment lexing and corrupts the parse of
// this very file (found by dogfooding drift on itself).
const EXPLICIT_ANCHOR_RE = new RegExp("<!--\\s*drift-anchor:\\s*([\\w-]+)\\s*-->");

/**
 * Extract spec anchors from one markdown document.
 *
 * Each heading opens a section that runs until the next heading of the
 * same-or-higher level. An explicit `<!-- drift-anchor: name -->` comment
 * immediately above a heading overrides the derived slug (Q10 fallback for
 * duplicate/ambiguous headings).
 */
// @spec: docs/design.md#spec-anchors
export function extractAnchors(filePath: string, markdown: string): SpecAnchor[] {
  const lines = markdown.split("\n");
  interface Open {
    slug: string;
    heading: string;
    level: number;
    startLine: number; // 1-indexed, heading line
  }
  const anchors: SpecAnchor[] = [];
  const stack: Open[] = [];
  const seen = new Map<string, number>();
  let pendingExplicit: string | null = null;
  let inFence = false;

  const close = (open: Open, endLine: number) => {
    const body = lines.slice(open.startLine - 1, endLine).join("\n");
    anchors.push({
      id: `${filePath}#${open.slug}`,
      filePath,
      slug: open.slug,
      heading: open.heading,
      headingLevel: open.level,
      startLine: open.startLine,
      endLine,
      body,
      bodyHash: hashSpecText(body),
    });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (inFence) continue;

    const explicit = line.match(EXPLICIT_ANCHOR_RE);
    if (explicit) {
      pendingExplicit = explicit[1];
      continue;
    }

    const m = line.match(HEADING_RE);
    if (!m) {
      // the override only applies IMMEDIATELY above a heading; any other
      // content in between (e.g. prose mentioning the comment syntax)
      // cancels it instead of hijacking the next heading's slug
      if (line.trim() !== "") pendingExplicit = null;
      continue;
    }
    const level = m[1].length;
    const heading = m[2];

    // close every open section at same-or-deeper level
    while (stack.length && stack[stack.length - 1].level >= level) {
      close(stack.pop()!, i);
    }

    let slug = pendingExplicit ?? slugify(heading);
    pendingExplicit = null;
    // de-duplicate repeated headings the way GitHub does: -1, -2, ...
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    if (n > 0) slug = `${slug}-${n}`;

    stack.push({ slug, heading, level, startLine: i + 1 });
  }
  while (stack.length) close(stack.pop()!, lines.length);

  anchors.sort((a, b) => a.startLine - b.startLine);
  return anchors;
}
