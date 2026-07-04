import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Symbol } from "./types.js";

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
}

/**
 * Read-only view over the CodeGraph index (Q8: Drift extends CodeGraph
 * rather than re-parsing code). CodeGraph is distributed as a binary, so
 * the extension point is its SQLite database, never its process.
 */
export class CodeGraphReader {
  private db: Database.Database;

  constructor(dbPath: string, private repoRoot: string) {
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  close(): void {
    this.db.close();
  }

  private toSymbol(r: NodeRow): Symbol {
    return {
      id: r.id,
      kind: r.kind,
      name: r.name,
      qualifiedName: r.qualified_name,
      filePath: r.file_path,
      startLine: r.start_line,
      endLine: r.end_line,
      signature: r.signature,
    };
  }

  /** Look a symbol up by qualified name, falling back to bare name. */
  findSymbol(nameOrQualified: string): Symbol | null {
    const byQualified = this.db
      .prepare(
        `SELECT id, kind, name, qualified_name, file_path, start_line, end_line, signature
         FROM nodes WHERE qualified_name = ? AND kind NOT IN ('file','import') LIMIT 1`,
      )
      .get(nameOrQualified) as NodeRow | undefined;
    if (byQualified) return this.toSymbol(byQualified);

    const byName = this.db
      .prepare(
        `SELECT id, kind, name, qualified_name, file_path, start_line, end_line, signature
         FROM nodes WHERE name = ? AND kind NOT IN ('file','import') LIMIT 1`,
      )
      .get(nameOrQualified) as NodeRow | undefined;
    return byName ? this.toSymbol(byName) : null;
  }

  getSymbolById(id: string): Symbol | null {
    const r = this.db
      .prepare(
        `SELECT id, kind, name, qualified_name, file_path, start_line, end_line, signature
         FROM nodes WHERE id = ?`,
      )
      .get(id) as NodeRow | undefined;
    return r ? this.toSymbol(r) : null;
  }

  /** All non-file, non-import symbols declared in a file. */
  symbolsInFile(filePath: string): Symbol[] {
    const rows = this.db
      .prepare(
        `SELECT id, kind, name, qualified_name, file_path, start_line, end_line, signature
         FROM nodes WHERE file_path = ? AND kind NOT IN ('file','import')
         ORDER BY start_line`,
      )
      .all(filePath) as NodeRow[];
    return rows.map((r) => this.toSymbol(r));
  }

  /**
   * Containment chain for hierarchical fallback (Q21): the symbols in the
   * same file that strictly enclose this one, innermost first, ending with
   * the file node itself.
   */
  containmentChain(symbol: Symbol): Symbol[] {
    const enclosing = this.symbolsInFile(symbol.filePath)
      .filter(
        (s) =>
          s.id !== symbol.id &&
          s.startLine <= symbol.startLine &&
          s.endLine >= symbol.endLine &&
          // strictly larger span = actually encloses
          s.endLine - s.startLine > symbol.endLine - symbol.startLine,
      )
      .sort(
        (a, b) => a.endLine - a.startLine - (b.endLine - b.startLine),
      );
    const fileNode = this.getSymbolById(`file:${symbol.filePath}`);
    return fileNode ? [...enclosing, fileNode] : enclosing;
  }

  /** Current source text of a symbol, read straight from the working tree. */
  readSymbolSource(symbol: Symbol): string | null {
    try {
      const abs = join(this.repoRoot, symbol.filePath);
      const lines = readFileSync(abs, "utf8").split("\n");
      return lines.slice(symbol.startLine - 1, symbol.endLine).join("\n");
    } catch {
      return null;
    }
  }
}
