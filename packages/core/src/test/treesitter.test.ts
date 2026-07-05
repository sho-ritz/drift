import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { TreeSitterIndex } from "../treesitter.js";
import { DriftEngine } from "../engine.js";
import { DriftStore } from "../store.js";

function makeRepo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "drift-ts-"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

const AUTH_TS = `type Opts = { user: string };
export class AuthService {
  async login(opts: Opts) {
    return "token";
  }
}
export function refreshToken(t: string) {
  return t + "!";
}
export const namedArrow = (y: number) => y + 1;
const plainConst = 42;
`;

test("builtin index extracts TS symbols with kinds and qualified names", async (t) => {
  const root = makeRepo({ "src/auth.ts": AUTH_TS });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const idx = await TreeSitterIndex.create(root, ["src/auth.ts"]);
  t.after(() => idx.close());

  const byName = Object.fromEntries(
    idx.symbolsInFile("src/auth.ts").map((s) => [s.qualifiedName, s]),
  );
  assert.equal(byName["AuthService"].kind, "class");
  assert.equal(byName["AuthService::login"].kind, "method");
  assert.equal(byName["refreshToken"].kind, "function");
  assert.equal(byName["namedArrow"].kind, "function"); // arrow const IS linkable
  assert.ok(!byName["plainConst"], "plain consts are not symbols");
  assert.ok(!byName["Opts"] || byName["Opts"].kind === "type_alias");

  // lookup by bare and qualified name
  assert.equal(idx.findSymbol("AuthService::login")!.startLine, 3);
  assert.equal(idx.findSymbol("login")!.qualifiedName, "AuthService::login");

  // containment: method -> class -> file
  const chain = idx.containmentChain(idx.findSymbol("AuthService::login")!);
  assert.equal(chain[0].qualifiedName, "AuthService");
  assert.equal(chain[chain.length - 1].kind, "file");
});

test("builtin index parses python with method/function distinction", async (t) => {
  const root = makeRepo({
    "app.py": `class Auth:\n    def login(self):\n        return 1\n\ndef helper():\n    return 2\n`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const idx = await TreeSitterIndex.create(root, ["app.py"]);
  t.after(() => idx.close());

  assert.equal(idx.findSymbol("Auth")!.kind, "class");
  assert.equal(idx.findSymbol("Auth::login")!.kind, "method");
  assert.equal(idx.findSymbol("helper")!.kind, "function");
});

test("AST normalization strips comments but never string contents", async (t) => {
  const root = makeRepo({ "src/x.ts": "export function f() {}" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const idx = await TreeSitterIndex.create(root, ["src/x.ts"]);
  t.after(() => idx.close());

  const a = idx.normalizeSource(
    `function f() {\n  const url = "http://x.com";\n  return url;\n}`,
    "src/x.ts",
  );
  const b = idx.normalizeSource(
    `// leading comment\nfunction f() {\n  /* block */ const url = "http://x.com";\n  return url; // trailing\n}`,
    "src/x.ts",
  );
  assert.equal(a, b);
  assert.ok(a.includes(`"http://x.com"`), "the // inside the string must survive");
});

test("corrupted parse regions never produce bogus symbols", async (t) => {
  // A regex literal starting with <!-- trips tree-sitter's html-comment
  // lexing and swallows following code into an ERROR region (found by
  // dogfooding on anchors.ts). The guarantee: drift must not index a bogus
  // symbol out of the wreckage (e.g. `RE` as a function spanning the file).
  const root = makeRepo({
    "src/broken.ts": `const RE = /<!--x-->/;\nexport function swallowed() {\n  return 1;\n}\nexport function after() { return 2; }\n`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const idx = await TreeSitterIndex.create(root, ["src/broken.ts"]);
  t.after(() => idx.close());

  const bogus = idx.symbolsInFile("src/broken.ts").find((s) => s.name === "RE");
  assert.equal(bogus, undefined, "the corrupted declarator must not become a symbol");
});

test("errors in one statement do not unindex sibling symbols", async (t) => {
  // a clean syntax error (not the html-comment lexer trap): the broken
  // statement is contained, so surrounding declarations stay indexed
  const root = makeRepo({
    "src/partial.ts": `export function before() { return 1; }\nconst broken = ;\nexport function after() { return 2; }\n`,
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const idx = await TreeSitterIndex.create(root, ["src/partial.ts"]);
  t.after(() => idx.close());

  const names = idx.symbolsInFile("src/partial.ts").map((s) => s.name);
  assert.ok(names.includes("before"), `expected before in ${JSON.stringify(names)}`);
  assert.ok(names.includes("after"), `expected after in ${JSON.stringify(names)}`);
});

test("integration: rename is detected as moved and repaired by relink", async (t) => {
  const root = makeRepo({
    "src/auth.ts": AUTH_TS,
    "docs/auth.md": "## Token Refresh\nThe refresh call renews sessions.",
  });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const store = new DriftStore(join(root, ".drift", "drift.db"));
  let idx = await TreeSitterIndex.create(root, ["src/auth.ts"]);
  let engine = new DriftEngine(idx, store, root);
  engine.indexSpecFile("docs/auth.md");
  const link = engine.link("refreshToken", "docs/auth.md#token-refresh", "annotation");
  assert.equal(engine.evaluateLink(link).status, "fresh");

  // rename the symbol (self-contained body change: name appears in decl only)
  writeFileSync(
    join(root, "src/auth.ts"),
    AUTH_TS.replace("export function refreshToken(", "export function renewToken("),
  );
  idx.close();
  idx = await TreeSitterIndex.create(root, ["src/auth.ts"]);
  engine = new DriftEngine(idx, store, root);

  const ev = engine.evaluateLink(store.getLink(link.id)!);
  assert.equal(ev.status, "broken");
  assert.equal(ev.movedTo?.symbol, "renewToken");

  const repaired = engine.relink(link.id, undefined, "tester");
  assert.equal(repaired.status, "fresh");
  assert.equal(repaired.link.symbolQualifiedName, "renewToken");

  idx.close();
  store.close();
});
