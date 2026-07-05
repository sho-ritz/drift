import Parser from "web-tree-sitter";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import type { Symbol } from "./types.js";
import type { SymbolIndex } from "./symbol-index.js";
import { normalizeCode } from "./hash.js";

const require_ = createRequire(import.meta.url);

/**
 * Built-in symbol indexer (Q8 revisited): tree-sitter over prebuilt WASM
 * grammars, so Drift runs with zero external index. Selected with
 * `backend: "builtin"` in .drift/config.json; the CodeGraph backend remains
 * available and is still the default where its index exists.
 *
 * Also provides AST-accurate `normalizeSource`: comment nodes are removed
 * from the parse tree instead of regex-guessed, so a `//` inside a string
 * literal can never corrupt the hash.
 */

interface LangSpec {
  wasm: string;
  /** node type → drift kind; "?" values get resolved by resolveKind */
  kinds: Record<string, string>;
  /** node types that qualify the names of symbols nested inside them */
  containers: Set<string>;
}

const TS_KINDS: Record<string, string> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  method_definition: "method",
  interface_declaration: "interface",
  enum_declaration: "enum",
  type_alias_declaration: "type_alias",
  variable_declarator: "?variable_declarator",
};
const TS_CONTAINERS = new Set([
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "enum_declaration",
]);

const LANGS: Record<string, LangSpec> = {
  ".ts": { wasm: "typescript", kinds: TS_KINDS, containers: TS_CONTAINERS },
  ".mts": { wasm: "typescript", kinds: TS_KINDS, containers: TS_CONTAINERS },
  ".cts": { wasm: "typescript", kinds: TS_KINDS, containers: TS_CONTAINERS },
  ".tsx": { wasm: "tsx", kinds: TS_KINDS, containers: TS_CONTAINERS },
  ".js": { wasm: "javascript", kinds: TS_KINDS, containers: TS_CONTAINERS },
  ".mjs": { wasm: "javascript", kinds: TS_KINDS, containers: TS_CONTAINERS },
  ".cjs": { wasm: "javascript", kinds: TS_KINDS, containers: TS_CONTAINERS },
  ".jsx": { wasm: "javascript", kinds: TS_KINDS, containers: TS_CONTAINERS },
  ".py": {
    wasm: "python",
    kinds: {
      function_definition: "?py_function",
      class_definition: "class",
    },
    containers: new Set(["class_definition"]),
  },
  ".go": {
    wasm: "go",
    kinds: {
      function_declaration: "function",
      method_declaration: "method",
      type_spec: "?go_type_spec",
    },
    containers: new Set(),
  },
  ".rs": {
    wasm: "rust",
    kinds: {
      function_item: "?rs_function",
      struct_item: "struct",
      enum_item: "enum",
      trait_item: "trait",
      mod_item: "module",
    },
    containers: new Set(["mod_item", "impl_item", "trait_item"]),
  },
  ".java": {
    wasm: "java",
    kinds: {
      class_declaration: "class",
      interface_declaration: "interface",
      enum_declaration: "enum",
      method_declaration: "method",
    },
    containers: new Set(["class_declaration", "interface_declaration", "enum_declaration"]),
  },
  ".rb": {
    wasm: "ruby",
    kinds: {
      class: "class",
      module: "module",
      method: "?rb_method",
      singleton_method: "method",
    },
    containers: new Set(["class", "module"]),
  },
};

export const SUPPORTED_EXTENSIONS = Object.keys(LANGS);

function wasmDir(): string {
  return join(dirname(require_.resolve("tree-sitter-wasms/package.json")), "out");
}

/** Kinds needing context to resolve (method-vs-function, struct-vs-interface). */
function resolveKind(marker: string, node: Parser.SyntaxNode, insideClass: boolean): string | null {
  switch (marker) {
    case "?variable_declarator": {
      const value = node.childForFieldName("value");
      return value && (value.type === "arrow_function" || value.type === "function_expression")
        ? "function"
        : null; // plain consts/lets are not linkable symbols
    }
    case "?py_function":
    case "?rb_method":
      return insideClass ? "method" : "function";
    case "?rs_function":
      return insideClass ? "method" : "function"; // impl/trait bodies count as class-ish
    case "?go_type_spec": {
      const t = node.childForFieldName("type");
      if (!t) return "type_alias";
      if (t.type === "struct_type") return "struct";
      if (t.type === "interface_type") return "interface";
      return "type_alias";
    }
    default:
      return marker;
  }
}

// @spec: docs/design.md#built-in-symbol-index
export class TreeSitterIndex implements SymbolIndex {
  private byId = new Map<string, Symbol>();
  private byQualified = new Map<string, Symbol>();
  private byName = new Map<string, Symbol>();
  private byFile = new Map<string, Symbol[]>();
  private parsers = new Map<string, Parser>();

  private constructor(private repoRoot: string) {}

  /**
   * Build the index over the given repo-relative files (unsupported
   * extensions are skipped). Parsing is in-memory; nothing is persisted —
   * a full rebuild on a medium repo is well under a second.
   */
  static async create(repoRoot: string, relFiles: string[]): Promise<TreeSitterIndex> {
    await Parser.init();
    const index = new TreeSitterIndex(repoRoot);
    const dir = wasmDir();
    const languages = new Map<string, Parser.Language>();

    for (const rel of relFiles) {
      const spec = LANGS[extname(rel)];
      if (!spec) continue;
      const abs = join(repoRoot, rel);
      if (!existsSync(abs)) continue;

      if (!languages.has(spec.wasm)) {
        languages.set(spec.wasm, await Parser.Language.load(join(dir, `tree-sitter-${spec.wasm}.wasm`)));
      }
      let parser = index.parsers.get(spec.wasm);
      if (!parser) {
        parser = new Parser();
        parser.setLanguage(languages.get(spec.wasm)!);
        index.parsers.set(spec.wasm, parser);
      }
      index.indexFile(rel, readFileSync(abs, "utf8"), parser, spec);
    }
    return index;
  }

  private indexFile(rel: string, source: string, parser: Parser, spec: LangSpec): void {
    const tree = parser.parse(source);
    const symbols: Symbol[] = [];

    const walk = (node: Parser.SyntaxNode, scope: string[], insideClass: boolean) => {
      let nextScope = scope;
      let nextInside = insideClass;
      const kindMarker = spec.kinds[node.type];

      // hasError propagates up from ANY descendant, so only reject nodes
      // whose immediate structure is corrupted (direct ERROR child) — a
      // parse hiccup deep inside a body must not unindex the symbol.
      let directError = false;
      if (kindMarker && node.hasError) {
        for (let i = 0; i < node.childCount; i++) {
          if (node.child(i)!.type === "ERROR") {
            directError = true;
            break;
          }
        }
      }
      if (kindMarker && !directError) {
        const nameNode = node.childForFieldName("name");
        // decorated/exported wrappers don't carry the name; the inner node does
        if (nameNode) {
          const kind = kindMarker.startsWith("?")
            ? resolveKind(kindMarker, node, insideClass)
            : kindMarker;
          if (kind) {
            const name = nameNode.text;
            const qualifiedName = [...scope, name].join("::");
            const sym: Symbol = {
              id: `sym:${rel}#${qualifiedName}`,
              kind,
              name,
              qualifiedName,
              filePath: rel,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              signature: null,
            };
            symbols.push(sym);
            if (spec.containers.has(node.type)) {
              nextScope = [...scope, name];
              nextInside = true;
            }
          }
        }
      } else if (node.type === "impl_item") {
        // Rust impl blocks qualify their methods by the implemented type
        const t = node.childForFieldName("type");
        if (t) {
          nextScope = [...scope, t.text];
          nextInside = true;
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        walk(node.namedChild(i)!, nextScope, nextInside);
      }
    };
    walk(tree.rootNode, [], false);
    tree.delete();

    this.byFile.set(rel, symbols);
    for (const s of symbols) {
      this.byId.set(s.id, s);
      if (!this.byQualified.has(s.qualifiedName)) this.byQualified.set(s.qualifiedName, s);
      if (!this.byName.has(s.name)) this.byName.set(s.name, s);
    }
  }

  findSymbol(nameOrQualified: string): Symbol | null {
    return this.byQualified.get(nameOrQualified) ?? this.byName.get(nameOrQualified) ?? null;
  }

  getSymbolById(id: string): Symbol | null {
    if (id.startsWith("file:")) {
      const path = id.slice("file:".length);
      if (!this.byFile.has(path)) return null;
      return {
        id, kind: "file", name: path, qualifiedName: path,
        filePath: path, startLine: 1, endLine: Number.MAX_SAFE_INTEGER, signature: null,
      };
    }
    return this.byId.get(id) ?? null;
  }

  symbolsInFile(filePath: string): Symbol[] {
    return [...(this.byFile.get(filePath) ?? [])].sort((a, b) => a.startLine - b.startLine);
  }

  listSymbols(kinds?: string[]): Symbol[] {
    const all = [...this.byId.values()];
    const filtered = kinds && kinds.length > 0 ? all.filter((s) => kinds.includes(s.kind)) : all;
    return filtered.sort(
      (a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine,
    );
  }

  containmentChain(symbol: Symbol): Symbol[] {
    const enclosing = this.symbolsInFile(symbol.filePath)
      .filter(
        (s) =>
          s.id !== symbol.id &&
          s.startLine <= symbol.startLine &&
          s.endLine >= symbol.endLine &&
          s.endLine - s.startLine > symbol.endLine - symbol.startLine,
      )
      .sort((a, b) => a.endLine - a.startLine - (b.endLine - b.startLine));
    const fileNode = this.getSymbolById(`file:${symbol.filePath}`);
    return fileNode ? [...enclosing, fileNode] : enclosing;
  }

  readSymbolSource(symbol: Symbol): string | null {
    try {
      const lines = readFileSync(join(this.repoRoot, symbol.filePath), "utf8").split("\n");
      return lines.slice(symbol.startLine - 1, symbol.endLine).join("\n");
    } catch {
      return null;
    }
  }

  /**
   * AST-accurate normalization: parse the snippet, cut every comment node's
   * byte range, then collapse whitespace. String literals containing `//`
   * or `#` survive intact, unlike the regex fallback.
   */
  normalizeSource(source: string, filePath: string): string {
    const spec = LANGS[extname(filePath)];
    const parser = spec ? this.parsers.get(spec.wasm) : undefined;
    if (!parser) return normalizeCode(source);

    const tree = parser.parse(source);
    const cuts: Array<[number, number]> = [];
    const collect = (node: Parser.SyntaxNode) => {
      if (node.type.includes("comment")) {
        cuts.push([node.startIndex, node.endIndex]);
        return;
      }
      for (let i = 0; i < node.childCount; i++) collect(node.child(i)!);
    };
    collect(tree.rootNode);
    tree.delete();

    let out = "";
    let pos = 0;
    for (const [start, end] of cuts.sort((a, b) => a[0] - b[0])) {
      out += source.slice(pos, start);
      pos = end;
    }
    out += source.slice(pos);
    return out.replace(/\s+/g, " ").trim();
  }

  close(): void {
    for (const p of this.parsers.values()) p.delete();
    this.parsers.clear();
  }
}
