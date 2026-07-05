import {
  CodeGraphReader,
  DriftEngine,
  DriftStore,
  DEFAULT_CONFIG,
  SUPPORTED_EXTENSIONS,
  TreeSitterIndex,
  VerifyAuthError,
  applySuggestions,
  coverage,
  driftDbPath,
  installSkills,
  loadConfig,
  loadMappingFile,
  saveConfig,
  scanAnnotations,
  suggestLinks,
  syncDeclarations,
  validateConfig,
  verifyLinks,
  writeAgentInstructions,
  type AgentKind,
  type DriftConfig,
  type LinkEvaluation,
  type SymbolIndex,
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

/** Load config and enforce validation: warnings print, errors abort. */
function loadCheckedConfig(root: string): DriftConfig {
  let config: DriftConfig;
  try {
    config = loadConfig(root);
  } catch (e) {
    fail((e as Error).message);
  }
  const issues = validateConfig(root, config);
  for (const i of issues.filter((i) => i.severity === "warning")) {
    console.error(`drift: warning: ${i.field}: ${i.message}`);
  }
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    for (const i of errors) console.error(`drift: error: ${i.field}: ${i.message}`);
    fail("invalid .drift/config.json — fix the errors above");
  }
  return config;
}

/** All tracked + untracked non-ignored files (the working-tree view). */
function workingTreeFiles(root: string): string[] {
  return execSync("git ls-files --cached --others --exclude-standard", {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

/**
 * Pick the symbol index per config: "codegraph" reads the CodeGraph SQLite
 * index; "builtin" parses the working tree with drift's own tree-sitter
 * indexer. When the config still says codegraph but no index exists, fall
 * back to builtin with a notice instead of failing.
 */
async function openSymbolIndex(root: string, config: DriftConfig): Promise<SymbolIndex> {
  const cgPath = join(root, config.codegraphDb);
  let backend = config.backend ?? "codegraph";
  if (backend === "codegraph" && !existsSync(cgPath)) {
    console.error(
      `drift: CodeGraph index not found at ${config.codegraphDb}; using the built-in ` +
        `tree-sitter indexer (set "backend": "builtin" in .drift/config.json to silence this)`,
    );
    backend = "builtin";
  }
  if (backend === "codegraph") {
    return new CodeGraphReader(cgPath, root);
  }
  const files = workingTreeFiles(root).filter((f) =>
    SUPPORTED_EXTENSIONS.some((ext) => f.endsWith(ext)),
  );
  return TreeSitterIndex.create(root, files);
}

async function openEngine(root: string, config = loadCheckedConfig(root)): Promise<DriftEngine> {
  return new DriftEngine(
    await openSymbolIndex(root, config),
    new DriftStore(driftDbPath(root)),
    root,
  );
}

function fail(msg: string): never {
  console.error(`drift: ${msg}`);
  process.exit(1);
}

/** Directories never worth scanning for spec files, even under a misconfigured docsDir. */
const WALK_IGNORE = new Set(["node_modules", "dist", "build", "out", "vendor"]);

function* walkMarkdown(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || WALK_IGNORE.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkMarkdown(p);
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
    if (ev.movedTo) {
      console.log(
        `    ↳ moved? source now matches '${ev.movedTo.symbol}' (${ev.movedTo.filePath}) — ` +
          `drift relink ${ev.link.id}`,
      );
    }
  }
  const c = { fresh: 0, stale: 0, broken: 0 };
  for (const ev of evals) c[ev.status]++;
  console.log(`\n${c.fresh} fresh, ${c.stale} stale, ${c.broken} broken / ${evals.length} links`);
}

function evaluationsToJson(evals: LinkEvaluation[]) {
  return evals.map((ev) => ({
    linkId: ev.link.id,
    status: ev.status,
    symbol: ev.link.symbolQualifiedName,
    symbolFilePath: ev.link.symbolFilePath,
    anchor: ev.link.anchorId,
    origin: ev.link.origin,
    drift: ev.status === "stale" ? ev.drift : undefined,
    missing: ev.status === "broken" ? ev.missing : undefined,
    movedTo: ev.movedTo,
  }));
}

// ---------------------------------------------------------------------------

async function cmdInit(root: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const config = { ...DEFAULT_CONFIG };

  while (true) {
    const docs = await rl.question(`Docs directory [${config.docsDir}]: `);
    if (docs.trim()) config.docsDir = docs.trim();
    const errors = validateConfig(root, config).filter((i) => i.severity === "error");
    if (errors.length === 0) break;
    for (const i of errors) console.error(`  ! ${i.message}`);
    config.docsDir = DEFAULT_CONFIG.docsDir;
  }

  console.log("\nLink acquisition strategies (comma-separated numbers, empty = all):");
  console.log("  1. annotation   — @spec: comments in code");
  console.log("  2. mapping      — standalone .drift/links.json (non-invasive)");
  console.log("  3. ai-suggested — lexical candidates via 'drift suggest', reviewed by an agent/human");
  const strat = (await rl.question("Enable [1,2,3]: ")).trim();
  if (strat) {
    const all = ["annotation", "mapping", "ai-suggested"] as const;
    config.strategies = strat
      .split(",")
      .map((s) => all[parseInt(s.trim(), 10) - 1])
      .filter(Boolean);
  }

  const hasCodeGraph = existsSync(join(root, DEFAULT_CONFIG.codegraphDb));
  console.log("\nSymbol index backend:");
  console.log(`  1. codegraph — reuse .codegraph/codegraph.db${hasCodeGraph ? " (found)" : " (NOT found)"}`);
  console.log("  2. builtin   — drift's own tree-sitter indexer (no external dependency)");
  const be = (await rl.question(`Backend [${hasCodeGraph ? "1" : "2"}]: `)).trim();
  config.backend = be === "1" ? "codegraph" : be === "2" ? "builtin" : hasCodeGraph ? "codegraph" : "builtin";

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

async function cmdIndex(root: string): Promise<void> {
  const config = loadCheckedConfig(root);
  const engine = await openEngine(root, config);
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

/**
 * Code files to scan for @spec: annotations: tracked files PLUS untracked
 * files that aren't git-ignored (--others --exclude-standard), so a brand-new
 * file's annotations are picked up before its first commit.
 */
function annotationScanFiles(root: string, config: DriftConfig): string[] {
  return workingTreeFiles(root).filter(
    (f) => !f.endsWith(".md") && !f.startsWith(config.docsDir + "/"),
  );
}

async function cmdSync(root: string): Promise<void> {
  const config = loadCheckedConfig(root);
  const engine = await openEngine(root, config);
  const decls = [];
  const warnings: string[] = [];
  let scanned = 0;
  if (config.strategies.includes("annotation")) {
    const scan = scanAnnotations(engine, annotationScanFiles(root, config));
    decls.push(...scan.declarations);
    warnings.push(...scan.warnings);
    scanned = scan.scannedFiles;
  }
  if (config.strategies.includes("mapping")) {
    decls.push(...loadMappingFile(root));
  }
  const r = syncDeclarations(engine, decls);
  console.log(
    `sync: scanned ${scanned} files (tracked + untracked), ` +
      `${decls.length} declarations, ${r.created} created, ${r.kept} kept`,
  );
  for (const w of warnings) console.error(`  ~ ${w}`);
  for (const e of r.errors) console.error(`  ! ${e}`);
  if (r.errors.length > 0) process.exit(1);
}

async function cmdSuggest(root: string, args: string[]): Promise<void> {
  const config = loadCheckedConfig(root);
  if (!config.strategies.includes("ai-suggested")) {
    fail(`the 'ai-suggested' strategy is disabled in .drift/config.json`);
  }
  const engine = await openEngine(root, config);
  const minConfidence = args.includes("--min-high") ? "high" : undefined;
  const suggestions = suggestLinks(engine, { minConfidence });
  const json = args.includes("--json");

  if (suggestions.length === 0) {
    console.log(json ? "[]" : "no link candidates found (index docs and code first)");
    return;
  }
  if (args.includes("--apply")) {
    const r = applySuggestions(engine, suggestions, process.env.USER ?? "suggest");
    console.log(`suggest: created ${r.created} links (origin: ai-suggested)`);
    for (const e of r.errors) console.error(`  ! ${e}`);
    return;
  }
  if (json) {
    console.log(JSON.stringify(suggestions, null, 2));
    return;
  }
  for (const s of suggestions) {
    console.log(
      `${s.confidence === "high" ? "●" : "○"} [${s.confidence}] ${s.symbol} ↔ ${s.anchorId}\n` +
        `    ${s.reason}  (${s.symbolKind} in ${s.symbolFilePath})`,
    );
  }
  console.log(
    `\n${suggestions.length} candidate(s). Review, then: drift suggest --apply  ` +
      `(or link individually: drift link <symbol> <anchor>)`,
  );
}

async function cmdStatus(root: string, args: string[]): Promise<void> {
  const engine = await openEngine(root);
  const json = args.includes("--json");
  const diffIdx = args.indexOf("--diff");
  const evals =
    diffIdx !== -1
      ? engine.evaluateForChangedFiles(
          changedFiles(
            root,
            args[diffIdx + 1]?.startsWith("--") ? undefined : args[diffIdx + 1],
          ),
        )
      : engine.evaluateAll();
  if (json) console.log(JSON.stringify(evaluationsToJson(evals), null, 2));
  else printEvaluations(evals);
  if (args.includes("--check") && evals.some((e) => e.status !== "fresh")) {
    process.exitCode = 1; // CI gate: any stale/broken link fails the run
  }
}

async function cmdContext(root: string, symbol: string | undefined, json: boolean): Promise<void> {
  if (!symbol) fail("usage: drift context <symbol>");
  const engine = await openEngine(root);
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

async function cmdCode(root: string, args: string[]): Promise<void> {
  const anchor = args.filter((a) => !a.startsWith("--"))[0];
  if (!anchor) fail("usage: drift code <docs/file.md[#anchor]> [--json]");
  const engine = await openEngine(root);
  const rows = engine.codeForSpec(anchor);
  if (args.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(`no code linked to ${anchor}`);
    return;
  }
  for (const r of rows) {
    console.log(
      `${STATUS_ICON[r.status]} [${r.linkId}] ${r.symbol}  (${r.filePath})  ← ${r.anchorId}`,
    );
  }
}

async function cmdLink(root: string, symbol?: string, anchor?: string): Promise<void> {
  if (!symbol || !anchor) fail("usage: drift link <symbol> <docs/file.md#anchor>");
  const engine = await openEngine(root);
  const link = engine.link(symbol, anchor, "mapping", process.env.USER);
  console.log(`linked [${link.id}] ${link.symbolQualifiedName} ↔ ${link.anchorId}`);
}

async function cmdApprove(root: string, id?: string): Promise<void> {
  if (!id) fail("usage: drift approve <link-id>");
  const engine = await openEngine(root);
  const ev = engine.approve(parseInt(id, 10), process.env.USER);
  console.log(`approved [${ev.link.id}] → ${ev.status}`);
}

async function cmdUnlink(root: string, id?: string): Promise<void> {
  if (!id) fail("usage: drift unlink <link-id>");
  const engine = await openEngine(root);
  engine.store.removeLink(parseInt(id, 10), process.env.USER);
  console.log(`removed link ${id}`);
}

async function cmdRelink(root: string, args: string[]): Promise<void> {
  const [id, toSymbol] = args.filter((a) => !a.startsWith("--"));
  if (!id) fail("usage: drift relink <link-id> [<new-symbol>]");
  const engine = await openEngine(root);
  const ev = engine.relink(parseInt(id, 10), toSymbol, process.env.USER);
  console.log(
    `relinked [${ev.link.id}] → ${ev.link.symbolQualifiedName} (${ev.link.symbolFilePath}) [${ev.status}]`,
  );
}

async function cmdFileLinks(root: string, args: string[]): Promise<void> {
  const file = args.filter((a) => !a.startsWith("--"))[0];
  if (!file) fail("usage: drift file-links <code-file> [--json]");
  const engine = await openEngine(root);
  const rows = engine.linksForCodeFile(file);
  if (args.includes("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log(`no links anchored in ${file}`);
    return;
  }
  for (const r of rows) {
    console.log(
      `${STATUS_ICON[r.status]} [${r.linkId}] L${r.startLine ?? "?"} ${r.symbol} ↔ ${r.anchorId} [${r.status}]`,
    );
  }
}

async function cmdCoverage(root: string, args: string[]): Promise<void> {
  const engine = await openEngine(root);
  const report = coverage(engine);
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `Spec coverage: ${report.linkedSymbols}/${report.totalSymbols} symbols linked (${report.percent}%)`,
  );
  const kinds = Object.entries(report.byKind).sort((a, b) => b[1].total - a[1].total);
  if (kinds.length > 0) {
    console.log("  by kind:");
    for (const [kind, k] of kinds) {
      const pct = k.total === 0 ? 0 : Math.round((k.linked / k.total) * 100);
      console.log(`    ${kind.padEnd(12)} ${k.linked}/${k.total}  (${pct}%)`);
    }
  }
  const l = report.links;
  console.log(
    `  links: ${l.total} total — ${l.fresh} fresh, ${l.stale} stale, ${l.broken} broken`,
  );
  console.log(
    `\n(100% is not the goal — track the trend on your public surface. ` +
      `Find candidates with: drift suggest)`,
  );
}

async function cmdVerify(root: string, args: string[]): Promise<void> {
  const config = loadCheckedConfig(root);
  const engine = await openEngine(root, config);
  const diffIdx = args.indexOf("--diff");
  const evals =
    diffIdx !== -1
      ? engine.evaluateForChangedFiles(
          changedFiles(root, args[diffIdx + 1]?.startsWith("--") ? undefined : args[diffIdx + 1]),
        )
      : engine.evaluateAll();
  const stale = evals.filter((e) => e.status === "stale");
  const json = args.includes("--json");

  if (stale.length === 0) {
    console.log(json ? "[]" : "verify: no stale links — nothing to check");
    return;
  }
  console.error(
    `verify: checking ${stale.length} stale link(s) with ${config.verify?.model ?? "claude-opus-4-8"}…`,
  );

  let results;
  try {
    results = await verifyLinks(engine, stale, { model: config.verify?.model });
  } catch (e) {
    if (e instanceof VerifyAuthError) fail(e.message);
    throw e;
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    const ICON = { consistent: "✓", diverged: "✗", uncertain: "?" } as const;
    for (const r of results) {
      console.log(
        `${ICON[r.verdict]} [${r.linkId}] ${r.verdict.toUpperCase()}  ${r.symbol} ↔ ${r.anchorId}`,
      );
      console.log(`    ${r.reasoning}`);
      if (r.conflictingStatement) {
        console.log(`    contradicts: "${r.conflictingStatement}"`);
      }
    }
  }

  const consistent = results.filter((r) => r.verdict === "consistent");
  if (args.includes("--auto-approve") && consistent.length > 0) {
    for (const r of consistent) {
      engine.approve(r.linkId, "verify");
      console.log(`auto-approved [${r.linkId}]`);
    }
  } else if (consistent.length > 0 && !json) {
    console.log(
      `\n${consistent.length} link(s) judged still consistent — re-pin with: ` +
        consistent.map((r) => `drift approve ${r.linkId}`).join(" && "),
    );
  }
  if (results.some((r) => r.verdict === "diverged")) process.exitCode = 78;
}

async function cmdPrComment(root: string, args: string[]): Promise<void> {
  // Emits a markdown comment body for the GitHub Actions bot (Q24).
  const baseIdx = args.indexOf("--base");
  const base = baseIdx !== -1 ? args[baseIdx + 1] : "origin/main";
  const engine = await openEngine(root);
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

process.on("uncaughtException", (e) => fail((e as Error).message));
process.on("unhandledRejection", (e) => fail((e as Error).message ?? String(e)));

switch (cmd) {
  case "init":
    await cmdInit(root);
    break;
  case "index":
    await cmdIndex(root);
    break;
  case "sync":
    await cmdSync(root);
    break;
  case "suggest":
    await cmdSuggest(root, rest);
    break;
  case "check":
    await cmdIndex(root);
    await cmdSync(root);
    await cmdStatus(root, rest);
    break;
  case "status":
    await cmdStatus(root, rest);
    break;
  case "verify":
    await cmdVerify(root, rest);
    break;
  case "coverage":
    await cmdCoverage(root, rest);
    break;
  case "context":
    await cmdContext(root, rest.filter((a) => a !== "--json")[0], rest.includes("--json"));
    break;
  case "code":
    await cmdCode(root, rest);
    break;
  case "file-links":
    await cmdFileLinks(root, rest);
    break;
  case "link":
    await cmdLink(root, rest[0], rest[1]);
    break;
  case "approve":
    await cmdApprove(root, rest[0]);
    break;
  case "relink":
    await cmdRelink(root, rest);
    break;
  case "unlink":
    await cmdUnlink(root, rest[0]);
    break;
  case "pr-comment":
    await cmdPrComment(root, rest);
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
                                 (scans tracked AND untracked non-ignored files)
  drift suggest [--apply] [--min-high] [--json]
                                 propose links by matching symbols to spec text
  drift check                    index + sync + status (git-hook entry point)
  drift status [--diff [base]] [--json]
                                 fresh/stale/broken for all or changed-file links
  drift verify [--diff [base]] [--auto-approve] [--json]
                                 LLM-judge whether STALE links still agree
                                 (needs Anthropic credentials; stale links only)
  drift coverage [--json]        % of symbols with spec links, by kind
  drift context <symbol> [--json]  spec sections for a symbol (code → spec)
  drift code <file.md[#anchor]> [--json]
                                 symbols implementing a spec section (spec → code)
  drift file-links <code-file> [--json]
                                 links anchored in one code file (editor view)
  drift link <symbol> <anchor>   create a link, pinned at current hashes
  drift approve <link-id>        re-pin a stale link as still-correct
  drift relink <link-id> [<symbol>]
                                 re-point a broken link at a renamed symbol
  drift unlink <link-id>         remove a broken/obsolete link
  drift pr-comment [--base ref]  emit PR comment markdown (GitHub Actions bot)
  drift mcp                      run the MCP server (stdio)

backend: symbol data comes from CodeGraph (.codegraph/codegraph.db) or the
built-in tree-sitter indexer — set "backend": "codegraph" | "builtin" in
.drift/config.json (missing CodeGraph index falls back to builtin).`);
    if (cmd) process.exit(1);
}
