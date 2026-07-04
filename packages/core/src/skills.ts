import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Thin Claude Code skills installed by `drift init` (Q22: MCP server is the
 * single implementation; skills are discoverability wrappers that describe
 * when and how to call it).
 */
const SPEC_IMPLEMENT = `---
name: spec-implement
description: Implement or modify code that is (or should be) described by a spec in this repo's docs. Consults Drift before writing and links new work after.
---

# spec-implement

Workflow for implementing code against the spec graph:

1. **Before writing**: call \`drift_context <symbol-or-area>\` for every
   symbol you are about to touch. Read the returned spec section bodies —
   they are the current cached content; do not re-read the doc files.
   If \`inferred: true\`, the match came from an enclosing scope; treat it
   as guidance, not a contract.
2. **Implement** the change so it satisfies the returned spec text.
3. **After writing**: run \`drift_status\` scoped to the files you changed.
   - \`fresh\`: done.
   - \`stale\` where the code change was intentional and the spec still
     describes the behavior: approve via \`drift approve <link-id>\`.
   - \`stale\` where behavior diverged from spec: STOP and tell the user the
     spec and code now disagree; propose either a code fix or a spec edit.
4. **New symbols** implementing documented behavior: declare the link with
   a \`@spec: docs/<file>.md#<anchor>\` comment above the symbol (then
   \`drift sync\`), or \`drift link <symbol> <anchor>\`.
`;

const SPEC_STATUS = `---
name: spec-status
description: Judge whether code matches its spec — report fresh/stale/broken status of Drift links, verify a PR or working tree against the spec graph.
---

# spec-status

Workflow for judging spec/code consistency:

1. Run \`drift_status\` (all links) or \`drift status --diff\` (only links
   touched by currently changed files). Statuses are hash-computed:
   - **fresh** — neither side changed since last approval.
   - **stale** — code and/or spec text changed; content may have drifted.
   - **broken** — the symbol or the spec anchor no longer exists.
2. For each \`stale\` link, call \`drift_diff <link-id>\` to see which side
   moved and what the approved baseline was. Judge semantically whether the
   current code still satisfies the current spec text:
   - Still consistent → \`drift approve <link-id>\`.
   - Inconsistent → report exactly what diverged (symbol, anchor, and the
     conflicting sentences). Do not approve.
3. For each \`broken\` link, report whether the symbol or anchor vanished;
   suggest \`drift unlink <link-id>\` (deleted on purpose) or a rename fix.
4. Never mark anything consistent without reading both sides from the
   \`drift_diff\` output. Never re-approve a broken link.
`;

export function installSkills(repoRoot: string): string[] {
  const written: string[] = [];
  for (const [name, content] of [
    ["spec-implement", SPEC_IMPLEMENT],
    ["spec-status", SPEC_STATUS],
  ] as const) {
    const dir = join(repoRoot, ".claude", "skills", name);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "SKILL.md");
    writeFileSync(file, content);
    written.push(join(".claude", "skills", name, "SKILL.md"));
  }
  return written;
}
