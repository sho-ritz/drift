import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import type { DriftConfig } from "./types.js";

const CONFIG_REL = ".drift/config.json";

export const DEFAULT_CONFIG: DriftConfig = {
  docsDir: "docs",
  strategies: ["annotation", "mapping", "ai-suggested"],
  agents: ["claude-code"],
  codegraphDb: ".codegraph/codegraph.db",
};

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
