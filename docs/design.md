# Drift Design Decisions

This document is Drift's own spec, maintained with Drift itself: each section
below is linked to the code that implements it via `@spec:` annotations, and
CI runs `drift check` so any edit to either side flags the link as stale.

## Hash-Based Staleness Detection

A link's status is computed purely by hash comparison — no LLM calls, no
full-text scans in steady state. At approval time both sides are pinned:
the normalized symbol source hash and the normalized anchor body hash.
Evaluation recomputes both and reports `fresh` (neither changed), `stale`
(either side edited since approval, with the changed side identified), or
`broken` (the symbol or anchor no longer exists). Formatting-only edits —
comments, indentation, blank lines — must not flag a link as stale, which
is why hashing operates on normalized content.

## Spec Anchors

Anchors are derived mechanically from markdown heading structure: every
heading opens a section that runs until the next heading of the same or
higher level, and its GitHub-style slug becomes the anchor id
(`docs/design.md#spec-anchors`). Section bodies are cached in the store so
context queries never re-read documents. Duplicate headings get `-1`, `-2`
suffixes; an explicit `<!-- drift-anchor: name -->` comment overrides the
derived slug; headings inside code fences are ignored.

## Annotation Strategy

`@spec:` comments in code declare links. An annotation binds to the nearest
*linkable* symbol (function, class, method, component, …) starting within
five lines below it — an interposed type alias or constant must not steal
the link. Bindings to non-linkable kinds, bindings further than five lines
away, and annotations in files the symbol index doesn't cover all produce
warnings instead of silently creating wrong links. Scanning covers tracked
AND untracked non-ignored files, so a brand-new file's annotations are
picked up before its first commit.

## Suggested Links

The ai-suggested strategy proposes links by deterministic lexical matching
— no LLM in the candidate pass. A code-span mention of the symbol name in
the anchor body or a heading slug equal to the symbol name ranks high;
a bare-word body mention of a sufficiently distinctive name (5+ chars)
ranks medium. Already-linked pairs are never re-suggested. Judgment enters
at review time: a human or agent inspects the candidates and applies them,
keeping bootstrap cost on an existing codebase low.

## Hierarchical Context Fallback

Code→spec lookup walks corresponds_to edges. When a symbol has no direct
link, Drift climbs the containment chain — method → class → file — and
returns the first ancestor's links marked `inferred: true`, so callers can
treat inherited context as guidance rather than contract. Lookup cost is
O(edge degree); documents are never scanned.

## Approval Workflow

Approving a link re-pins both current hashes and appends to an append-only
audit log (who, what, when). Approving a broken link is refused — a link
whose symbol or anchor vanished must be relinked or removed, never blindly
re-pinned.

## Rename Tracking

A pure rename must not strand a link as permanently broken. When a linked
symbol vanishes, Drift searches for a symbol whose current source hashes to
the link's approved hash — either verbatim (file move) or after
substituting the candidate's name back to the old name (rename, which also
covers self-references like recursion). Candidates from the same file are
preferred; the repo-wide pass is capped so status calls stay fast. Matches
are surfaced as `movedTo` hints and repaired explicitly with `drift relink`,
which re-points the symbol side while keeping the anchor pin and origin.

## Semantic Verification

`drift verify` closes the detection→resolution loop: hash comparison says
"something changed"; verification asks an LLM whether the current code
still satisfies the current spec text. It runs ONLY against stale links, so
steady-state cost remains zero and spend scales with the size of the
change. Verdicts are `consistent` (safe to re-approve), `diverged` (must
quote the contradicted spec sentence verbatim), or `uncertain` (needs a
human) — the model is never forced into a binary call, and nothing is
auto-approved unless explicitly requested.

## Coverage Metric

`drift coverage` reports the fraction of coverable symbols (functions,
classes, methods, …) that have at least one spec link, broken down by kind,
plus the freshness of existing links. The number exists to make progress
visible and to compare areas of the codebase — 100% is explicitly not the
goal, and the tool says so in its own output.

## Built-In Symbol Index

Drift's engine talks to a backend-neutral SymbolIndex interface. The
CodeGraph backend reuses an existing `.codegraph/codegraph.db` read-only;
the builtin backend parses the working tree with tree-sitter WASM grammars
(TypeScript, JavaScript, Python, Go, Rust, Java, Ruby) and needs no
external tooling. When a config still names CodeGraph but no index exists,
commands fall back to the builtin backend with a notice instead of failing.
The builtin backend also upgrades hash normalization from regex
approximation to AST-accurate comment stripping.

## Configuration Validation

Every command validates `.drift/config.json` before touching data. A
`docsDir` pointing at the repository root is rejected outright — indexing
would sweep node_modules and vendored markdown into the anchor index (651
false files in one field incident). Absolute or root-escaping paths are
errors; unknown strategies, agents, or backends warn.
