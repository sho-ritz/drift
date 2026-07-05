import { test } from "node:test";
import assert from "node:assert/strict";
import { coverage } from "../coverage.js";
import { verifyLinks } from "../verify.js";
import { makeFixtureRepo } from "./helpers.js";

test("coverage counts linked vs total by kind and link freshness", (t) => {
  const fx = makeFixtureRepo({
    files: {
      "src/a.ts": "class A {\n  m() {}\n}\nfunction f() {}\nfunction g() {}",
      "docs/a.md": "## Alpha\nbody",
    },
    nodes: [
      { id: "c1", kind: "class", name: "A", qualifiedName: "A", filePath: "src/a.ts", startLine: 1, endLine: 3 },
      { id: "m1", kind: "method", name: "m", qualifiedName: "A::m", filePath: "src/a.ts", startLine: 2, endLine: 2 },
      { id: "f1", kind: "function", name: "f", qualifiedName: "f", filePath: "src/a.ts", startLine: 4, endLine: 4 },
      { id: "f2", kind: "function", name: "g", qualifiedName: "g", filePath: "src/a.ts", startLine: 5, endLine: 5 },
      // non-coverable kind must not count toward the denominator
      { id: "v1", kind: "variable", name: "x", qualifiedName: "x", filePath: "src/a.ts", startLine: 5, endLine: 5 },
    ],
  });
  t.after(() => fx.cleanup());
  fx.engine.indexSpecFile("docs/a.md");
  fx.engine.link("f", "docs/a.md#alpha", "mapping");

  const r = coverage(fx.engine);
  assert.equal(r.totalSymbols, 4);
  assert.equal(r.linkedSymbols, 1);
  assert.equal(r.percent, 25);
  assert.deepEqual(r.byKind["function"], { total: 2, linked: 1 });
  assert.deepEqual(r.byKind["class"], { total: 1, linked: 0 });
  assert.ok(!("variable" in r.byKind));
  assert.deepEqual(r.links, { total: 1, fresh: 1, stale: 0, broken: 0 });
});

test("verify returns [] without touching the network when nothing is stale", async (t) => {
  const fx = makeFixtureRepo({
    files: { "src/a.ts": "function f() {}", "docs/a.md": "## Alpha\nbody" },
    nodes: [
      { id: "f1", kind: "function", name: "f", qualifiedName: "f", filePath: "src/a.ts", startLine: 1, endLine: 1 },
    ],
  });
  t.after(() => fx.cleanup());
  fx.engine.indexSpecFile("docs/a.md");
  fx.engine.link("f", "docs/a.md#alpha", "mapping");

  const results = await verifyLinks(fx.engine, fx.engine.evaluateAll());
  assert.deepEqual(results, []);
});
