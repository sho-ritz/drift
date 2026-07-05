import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CodeGraphReader,
  DriftEngine,
  DriftStore,
  driftDbPath,
  loadConfig,
  normalizeCode,
  hashCode,
  suggestLinks,
} from "@driftdocs/core";
import { join } from "node:path";
import { z } from "zod";

function openEngine(repoRoot: string): DriftEngine {
  const config = loadConfig(repoRoot);
  return new DriftEngine(
    new CodeGraphReader(join(repoRoot, config.codegraphDb), repoRoot),
    new DriftStore(driftDbPath(repoRoot)),
    repoRoot,
  );
}

function text(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/**
 * Single MCP server for every agent CLI (Q22). Responses follow the
 * graduated-disclosure design (Q9): drift_context / drift_status are
 * minimal; drift_diff carries the detail and is meant to be called only
 * for stale links.
 */
export async function serve(repoRoot: string): Promise<void> {
  const engine = openEngine(repoRoot);
  const server = new McpServer({ name: "drift", version: "0.1.0" });

  server.registerTool(
    "drift_context",
    {
      description:
        "Spec sections corresponding to a code symbol (code → spec). Returns cached section bodies plus a fresh/stale/broken flag per link — one indexed lookup, no document scanning. Use BEFORE reading or grepping spec files. `inferred: true` means the links were found on an enclosing scope (class/file), not the symbol itself.",
      inputSchema: {
        symbol: z.string().describe("function/class name or qualified name"),
      },
    },
    async ({ symbol }) => {
      const ctx = engine.specContext(symbol);
      if (!ctx) return text({ error: `symbol not found in CodeGraph: ${symbol}` });
      return text(ctx);
    },
  );

  server.registerTool(
    "drift_code",
    {
      description:
        "Code symbols implementing a spec section (spec → code). Input a spec anchor id like 'docs/auth.md#token-refresh', or just 'docs/auth.md' for every anchor in the file.",
      inputSchema: {
        anchor: z.string().describe("docs/<file>.md[#<anchor-slug>]"),
      },
    },
    async ({ anchor }) => text(engine.codeForSpec(anchor)),
  );

  server.registerTool(
    "drift_status",
    {
      description:
        "Hash-computed consistency status of spec links: fresh (unchanged), stale (either side edited since last approval), broken (symbol or anchor gone). Optionally scope to specific files. Cheap — call freely after edits.",
      inputSchema: {
        files: z
          .array(z.string())
          .optional()
          .describe("repo-relative changed files to scope to; omit for all links"),
      },
    },
    async ({ files }) => {
      const evals = files?.length
        ? engine.evaluateForChangedFiles(files)
        : engine.evaluateAll();
      return text(
        evals.map((ev) => ({
          linkId: ev.link.id,
          status: ev.status,
          symbol: ev.link.symbolQualifiedName,
          anchor: ev.link.anchorId,
          drift: ev.status === "stale" ? ev.drift : undefined,
          missing: ev.status === "broken" ? ev.missing : undefined,
        })),
      );
    },
  );

  server.registerTool(
    "drift_diff",
    {
      description:
        "Detail view for ONE link (call only when drift_status reports stale/broken): current symbol source, current spec body, which sides changed since the approved baseline, and approval metadata.",
      inputSchema: {
        linkId: z.number().describe("link id from drift_status"),
      },
    },
    async ({ linkId }) => {
      const link = engine.store.getLink(linkId);
      if (!link) return text({ error: `link not found: ${linkId}` });
      const ev = engine.evaluateLink(link);
      const symbol =
        engine.codegraph.getSymbolById(link.symbolId) ??
        engine.codegraph.findSymbol(link.symbolQualifiedName);
      const source = symbol ? engine.codegraph.readSymbolSource(symbol) : null;
      const anchor = engine.store.getAnchor(link.anchorId);
      return text({
        linkId,
        status: ev.status,
        drift: ev.drift,
        missing: ev.missing,
        approvedAt: link.approvedAt,
        approvedBy: link.approvedBy,
        symbol: link.symbolQualifiedName,
        symbolSource: source,
        symbolHashMatches: source !== null && hashCode(source) === link.approvedSymbolHash,
        anchor: link.anchorId,
        anchorBody: anchor?.body ?? null,
        normalizedSymbolPreview: source ? normalizeCode(source).slice(0, 400) : null,
      });
    },
  );

  server.registerTool(
    "drift_approve",
    {
      description:
        "Re-pin a stale link as still-correct (one-click approve). Only call after semantically verifying via drift_diff that code and spec still agree, or when the user confirms.",
      inputSchema: {
        linkId: z.number(),
        actor: z.string().optional().describe("who approved (defaults to 'mcp')"),
      },
    },
    async ({ linkId, actor }) => {
      const ev = engine.approve(linkId, actor ?? "mcp");
      return text({ linkId, status: ev.status });
    },
  );

  server.registerTool(
    "drift_suggest",
    {
      description:
        "Candidate spec↔code links found by deterministic lexical matching (symbol names vs anchor headings/bodies). Use to bootstrap links on an existing codebase. Review each candidate — read the spec section and the symbol — then create the ones that hold with drift_link semantics via CLI 'drift link', or approve in bulk with 'drift suggest --apply'.",
      inputSchema: {
        minConfidence: z
          .enum(["high", "medium"])
          .optional()
          .describe("filter: 'high' returns only code-span/heading matches"),
      },
    },
    async ({ minConfidence }) =>
      text(suggestLinks(engine, { minConfidence: minConfidence === "high" ? "high" : undefined })),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
