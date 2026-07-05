import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { CodeGraphReader } from "../codegraph.js";
import { DriftEngine } from "../engine.js";
import { DriftStore } from "../store.js";

/** Symbol row for the fixture CodeGraph database. */
export interface FixtureNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature?: string | null;
}

export interface FixtureRepo {
  root: string;
  engine: DriftEngine;
  /** overwrite a file and (cheaply) leave the codegraph rows as-is */
  write(relPath: string, content: string): void;
  cleanup(): void;
}

/**
 * Build a throwaway repo + CodeGraph index + Drift store. The CodeGraph db
 * only needs the `nodes` table columns CodeGraphReader reads.
 */
export function makeFixtureRepo(opts: {
  files?: Record<string, string>;
  nodes?: FixtureNode[];
}): FixtureRepo {
  const root = mkdtempSync(join(tmpdir(), "drift-test-"));

  const write = (relPath: string, content: string) => {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [p, c] of Object.entries(opts.files ?? {})) write(p, c);

  const cgPath = join(root, ".codegraph", "codegraph.db");
  mkdirSync(dirname(cgPath), { recursive: true });
  const cg = new Database(cgPath);
  cg.exec(`CREATE TABLE nodes (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    signature TEXT
  )`);
  const ins = cg.prepare(
    `INSERT INTO nodes (id, kind, name, qualified_name, file_path, start_line, end_line, signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const nodes = opts.nodes ?? [];
  const fileNodes = new Set<string>();
  for (const n of nodes) {
    ins.run(n.id, n.kind, n.name, n.qualifiedName, n.filePath, n.startLine, n.endLine, n.signature ?? null);
    fileNodes.add(n.filePath);
  }
  // a file node per referenced file, as real CodeGraph produces
  for (const f of fileNodes) {
    ins.run(`file:${f}`, "file", f, f, f, 1, 100000, null);
  }
  cg.close();

  const engine = new DriftEngine(
    new CodeGraphReader(cgPath, root),
    new DriftStore(join(root, ".drift", "drift.db")),
    root,
  );

  return {
    root,
    engine,
    write,
    cleanup() {
      engine.symbols.close();
      engine.store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
