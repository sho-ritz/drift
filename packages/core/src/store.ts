import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Link, LinkOrigin, SpecAnchor } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS spec_anchors (
  id TEXT PRIMARY KEY,           -- "docs/auth.md#token-refresh"
  file_path TEXT NOT NULL,
  slug TEXT NOT NULL,
  heading TEXT NOT NULL,
  heading_level INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  body TEXT NOT NULL,            -- cached section text: zero-cost context reads
  body_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_anchors_file ON spec_anchors(file_path);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol_id TEXT NOT NULL,
  symbol_qualified_name TEXT NOT NULL,
  symbol_file_path TEXT NOT NULL,
  anchor_id TEXT NOT NULL,
  origin TEXT NOT NULL,          -- annotation | mapping | ai-suggested
  approved_symbol_hash TEXT NOT NULL,
  approved_anchor_hash TEXT NOT NULL,
  approved_at INTEGER NOT NULL,
  approved_by TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(symbol_id, anchor_id)
);
CREATE INDEX IF NOT EXISTS idx_links_symbol ON links(symbol_id);
CREATE INDEX IF NOT EXISTS idx_links_anchor ON links(anchor_id);

-- audit trail of approvals (open item, minimal v1: append-only log)
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL,
  action TEXT NOT NULL,          -- approve | create | remove
  actor TEXT,
  at INTEGER NOT NULL
);
`;

interface LinkRow {
  id: number;
  symbol_id: string;
  symbol_qualified_name: string;
  symbol_file_path: string;
  anchor_id: string;
  origin: string;
  approved_symbol_hash: string;
  approved_anchor_hash: string;
  approved_at: number;
  approved_by: string | null;
  created_at: number;
}

function toLink(r: LinkRow): Link {
  return {
    id: r.id,
    symbolId: r.symbol_id,
    symbolQualifiedName: r.symbol_qualified_name,
    symbolFilePath: r.symbol_file_path,
    anchorId: r.anchor_id,
    origin: r.origin as LinkOrigin,
    approvedSymbolHash: r.approved_symbol_hash,
    approvedAnchorHash: r.approved_anchor_hash,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by,
    createdAt: r.created_at,
  };
}

/** Drift's own database: spec anchors, corresponds_to links, approval log. */
export class DriftStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ---- anchors -------------------------------------------------------

  /** Replace all anchors for one spec file with a freshly extracted set. */
  replaceAnchorsForFile(filePath: string, anchors: SpecAnchor[]): void {
    const del = this.db.prepare(`DELETE FROM spec_anchors WHERE file_path = ?`);
    const ins = this.db.prepare(
      `INSERT INTO spec_anchors
         (id, file_path, slug, heading, heading_level, start_line, end_line, body, body_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const now = Date.now();
    this.db.transaction(() => {
      del.run(filePath);
      for (const a of anchors) {
        ins.run(
          a.id, a.filePath, a.slug, a.heading, a.headingLevel,
          a.startLine, a.endLine, a.body, a.bodyHash, now,
        );
      }
    })();
  }

  getAnchor(id: string): SpecAnchor | null {
    const r = this.db
      .prepare(`SELECT * FROM spec_anchors WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      id: r.id as string,
      filePath: r.file_path as string,
      slug: r.slug as string,
      heading: r.heading as string,
      headingLevel: r.heading_level as number,
      startLine: r.start_line as number,
      endLine: r.end_line as number,
      body: r.body as string,
      bodyHash: r.body_hash as string,
    };
  }

  listAnchorFiles(): string[] {
    return (
      this.db.prepare(`SELECT DISTINCT file_path FROM spec_anchors`).all() as {
        file_path: string;
      }[]
    ).map((r) => r.file_path);
  }

  // ---- links ---------------------------------------------------------

  createLink(input: {
    symbolId: string;
    symbolQualifiedName: string;
    symbolFilePath: string;
    anchorId: string;
    origin: LinkOrigin;
    symbolHash: string;
    anchorHash: string;
    actor?: string;
  }): Link {
    const now = Date.now();
    const info = this.db
      .prepare(
        `INSERT INTO links
           (symbol_id, symbol_qualified_name, symbol_file_path, anchor_id, origin,
            approved_symbol_hash, approved_anchor_hash, approved_at, approved_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(symbol_id, anchor_id) DO UPDATE SET
           approved_symbol_hash = excluded.approved_symbol_hash,
           approved_anchor_hash = excluded.approved_anchor_hash,
           approved_at = excluded.approved_at,
           approved_by = excluded.approved_by`,
      )
      .run(
        input.symbolId, input.symbolQualifiedName, input.symbolFilePath,
        input.anchorId, input.origin, input.symbolHash, input.anchorHash,
        now, input.actor ?? null, now,
      );
    const link = this.getLinkBySymbolAnchor(input.symbolId, input.anchorId)!;
    this.logApproval(link.id, "create", input.actor);
    return link;
  }

  /** Re-confirm a link as still-correct: re-pin both hashes (one-click approve, Q7). */
  approveLink(linkId: number, symbolHash: string, anchorHash: string, actor?: string): void {
    this.db
      .prepare(
        `UPDATE links SET approved_symbol_hash = ?, approved_anchor_hash = ?,
           approved_at = ?, approved_by = ? WHERE id = ?`,
      )
      .run(symbolHash, anchorHash, Date.now(), actor ?? null, linkId);
    this.logApproval(linkId, "approve", actor);
  }

  removeLink(linkId: number, actor?: string): void {
    this.logApproval(linkId, "remove", actor);
    this.db.prepare(`DELETE FROM links WHERE id = ?`).run(linkId);
  }

  getLink(id: number): Link | null {
    const r = this.db.prepare(`SELECT * FROM links WHERE id = ?`).get(id) as
      | LinkRow
      | undefined;
    return r ? toLink(r) : null;
  }

  getLinkBySymbolAnchor(symbolId: string, anchorId: string): Link | null {
    const r = this.db
      .prepare(`SELECT * FROM links WHERE symbol_id = ? AND anchor_id = ?`)
      .get(symbolId, anchorId) as LinkRow | undefined;
    return r ? toLink(r) : null;
  }

  linksForSymbol(symbolId: string): Link[] {
    return (
      this.db
        .prepare(`SELECT * FROM links WHERE symbol_id = ?`)
        .all(symbolId) as LinkRow[]
    ).map(toLink);
  }

  linksForAnchor(anchorId: string): Link[] {
    return (
      this.db
        .prepare(`SELECT * FROM links WHERE anchor_id = ?`)
        .all(anchorId) as LinkRow[]
    ).map(toLink);
  }

  linksForSpecFile(filePath: string): Link[] {
    return (
      this.db
        .prepare(`SELECT * FROM links WHERE anchor_id LIKE ? || '#%'`)
        .all(filePath) as LinkRow[]
    ).map(toLink);
  }

  linksForCodeFile(filePath: string): Link[] {
    return (
      this.db
        .prepare(`SELECT * FROM links WHERE symbol_file_path = ?`)
        .all(filePath) as LinkRow[]
    ).map(toLink);
  }

  allLinks(): Link[] {
    return (this.db.prepare(`SELECT * FROM links`).all() as LinkRow[]).map(toLink);
  }

  private logApproval(linkId: number, action: string, actor?: string): void {
    this.db
      .prepare(`INSERT INTO approvals (link_id, action, actor, at) VALUES (?, ?, ?, ?)`)
      .run(linkId, action, actor ?? null, Date.now());
  }
}
