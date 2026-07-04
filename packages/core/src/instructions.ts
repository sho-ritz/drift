import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { AGENT_INSTRUCTION_FILES, type AgentKind } from "./types.js";

const BEGIN = "<!-- drift:instructions v1 -->";
const END = "<!-- /drift:instructions -->";

/**
 * Instruction block appended to CLAUDE.md / AGENTS.md / GEMINI.md (Q23).
 * Idempotent: re-running init or upgrading Drift replaces only the content
 * between the markers, never the user's own text.
 */
export const INSTRUCTION_BLOCK = `${BEGIN}
## Drift — spec/code correspondence

This repo uses Drift: a pre-built graph linking code symbols to spec
sections. BEFORE grepping docs or reading spec files to understand code,
query Drift — it answers in one indexed lookup instead of a document scan.

- "What spec describes this function/class?" → \`drift_context <symbol>\`
  (MCP tool, or CLI: \`drift context <symbol>\`)
- "What code implements this spec section?" → \`drift_code <docs/file.md#anchor>\`
- "Is this code still consistent with its spec?" → \`drift_status\` — returns
  fresh / stale / broken flags computed by hash comparison; only read full
  diffs (\`drift_diff\`) when a link is stale.
- After implementing or changing a linked symbol, run \`drift status\` and,
  if intentional, re-approve with \`drift approve <link-id>\`.
- When you add new behavior described in the docs, declare the link with a
  \`@spec: docs/<file>.md#<anchor>\` comment above the symbol, or
  \`drift link <symbol> <anchor>\`.

Do not re-verify Drift results by re-reading whole spec documents; the
cached section body returned by \`drift_context\` is the current content.
${END}`;

export function writeAgentInstructions(
  repoRoot: string,
  agents: AgentKind[],
): Array<{ file: string; action: "created" | "updated" | "appended" }> {
  const results: Array<{ file: string; action: "created" | "updated" | "appended" }> = [];
  for (const agent of agents) {
    const file = AGENT_INSTRUCTION_FILES[agent];
    const abs = join(repoRoot, file);
    if (!existsSync(abs)) {
      writeFileSync(abs, INSTRUCTION_BLOCK + "\n");
      results.push({ file, action: "created" });
      continue;
    }
    const current = readFileSync(abs, "utf8");
    const begin = current.indexOf(BEGIN);
    const end = current.indexOf(END);
    if (begin !== -1 && end !== -1) {
      const next =
        current.slice(0, begin) + INSTRUCTION_BLOCK + current.slice(end + END.length);
      if (next !== current) {
        writeFileSync(abs, next);
        results.push({ file, action: "updated" });
      }
    } else {
      writeFileSync(abs, current.replace(/\n*$/, "\n\n") + INSTRUCTION_BLOCK + "\n");
      results.push({ file, action: "appended" });
    }
  }
  return results;
}
