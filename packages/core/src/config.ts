import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, isAbsolute, normalize } from "node:path";
import type { DriftConfig } from "./types.js";

const CONFIG_REL = ".drift/config.json";

export const DEFAULT_CONFIG: DriftConfig = {
  docsDir: "docs",
  strategies: ["annotation", "mapping", "ai-suggested"],
  agents: ["claude-code"],
  codegraphDb: ".codegraph/codegraph.db",
};

const KNOWN_STRATEGIES = new Set(["annotation", "mapping", "ai-suggested"]);
const KNOWN_AGENTS = new Set(["claude-code", "codex", "gemini-cli"]);

/** One problem found in .drift/config.json. `error` blocks commands; `warning` prints. */
export interface ConfigIssue {
  severity: "error" | "warning";
  field: string;
  message: string;
}

/**
 * Validate a config against the mistakes that silently poison the index —
 * most importantly docsDir pointing at the repo root, which drags
 * node_modules and every stray markdown file into the anchor index.
 */
export function validateConfig(repoRoot: string, config: DriftConfig): ConfigIssue[] {
  const issues: ConfigIssue[] = [];

  const docsDir = normalize(config.docsDir).replace(/\/+$/, "");
  if (docsDir === "." || docsDir === "" || docsDir === "./") {
    issues.push({
      severity: "error",
      field: "docsDir",
      message:
        `docsDir "${config.docsDir}" points at the repository root; indexing would sweep up ` +
        `node_modules, READMEs, and vendored markdown. Point it at your docs vault (e.g. "docs").`,
    });
  } else if (isAbsolute(config.docsDir)) {
    issues.push({
      severity: "error",
      field: "docsDir",
      message: `docsDir must be repo-relative, got absolute path "${config.docsDir}".`,
    });
  } else if (docsDir.startsWith("..")) {
    issues.push({
      severity: "error",
      field: "docsDir",
      message: `docsDir "${config.docsDir}" escapes the repository root.`,
    });
  } else {
    if (docsDir.split("/").includes("node_modules")) {
      issues.push({
        severity: "warning",
        field: "docsDir",
        message: `docsDir "${config.docsDir}" is inside node_modules — almost certainly a mistake.`,
      });
    }
    if (!existsSync(join(repoRoot, docsDir))) {
      issues.push({
        severity: "warning",
        field: "docsDir",
        message: `docsDir "${config.docsDir}" does not exist yet.`,
      });
    }
  }

  for (const s of config.strategies) {
    if (!KNOWN_STRATEGIES.has(s)) {
      issues.push({
        severity: "warning",
        field: "strategies",
        message: `unknown strategy "${s}" (known: ${[...KNOWN_STRATEGIES].join(", ")}).`,
      });
    }
  }
  for (const a of config.agents) {
    if (!KNOWN_AGENTS.has(a)) {
      issues.push({
        severity: "warning",
        field: "agents",
        message: `unknown agent "${a}" (known: ${[...KNOWN_AGENTS].join(", ")}).`,
      });
    }
  }
  return issues;
}

export function configPath(repoRoot: string): string {
  return join(repoRoot, CONFIG_REL);
}

export function loadConfig(repoRoot: string): DriftConfig {
  const p = configPath(repoRoot);
  if (!existsSync(p)) {
    throw new Error(`Drift is not initialized here (missing ${CONFIG_REL}). Run: drift init`);
  }
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(p, "utf8")) };
}

export function saveConfig(repoRoot: string, config: DriftConfig): void {
  const p = configPath(repoRoot);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(config, null, 2) + "\n");
}

export function driftDbPath(repoRoot: string): string {
  return join(repoRoot, ".drift", "drift.db");
}
