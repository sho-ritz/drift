import type { Symbol } from "./types.js";

/**
 * Backend-neutral view over a symbol index. Drift's engine talks to this
 * interface only, so the symbol source can be CodeGraph's SQLite index
 * (read-only reuse) or Drift's own built-in tree-sitter indexer — chosen
 * per-repo via `backend` in .drift/config.json. This removes the hard
 * runtime dependency on CodeGraph's internal schema.
 */
export interface SymbolIndex {
  /** Look a symbol up by qualified name, falling back to bare name. */
  findSymbol(nameOrQualified: string): Symbol | null;
  getSymbolById(id: string): Symbol | null;
  /** All non-file, non-import symbols declared in a file. */
  symbolsInFile(filePath: string): Symbol[];
  /** All symbols in the index, optionally filtered by kind. */
  listSymbols(kinds?: string[]): Symbol[];
  /**
   * Symbols in the same file that strictly enclose this one, innermost
   * first, ending with the file node itself (hierarchical fallback).
   */
  containmentChain(symbol: Symbol): Symbol[];
  /** Current source text of a symbol, read from the working tree. */
  readSymbolSource(symbol: Symbol): string | null;
  /**
   * Backend-specific code normalization used before hashing, replacing the
   * default regex approximation when the backend can parse the language
   * (e.g. AST-accurate comment stripping). Optional.
   */
  normalizeSource?(source: string, filePath: string): string;
  close(): void;
}
