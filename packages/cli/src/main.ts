import {
  CodeGraphReader,
  DriftEngine,
  DriftStore,
  DEFAULT_CONFIG,
  driftDbPath,
  installSkills,
  loadConfig,
  loadMappingFile,
  saveConfig,
  scanAnnotations,
  syncDeclarations,
  writeAgentInstructions,
  type AgentKind,
  type LinkEvaluation,
} from "@driftdocs/core";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";

function repoRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}

function openEngine(root: string): DriftEngine {
  const config = loadConfig(root);
  const cgPath = join(root, config.codegraphDb);
  if (!existsSync(cgPath)) {
    fail(`CodeGraph index not found at ${config.codegraphDb}. Run: codegraph init`);
  }
  return new DriftEngine(
    new CodeGraphReader(cgPath, root),
    new DriftStore(driftDbPath(root)),
    root,
  );
}

function fail(msg: string): never {
  console.error(`drift: ${msg}`);
  process.exit(1);
}

function* walkMarkdown(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory() && !e.name.startsWith(".")) yield* walkMarkdown(p);
    else if (e.isFile() && e.name.endsWith(".md")) yield p;
  }
}

function changedFiles(root: string, base?: string): string[] {
  const range = base ? `${base}...HEAD` : "HEAD";
  const tracked = execSync(`git diff --name-only ${range}`, {
    cwd: root,
    encoding: "utf8",
  });
  const unstaged = base
    ? ""
    : execSync("git diff --name-only", { cwd: root, encoding: "utf8" });
  return [...new Set([...tracked.split("\n"), ...unstaged.split("\n")])].filter(Boolean);
}

const STATUS_ICON: Record<string, string> = { fresh: "✓", stale: "△", broken: "✗" };

function printEvaluations(evals: LinkEvaluation[]): void {
  if (evals.length === 0) {
    console.log("no links to evaluate");
    return;
  }
  for (const ev of evals) {
    const which =
      ev.status === "stale"
        ? ` (${[ev.drift.symbol && "code", ev.drift.anchor && "spec"].filter(Boolean).join("+")} changed)`
        : ev.status === "broken"
          ? ` (${ev.missing.symbol ? "symbol" : "anchor"} missing)`
          : "";
    console.log(
      `${STATUS_ICON[ev.status]} [${ev.link.id}] ${ev.status.toUpperCase()}${which}  ` +
        `${ev.link.symbolQualifiedName} ↔ ${ev.link.anchorId}`,
    );
  }
  const c = { fresh: 0, stale: 0, broken: 0 };
  for (const ev of evals) c[ev.status]++;
  console.log(`\n${c.fresh} fresh, ${c.stale} stale, ${c.broken} broken / ${evals.length} links`);
}

// ---------------------------------------------------------------------------

async function cmdInit(root: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const config = { ...DEFAULT_CONFIG };

  const docs = await rl.question(`Docs directory [${config.docsDir}]: `);
  if (docs.trim()) config.docsDir = docs.trim();

  console.log("\nLink acquisition strategies (comma-separated numbers, empty = all):");
  console.log("  1. annotation   — @spec: comments in code");
  console.log("  2. mapping      — standalone .drift/links.json (non-invasive)");
  console.log("  3. ai-suggested — on-touch AI proposals via PR bot / skills");
  const strat = (await rl.question("Enable [1,2,3]: ")).trim();
  if (strat) {
    const all = ["annotation", "mapping", "ai-suggested"] as const;
    config.strategies = strat
      .split(",")
      .map((s) => all[parseInt(s.trim(), 10) - 1])
      .filter(Boolean);
  }

  console.log("\nAI agents to configure (comma-separated numbers):");
  console.log("  1. claude-code  → CLAUDE.md + .claude/skills");
  console.log("  2. codex        → AGENTS.md");
  console.log("  3. gemini-cli   → GEMINI.md");
  const ag = (await rl.question("Configure [1]: ")).trim() || "1";
  const agentsAll: AgentKind[] = ["claude-code", "codex", "gemini-cli"];
  config.agents = ag
    .split(",")
    .map((s) => agentsAll[parseInt(s.trim(), 10) - 1])
    .filter(Boolean);
  rl.close();

  saveConfig(root, config);
  console.log(`\nwrote .drift/config.json`);

  for (const r of writeAgentInstructions(root, config.agents)) {
    console.log(`${r.action} ${r.file} (drift instruction block)`);
  }
  if (config.agents.includes("claude-code")) {
    for (const f of installSkills(root)) console.log(`installed ${f}`);
  }
  console.log("\nNext: drift index && drift sync");
}

function cmdIndex(root: string): void {
  const config = loadConfig(root);
  const engine = openEngine(root);
  const docsAbs = join(root, config.docsDir);
  if (!existsSync(docsAbs)) fail(`docs directory not found: ${config.docsDir}`);
  let files = 0;
  let anchors = 0;
  for (const abs of walkMarkdown(docsAbs)) {
    const rel = relative(root, abs);
    anchors += engine.indexSpecFile(rel);
    files++;
  }
  console.log(`indexed ${anchors} anchors from ${files} spec files under ${config.docsDir}/`);
}

function cmdSync(root: string): void {
  const config = loadConfig(root);
  const engine = openEngine(root);
  const decls = [];
  if (config.strategies.includes("annotation")) {
    const codeFiles = execSync("git ls-files", { cwd: root, encoding: "utf8" })
      .split("\n")
      .filter((f) => f && !f.endsWith(".md") && !f.startsWith(config.docsDir + "/"));
    decls.push(...scanAnnotations(engine, codeFiles));
  }
  if (config.strategies.includes("mapping")) {
    decls.push(...loadMappingFile(root));
  }
  const r = syncDeclarations(engine, decls);
  console.log(`sync: ${r.created} created, ${r.kept} kept`);
  for (const e of r.errors) console.error(`  ! ${e}`);
  if (r.errors.length > 0) process.exit(1);
}

function cmdStatus(root: string, args: string[]): void {
  const engine = openEngine(root);
  const diffIdx = args.indexOf("--diff");
  if (diffIdx !== -1) {
    const base = args[diffIdx + 1]?.startsWith("--") ? undefined : args[diffIdx + 1];
    printEvaluations(engine.evaluateForChangedFiles(changedFiles(root, base)));
  } else {
    printEvaluations(engine.evaluateAll());
  }
}

function cmdContext(root: string, symbol: string | undefined, json: boolean): void {
  if (!symbol) fail("usage: drift context <symbol>");
  const engine = openEngine(root);
  const ctx = engine.specContext(symbol);
  if (!ctx) fail(`symbol not found in CodeGraph: ${symbol}`);
  if (json) {
    console.log(JSON.stringify(ctx, null, 2));
    return;
  }
  if (ctx.entries.length === 0) {
    console.log(`${ctx.symbol}: no spec links (direct or inherited)`);
    return;
  }
  console.log(
    `${ctx.symbol}${ctx.inferred ? ` (inferred from ${ctx.resolvedSymbol})` : ""} — ` +
      `${ctx.freshness.fresh}/${ctx.freshness.total} fresh\n`,
  );
  for (const e of ctx.entries) {
    console.log(`--- ${STATUS_ICON[e.status]} ${e.anchorId} [${e.status}]`);
    console.log(e.body + "\n");
  }
}

function cmdCode(root: string, anchor: string | undefined): void {
  if (!anchor) fail("usage: drift code <docs/file.md[#anchor]>");
  const engine = openEngine(root);
  const rows = engine.codeForSpec(anchor);
  if (rows.length === 0) {
    console.log(`no code linked to ${anchor}`);
    return;
  }
  for (const r of rows) {
    console.log(`${STATUS_ICON[r.status]} ${r.symbol}  (${r.filePath})  ← ${r.anchorId}`);
  }
}

function cmdLink(root: string, symbol?: string, anchor?: string): void {
  if (!symbol || !anchor) fail("usage: drift link <symbol> <docs/file.md#anchor>");
  const engine = openEngine(root);
  const link = engine.link(symbol, anchor, "mapping", process.env.USER);
  console.log(`linked [${link.id}] ${link.symbolQualifiedName} ↔ ${link.anchorId}`);
}

function cmdApprove(root: string, id?: string): void {
  if (!id) fail("usage: drift approve <link-id>");
  const engine = openEngine(root);
  const ev = engine.approve(parseInt(id, 10), process.env.USER);
  console.log(`approved [${ev.link.id}] → ${ev.status}`);
}

function cmdUnlink(root: string, id?: string): void {
  if (!id) fail("usage: drift unlink <link-id>");
  const engine = openEngine(root);
  engine.store.removeLink(parseInt(id, 10), process.env.USER);
  console.log(`removed link ${id}`);
}

function cmdPrComment(root: string, args: string[]): void {
  // Emits a markdown comment body for the GitHub Actions bot (Q24).
  const baseIdx = args.indexOf("--base");
  const base = baseIdx !== -1 ? args[baseIdx + 1] : "origin/main";
  const engine = openEngine(root);
  const evals = engine.evaluateForChangedFiles(changedFiles(root, base));
  const flagged = evals.filter((e) => e.status !== "fresh");
  if (flagged.length === 0) {
    console.log("<!-- drift:pr-comment -->\n✓ **Drift**: all spec links touched by this PR are fresh.");
    return;
  }
  const lines = [
    "<!-- drift:pr-comment -->",
    `△ **Drift**: ${flagged.length} spec link(s) affected by this PR need review.`,
    "",
    "| | link | symbol | spec | action |",
    "|---|---|---|---|---|",
  ];
  for (const ev of flagged) {
    const action =
      ev.status === "stale"
        ? `still consistent? → \`drift approve ${ev.link.id}\``
        : `target missing → \`drift unlink ${ev.link.id}\` or fix rename`;
    lines.push(
      `| ${ev.status === "stale" ? "△" : "✗"} ${ev.status} | ${ev.link.id} | \`${ev.link.symbolQualifiedName}\` | \`${ev.link.anchorId}\` | ${action} |`,
    );
  }
  console.log(lines.join("\n"));
  process.exitCode = 78; // signal "flags present" to the workflow without failing the build
}

// ---------------------------------------------------------------------------

const [, , cmd, ...rest] = process.argv;
const root = repoRoot();

switch (cmd) {
  case "init":
    await cmdInit(root);
    break;
  case "index":
    cmdIndex(root);
    break;
  case "sync":
    cmdSync(root);
    break;
  case "check":
    cmdIndex(root);
    cmdSync(root);
    cmdStatus(root, rest);
    break;
  case "status":
    cmdStatus(root, rest);
    break;
  case "context":
    cmdContext(root, rest.filter((a) => a !== "--json")[0], rest.includes("--json"));
    break;
  case "code":
    cmdCode(root, rest[0]);
    break;
  case "link":
    cmdLink(root, rest[0], rest[1]);
    break;
  case "approve":
    cmdApprove(root, rest[0]);
    break;
  case "unlink":
    cmdUnlink(root, rest[0]);
    break;
  case "pr-comment":
    cmdPrComment(root, rest);
    break;
  case "mcp":
    await (await import("@driftdocs/mcp")).serve(root);
    break;
  default:
    console.log(`drift — spec/code correspondence, cheaply

usage:
  drift init                     interactive setup (agents, strategies, docs dir)
  drift index                    extract spec anchors from docs into .drift/drift.db
  drift sync                     apply @spec: annotations + .drift/links.json
  drift check                    index + sync + status (git-hook entry point)
  drift status [--diff [base]]   fresh/stale/broken for all or changed-file links
  drift context <symbol> [--json]  spec sections for a symbol (code → spec)
  drift code <file.md[#anchor]>  symbols implementing a spec section (spec → code)
  drift link <symbol> <anchor>   create a link, pinned at current hashes
  drift approve <link-id>        re-pin a stale link as still-correct
  drift unlink <link-id>         remove a broken/obsolete link
  drift pr-comment [--base ref]  emit PR comment markdown (GitHub Actions bot)
  drift mcp                      run the MCP server (stdio)`);
    if (cmd) process.exit(1);
}
