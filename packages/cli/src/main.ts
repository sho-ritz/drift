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
import * as ui from "./ui.js";
import { c } from "./ui.js";
import { execSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createInterface } from "node:readline/promises";

const VERSION = "0.3.0";

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
    console.error(ui.warn(`config: ${i.field}: ${i.message}`));
  }
  const errors = issues.filter((i) => i.severity === "error");
  if (errors.length > 0) {
    for (const i of errors) console.error(ui.err(`config: ${i.field}: ${i.message}`));
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
      ui.hint(
        `drift: CodeGraph index not found at ${config.codegraphDb}; using the built-in ` +
          `tree-sitter indexer (set "backend": "builtin" in .drift/config.json to silence this)`,
      ),
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
  console.error(`${c.red("drift:")} ${msg}`);
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

function printEvaluations(evals: LinkEvaluation[]): void {
  if (evals.length === 0) {
    console.log(ui.hint("no links to evaluate"));
    return;
  }
  for (const ev of evals) {
    const which =
      ev.status === "stale"
        ? c.dim(` (${[ev.drift.symbol && "code", ev.drift.anchor && "spec"].filter(Boolean).join("+")} changed)`)
        : ev.status === "broken"
          ? c.dim(` (${ev.missing.symbol ? "symbol" : "anchor"} missing)`)
          : "";
    console.log(
      `${ui.glyph(ev.status)} ${ui.id(ev.link.id)} ${ui.statusWord(ev.status)}${which}  ` +
        `${ui.sym(ev.link.symbolQualifiedName)} ${c.dim("↔")} ${ui.anchor(ev.link.anchorId)}`,
    );
    if (ev.movedTo) {
      console.log(
        `    ${c.cyan("↳")} moved? source now matches ${ui.sym(ev.movedTo.symbol)} ${c.dim(`(${ev.movedTo.filePath})`)} — ${ui.cmd(`drift relink ${ev.link.id}`)}`,
      );
    }
  }
  const counts = { fresh: 0, stale: 0, broken: 0 };
  for (const ev of evals) counts[ev.status]++;
  console.log(`\n${ui.rule()}\n${ui.statusSummary(counts)} ${c.dim(`/ ${evals.length} links`)}`);
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
  console.log(ui.banner(VERSION));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const config = { ...DEFAULT_CONFIG };

  console.log(ui.step("Docs"));
  while (true) {
    const docs = await rl.question(`  Docs directory ${c.dim(`[${config.docsDir}]`)}: `);
    if (docs.trim()) config.docsDir = docs.trim();
    const errors = validateConfig(root, config).filter((i) => i.severity === "error");
    if (errors.length === 0) break;
    for (const i of errors) console.error(`  ${ui.err(i.message)}`);
    config.docsDir = DEFAULT_CONFIG.docsDir;
  }

  console.log(`\n${ui.step("Link acquisition strategies")} ${c.dim("(comma-separated numbers, empty = all)")}`);
  console.log(`  ${c.cyan("1.")} annotation   ${c.dim("— @spec: comments in code")}`);
  console.log(`  ${c.cyan("2.")} mapping      ${c.dim("— standalone .drift/links.json (non-invasive)")}`);
  console.log(`  ${c.cyan("3.")} ai-suggested ${c.dim("— lexical candidates via 'drift suggest', reviewed by an agent/human")}`);
  const strat = (await rl.question(`  Enable ${c.dim("[1,2,3]")}: `)).trim();
  if (strat) {
    const all = ["annotation", "mapping", "ai-suggested"] as const;
    config.strategies = strat
      .split(",")
      .map((s) => all[parseInt(s.trim(), 10) - 1])
      .filter(Boolean);
  }

  const hasCodeGraph = existsSync(join(root, DEFAULT_CONFIG.codegraphDb));
  console.log(`\n${ui.step("Symbol index backend")}`);
  console.log(`  ${c.cyan("1.")} codegraph ${c.dim(`— reuse .codegraph/codegraph.db ${hasCodeGraph ? "(found)" : "(NOT found)"}`)}`);
  console.log(`  ${c.cyan("2.")} builtin   ${c.dim("— drift's own tree-sitter indexer (no external dependency)")}`);
  const be = (await rl.question(`  Backend ${c.dim(`[${hasCodeGraph ? "1" : "2"}]`)}: `)).trim();
  config.backend = be === "1" ? "codegraph" : be === "2" ? "builtin" : hasCodeGraph ? "codegraph" : "builtin";

  console.log(`\n${ui.step("AI agents to configure")} ${c.dim("(comma-separated numbers)")}`);
  console.log(`  ${c.cyan("1.")} claude-code  ${c.dim("→ CLAUDE.md + .claude/skills")}`);
  console.log(`  ${c.cyan("2.")} codex        ${c.dim("→ AGENTS.md")}`);
  console.log(`  ${c.cyan("3.")} gemini-cli   ${c.dim("→ GEMINI.md")}`);
  const ag = (await rl.question(`  Configure ${c.dim("[1]")}: `)).trim() || "1";
  const agentsAll: AgentKind[] = ["claude-code", "codex", "gemini-cli"];
  config.agents = ag
    .split(",")
    .map((s) => agentsAll[parseInt(s.trim(), 10) - 1])
    .filter(Boolean);
  rl.close();

  saveConfig(root, config);
  console.log();
  console.log(ui.ok(`wrote ${c.bold(".drift/config.json")} ${c.dim(`(backend: ${config.backend})`)}`));

  for (const r of writeAgentInstructions(root, config.agents)) {
    console.log(ui.ok(`${r.action} ${c.bold(r.file)} ${c.dim("(drift instruction block)")}`));
  }
  if (config.agents.includes("claude-code")) {
    for (const f of installSkills(root)) console.log(ui.ok(`installed ${c.bold(f)}`));
  }
  console.log();
  console.log(
    ui.box([
      `${c.bold("Drift is ready.")}`,
      "",
      `Next: ${ui.cmd("drift index")} ${c.dim("&&")} ${ui.cmd("drift sync")}`,
      ui.hint("then try: drift status · drift coverage · drift suggest"),
    ]),
  );
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
  console.log(
    ui.ok(`indexed ${c.bold(String(anchors))} anchors from ${c.bold(String(files))} spec files under ${c.cyan(config.docsDir + "/")}`),
  );
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
    ui.ok(
      `sync: scanned ${c.bold(String(scanned))} files ${c.dim("(tracked + untracked)")}, ` +
        `${decls.length} declarations ${c.dim("→")} ${c.green(`${r.created} created`)}, ${c.dim(`${r.kept} kept`)}`,
    ),
  );
  for (const w of warnings) console.error(`  ${ui.warn(w)}`);
  for (const e of r.errors) console.error(`  ${ui.err(e)}`);
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
    console.log(json ? "[]" : ui.hint("no link candidates found (index docs and code first)"));
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
    const dot = s.confidence === "high" ? c.green("●") : c.yellow("○");
    const conf = s.confidence === "high" ? c.green("high") : c.yellow("med ");
    console.log(
      `${dot} ${conf} ${ui.sym(s.symbol)} ${c.dim("↔")} ${ui.anchor(s.anchorId)}\n` +
        `       ${c.dim(`${s.reason}  (${s.symbolKind} in ${s.symbolFilePath})`)}`,
    );
  }
  console.log(
    `\n${ui.rule()}\n${c.bold(String(suggestions.length))} candidate(s). Review, then: ${ui.cmd("drift suggest --apply")}  ` +
      ui.hint("(or link individually: drift link <symbol> <anchor>)"),
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
    console.log(`${ui.sym(ctx.symbol)}: ${ui.hint("no spec links (direct or inherited)")}`);
    return;
  }
  console.log(
    `${ui.sym(ctx.symbol)}${ctx.inferred ? c.dim(` (inferred from ${ctx.resolvedSymbol})`) : ""} — ` +
      `${c.green(String(ctx.freshness.fresh))}${c.dim(`/${ctx.freshness.total} fresh`)}\n`,
  );
  for (const e of ctx.entries) {
    console.log(`${ui.rule()}\n${ui.glyph(e.status)} ${ui.anchor(e.anchorId)} ${ui.statusWord(e.status)}`);
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
    console.log(ui.hint(`no code linked to ${anchor}`));
    return;
  }
  for (const r of rows) {
    console.log(
      `${ui.glyph(r.status)} ${ui.id(r.linkId)} ${ui.sym(r.symbol)}  ${c.dim(`(${r.filePath})`)}  ${c.dim("←")} ${ui.anchor(r.anchorId)}`,
    );
  }
}

async function cmdLink(root: string, symbol?: string, anchor?: string): Promise<void> {
  if (!symbol || !anchor) fail("usage: drift link <symbol> <docs/file.md#anchor>");
  const engine = await openEngine(root);
  const link = engine.link(symbol, anchor, "mapping", process.env.USER);
  console.log(ui.ok(`linked ${ui.id(link.id)} ${ui.sym(link.symbolQualifiedName)} ${c.dim("↔")} ${ui.anchor(link.anchorId)}`));
}

async function cmdApprove(root: string, id?: string): Promise<void> {
  if (!id) fail("usage: drift approve <link-id>");
  const engine = await openEngine(root);
  const ev = engine.approve(parseInt(id, 10), process.env.USER);
  console.log(ui.ok(`approved ${ui.id(ev.link.id)} → ${ui.statusWord(ev.status)}`));
}

async function cmdUnlink(root: string, id?: string): Promise<void> {
  if (!id) fail("usage: drift unlink <link-id>");
  const engine = await openEngine(root);
  engine.store.removeLink(parseInt(id, 10), process.env.USER);
  console.log(ui.ok(`removed link ${ui.id(id)}`));
}

async function cmdRelink(root: string, args: string[]): Promise<void> {
  const [id, toSymbol] = args.filter((a) => !a.startsWith("--"));
  if (!id) fail("usage: drift relink <link-id> [<new-symbol>]");
  const engine = await openEngine(root);
  const ev = engine.relink(parseInt(id, 10), toSymbol, process.env.USER);
  console.log(
    ui.ok(
      `relinked ${ui.id(ev.link.id)} → ${ui.sym(ev.link.symbolQualifiedName)} ${c.dim(`(${ev.link.symbolFilePath})`)} ${ui.statusWord(ev.status)}`,
    ),
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
    console.log(ui.hint(`no links anchored in ${file}`));
    return;
  }
  for (const r of rows) {
    console.log(
      `${ui.glyph(r.status)} ${ui.id(r.linkId)} ${c.dim(`L${r.startLine ?? "?"}`)} ${ui.sym(r.symbol)} ${c.dim("↔")} ${ui.anchor(r.anchorId)} ${ui.statusWord(r.status)}`,
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
  console.log(`${ui.mark()} ${c.bold("spec coverage")}\n`);
  console.log(
    `  ${ui.bar(report.percent)}  ${c.bold(`${report.percent}%`)} ${c.dim(`(${report.linkedSymbols}/${report.totalSymbols} symbols linked)`)}\n`,
  );
  const kinds = Object.entries(report.byKind).sort((a, b) => b[1].total - a[1].total);
  for (const [kind, k] of kinds) {
    const pct = k.total === 0 ? 0 : Math.round((k.linked / k.total) * 100);
    console.log(`  ${kind.padEnd(11)} ${ui.bar(pct, 14)}  ${String(k.linked).padStart(3)}${c.dim(`/${k.total}`)}`);
  }
  console.log(`\n  links: ${ui.statusSummary(report.links)} ${c.dim(`/ ${report.links.total} total`)}`);
  console.log(
    ui.hint(
      `\n  100% is not the goal — track the trend on your public surface.` +
        `\n  Find candidates with: drift suggest`,
    ),
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
    console.log(json ? "[]" : ui.ok(`verify: no stale links — nothing to check`));
    return;
  }
  console.error(
    `${ui.mark()} verify: checking ${c.bold(String(stale.length))} stale link(s) with ${c.cyan(config.verify?.model ?? "claude-opus-4-8")}…`,
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
    const ICON = {
      consistent: c.green("✓ CONSISTENT"),
      diverged: c.red("✗ DIVERGED"),
      uncertain: c.yellow("? UNCERTAIN"),
    } as const;
    for (const r of results) {
      console.log(`${ICON[r.verdict]} ${ui.id(r.linkId)} ${ui.sym(r.symbol)} ${c.dim("↔")} ${ui.anchor(r.anchorId)}`);
      console.log(`    ${c.dim(r.reasoning)}`);
      if (r.conflictingStatement) {
        console.log(`    ${c.red("contradicts:")} ${c.italic(`"${r.conflictingStatement}"`)}`);
      }
    }
  }

  const consistent = results.filter((r) => r.verdict === "consistent");
  if (args.includes("--auto-approve") && consistent.length > 0) {
    for (const r of consistent) {
      engine.approve(r.linkId, "verify");
      console.log(ui.ok(`auto-approved ${ui.id(r.linkId)}`));
    }
  } else if (consistent.length > 0 && !json) {
    console.log(
      `\n${c.green(String(consistent.length))} link(s) judged still consistent — re-pin with: ` +
        ui.cmd(consistent.map((r) => `drift approve ${r.linkId}`).join(" && ")),
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
  default: {
    const row = (usage: string, desc: string) => {
      const [name, ...args] = usage.split(" ");
      const left = `  ${ui.cmd("drift " + name)}${args.length ? " " + c.dim(args.join(" ")) : ""}`;
      const plain = `  drift ${usage}`;
      const pad = Math.max(1, 40 - plain.length);
      return `${left}${" ".repeat(pad)}${desc}`;
    };
    const H = (t: string) => `\n${c.bold(t)}`;
    console.log(ui.banner(VERSION));
    console.log(
      [
        H("setup"),
        row("init", "interactive setup (backend, agents, strategies)"),
        H("build the graph"),
        row("index", "extract spec anchors from docs"),
        row("sync", "apply @spec: annotations + .drift/links.json"),
        row("suggest [--apply] [--min-high]", "propose links from lexical matches"),
        H("check"),
        row("status [--diff] [--check]", "fresh/stale/broken for every link"),
        row("verify [--diff] [--auto-approve]", "LLM-judge whether STALE links still agree"),
        row("coverage", "% of symbols with spec links, by kind"),
        row("check [--check]", "index + sync + status (git-hook / CI entry)"),
        H("navigate"),
        row("context <symbol>", "spec sections for a symbol (code → spec)"),
        row("code <file.md[#anchor]>", "symbols implementing a section (spec → code)"),
        row("file-links <code-file>", "links anchored in one code file (editors)"),
        H("curate"),
        row("link <symbol> <anchor>", "create a link, pinned at current hashes"),
        row("approve <link-id>", "re-pin a stale link as still-correct"),
        row("relink <link-id> [<symbol>]", "re-point a broken link at a renamed symbol"),
        row("unlink <link-id>", "remove a broken/obsolete link"),
        H("integrate"),
        row("pr-comment [--base ref]", "emit PR comment markdown (GitHub Actions)"),
        row("mcp", "run the MCP server (stdio)"),
        "",
        ui.hint("  most commands take --json · backend: codegraph | builtin (.drift/config.json)"),
        ui.hint("  docs: https://github.com/sho-ritz/drift"),
      ].join("\n"),
    );
    if (cmd) process.exit(1);
  }
}
