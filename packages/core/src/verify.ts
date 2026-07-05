import Anthropic from "@anthropic-ai/sdk";
import type { DriftEngine } from "./engine.js";
import type { LinkEvaluation } from "./types.js";

/**
 * drift verify: close the detection→resolution loop. Hash comparison can
 * only say "something changed"; this asks Claude whether a STALE link's
 * code and spec still agree semantically. Called only for stale links, so
 * the steady-state cost stays zero (the design's core constraint) and spend
 * scales with the size of the change, not the repo.
 */

export type Verdict = "consistent" | "diverged" | "uncertain";

export interface VerifyResult {
  linkId: number;
  symbol: string;
  anchorId: string;
  verdict: Verdict;
  reasoning: string;
  /** verbatim quote of the spec sentence the code now contradicts (diverged only) */
  conflictingStatement: string | null;
}

export const DEFAULT_VERIFY_MODEL = "claude-opus-4-8";

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: {
      type: "string",
      enum: ["consistent", "diverged", "uncertain"],
      description:
        "consistent: the code still does what the spec section describes. " +
        "diverged: the code now contradicts the spec text. " +
        "uncertain: cannot judge from the given context alone.",
    },
    reasoning: {
      type: "string",
      description: "1-3 sentences explaining the judgment",
    },
    conflicting_statement: {
      type: ["string", "null"],
      description:
        "verbatim quote of the specific spec sentence the code contradicts; null unless verdict is diverged",
    },
  },
  required: ["verdict", "reasoning", "conflicting_statement"],
  additionalProperties: false,
} as const;

function buildPrompt(symbolName: string, source: string, anchorId: string, specBody: string): string {
  return `A code symbol and the spec section documenting it were linked and approved as consistent. One or both sides have since been edited. Judge whether the CURRENT code still satisfies the CURRENT spec text.

Rules:
- Judge only what the spec text actually claims. Do not penalize the code for behavior the spec doesn't mention.
- Formatting, comments, naming style, and internal refactors that preserve behavior are consistent.
- If the spec describes behavior the code no longer has, or the code's observable behavior contradicts a spec sentence, that is diverged — quote the contradicted sentence verbatim.
- If judgment would require code or context not shown here, answer uncertain.

<spec anchor="${anchorId}">
${specBody}
</spec>

<code symbol="${symbolName}">
${source}
</code>`;
}

/** Missing-credentials guard so callers can print a friendly hint. */
export class VerifyAuthError extends Error {}

// @spec: docs/design.md#semantic-verification
export async function verifyLinks(
  engine: DriftEngine,
  evaluations: LinkEvaluation[],
  opts: { model?: string; concurrency?: number } = {},
): Promise<VerifyResult[]> {
  const stale = evaluations.filter((e) => e.status === "stale");
  if (stale.length === 0) return [];

  const client = new Anthropic();
  const model = opts.model ?? DEFAULT_VERIFY_MODEL;

  const verifyOne = async (ev: LinkEvaluation): Promise<VerifyResult> => {
    const link = ev.link;
    const symbol =
      engine.symbols.getSymbolById(link.symbolId) ??
      engine.symbols.findSymbol(link.symbolQualifiedName);
    const source = symbol ? engine.symbols.readSymbolSource(symbol) : null;
    const anchor = engine.store.getAnchor(link.anchorId);
    if (!source || !anchor) {
      return {
        linkId: link.id,
        symbol: link.symbolQualifiedName,
        anchorId: link.anchorId,
        verdict: "uncertain",
        reasoning: "could not read current code or spec content",
        conflictingStatement: null,
      };
    }

    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: VERDICT_SCHEMA } },
      messages: [
        {
          role: "user",
          content: buildPrompt(link.symbolQualifiedName, source, link.anchorId, anchor.body),
        },
      ],
    });

    if (response.stop_reason === "refusal") {
      return {
        linkId: link.id,
        symbol: link.symbolQualifiedName,
        anchorId: link.anchorId,
        verdict: "uncertain",
        reasoning: "model declined to evaluate this content",
        conflictingStatement: null,
      };
    }

    const textBlock = response.content.find((b) => b.type === "text");
    const parsed = JSON.parse(textBlock && "text" in textBlock ? textBlock.text : "{}") as {
      verdict?: Verdict;
      reasoning?: string;
      conflicting_statement?: string | null;
    };
    return {
      linkId: link.id,
      symbol: link.symbolQualifiedName,
      anchorId: link.anchorId,
      verdict: parsed.verdict ?? "uncertain",
      reasoning: parsed.reasoning ?? "(no reasoning returned)",
      conflictingStatement: parsed.conflicting_statement ?? null,
    };
  };

  // bounded parallelism; typical PRs have a handful of stale links
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 4, stale.length));
  const results: VerifyResult[] = [];
  const queue = [...stale];
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const ev = queue.shift();
      if (!ev) return;
      try {
        results.push(await verifyOne(ev));
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) {
          throw new VerifyAuthError(
            "no usable Anthropic credentials. Set ANTHROPIC_API_KEY (or run `ant auth login`), " +
              "then re-run drift verify. Until then, review stale links manually via drift_diff.",
          );
        }
        throw e;
      }
    }
  });
  await Promise.all(workers);
  return results.sort((a, b) => a.linkId - b.linkId);
}
