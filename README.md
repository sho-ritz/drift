# Drift

[![npm](https://img.shields.io/npm/v/driftdocs)](https://www.npmjs.com/package/driftdocs)

Detect and maintain the correspondence between specs and code mechanically, instead of
relying on human process.

Drift replaces code⇄spec exploration — "full-text search that re-reads entire documents
on every query" — with indexed lookups over a precomputed graph, structurally reducing
the token usage of AI agents. All judgments are hash comparisons; zero LLM calls in
steady state.

## Layout

```
packages/core     judgment engine: anchor extraction, hashing, graph store, lookup (shared core)
packages/cli      driftdocs (npm) — the `drift` command
packages/mcp      MCP server: drift_context / drift_code / drift_status / drift_diff / drift_approve / drift_suggest
obsidian-plugin   for non-engineers: status panel with one-click approve + publish button (community plugin)
templates/        GitHub Actions PR bot / git hook
```

Drift runs as an extension of [CodeGraph](https://www.npmjs.com/package/@colbymchenry/codegraph).
Symbol analysis reuses the CodeGraph index (`.codegraph/codegraph.db`) read-only;
Drift itself stores only spec anchors, corresponds_to links, and the approval log in
`.drift/drift.db`.

## Data model

- **SpecAnchor** — a section derived automatically from a markdown heading
  (`docs/auth.md#token-refresh`). Section bodies are cached, so context queries never
  re-read documents. When a heading is ambiguous, override the slug explicitly with
  `<!-- drift-anchor: name -->`.
- **Link** — a many-to-many edge between a symbol and an anchor. Pins the hash of both
  sides at approval time (code is normalized to ignore formatting noise).
- **Status** — `fresh` (neither side changed) / `stale` (either side was edited) /
  `broken` (either side disappeared).

## Usage

```sh
npm i -D driftdocs    # installs bin name `drift`
                      # (without installing, use `npx driftdocs <cmd>`)
npx drift init        # choose agents (claude-code/codex/gemini-cli) and strategies
                      #   → idempotently appends an instruction block to CLAUDE.md etc., installs skills
npx drift index       # extract anchors from docs/
npx drift sync        # apply @spec: annotations + .drift/links.json
                      #   (scans tracked AND untracked non-ignored files)
npx drift suggest     # propose links by matching symbol names against spec text
npx drift status      # fresh/stale/broken for every link
npx drift context AuthService::refreshToken   # code → spec (with hierarchical fallback)
npx drift code docs/auth.md#login-flow        # spec → code
npx drift approve 3   # re-approve a stale link as "still correct"
npx drift mcp         # start the MCP server (stdio)
```

Links can be declared with a code-side annotation:

```ts
// @spec: docs/auth.md#login-flow
async login(user: string, password: string): Promise<string> {
```

The annotation binds to the nearest *linkable* symbol below it (function, class,
method, component, …). If it would bind to something else — a type alias or a
constant — or sits suspiciously far from its symbol, `drift sync` prints a warning
instead of silently creating a wrong link.

Links can also be declared in an external mapping file (`.drift/links.json`,
non-invasive):

```json
[{ "symbol": "AuthService::login", "spec": "docs/auth.md#login-flow" }]
```

### Bootstrapping an existing codebase

Hand-annotating a large codebase is the main adoption cost, so the `ai-suggested`
strategy generates candidates mechanically:

```sh
npx drift suggest             # list candidates with confidence + reason
npx drift suggest --min-high  # only code-span / heading matches
npx drift suggest --apply     # create all candidates (origin: ai-suggested)
```

Candidates come from deterministic lexical matching — a spec section mentioning
`` `refreshToken` `` in a code span, or a heading whose slug matches a symbol name —
so the pass is free (no LLM). Review the list (or let an agent review it via the
`drift_suggest` MCP tool), then apply.

## PR bot

Copy `templates/drift-pr-bot.yml` into `.github/workflows/` and each PR gets a comment
evaluating only the links touched by its changed files, flagging stale/broken ones
(without blocking the merge). No hosted server required.

## Obsidian plugin

The status panel shows, for the open note, every linked code symbol grouped by spec
section with fresh/stale/broken badges, one-click **Still correct** re-approval,
**Remove link** for broken links, and a **Publish** button (git add/commit/push).
The plugin shells out to the `drift` CLI, so all judgment logic stays in one place.
Configure the CLI command, commit message, and push behavior in the plugin settings.

## Design notes

Key decisions (the full design record lives in the design summary Artifact):

- Detection is hash comparison only; LLMs enter only at the human-confirmation step
- Lookup is an O(edge-degree) index read. When a symbol has no direct link, Drift
  climbs the containment chain and returns the result marked `inferred: true`
- Specs live in Obsidian (a git-managed `/docs`). The Publish button is the only
  commit trigger
- Unlinked symbols are linked incrementally from spots touched by PRs — plus
  `drift suggest` for the initial bulk pass — never a mandatory big-bang batch
- `.drift/config.json` is validated on every command: a `docsDir` pointing at the
  repo root (which would index node_modules) is rejected outright

## Development

```sh
npm install
npm run build     # all workspaces
npm test          # unit tests (packages/core)
```
