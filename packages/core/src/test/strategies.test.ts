import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scanAnnotations, loadMappingFile, syncDeclarations } from "../strategies.js";
import { makeFixtureRepo } from "./helpers.js";

test("annotation binds past an interposed type alias to the function (regression)", (t) => {
  // The bug found in the field: `// @spec:` above `type ProjectCardProps = ...`
  // followed by the component silently linked to the type alias.
  const code = [
    "// @spec" + ": docs/ui.md#project-card", // line 1
    "type ProjectCardProps = { id: string };", // line 2
    "export function ProjectCard(props: ProjectCardProps) {", // line 3
    "  return null;",
    "}",
  ].join("\n");
  const fx = makeFixtureRepo({
    files: { "src/card.tsx": code },
    nodes: [
      {
        id: "n1", kind: "type_alias", name: "ProjectCardProps",
        qualifiedName: "ProjectCardProps", filePath: "src/card.tsx",
        startLine: 2, endLine: 2,
      },
      {
        id: "n2", kind: "function", name: "ProjectCard",
        qualifiedName: "ProjectCard", filePath: "src/card.tsx",
        startLine: 3, endLine: 5,
      },
    ],
  });
  t.after(() => fx.cleanup());

  const scan = scanAnnotations(fx.engine, ["src/card.tsx"]);
  assert.equal(scan.declarations.length, 1);
  assert.equal(scan.declarations[0].symbol, "ProjectCard");
  // the skip is surfaced, not silent
  assert.ok(scan.warnings.some((w) => /skipped type_alias 'ProjectCardProps'/.test(w)));
});

test("annotation binding to a non-linkable kind warns instead of passing silently", (t) => {
  const code = [
    "// @spec" + ": docs/ui.md#projects",
    "const projects = [];",
  ].join("\n");
  const fx = makeFixtureRepo({
    files: { "src/data.ts": code },
    nodes: [
      {
        id: "n1", kind: "variable", name: "projects",
        qualifiedName: "projects", filePath: "src/data.ts",
        startLine: 2, endLine: 2,
      },
    ],
  });
  t.after(() => fx.cleanup());

  const scan = scanAnnotations(fx.engine, ["src/data.ts"]);
  assert.equal(scan.declarations.length, 1); // still binds…
  assert.ok(
    scan.warnings.some((w) => /binds to variable 'projects'/.test(w)),
    `expected a kind warning, got: ${JSON.stringify(scan.warnings)}`,
  );
});

test("annotation far above its symbol warns about the distance", (t) => {
  const lines = ["// @spec" + ": docs/a.md#x"];
  for (let i = 0; i < 10; i++) lines.push("");
  lines.push("function far() {}");
  const fx = makeFixtureRepo({
    files: { "src/far.ts": lines.join("\n") },
    nodes: [
      {
        id: "n1", kind: "function", name: "far", qualifiedName: "far",
        filePath: "src/far.ts", startLine: 12, endLine: 12,
      },
    ],
  });
  t.after(() => fx.cleanup());

  const scan = scanAnnotations(fx.engine, ["src/far.ts"]);
  assert.equal(scan.declarations.length, 1);
  assert.ok(scan.warnings.some((w) => /lines above/.test(w)));
});

test("annotation with no symbol below it warns and is ignored", (t) => {
  const code = ["function f() {}", "// @spec" + ": docs/a.md#x  (trailing, nothing below)"].join("\n");
  const fx = makeFixtureRepo({
    files: { "src/t.ts": code },
    nodes: [
      {
        id: "n1", kind: "function", name: "f", qualifiedName: "f",
        filePath: "src/t.ts", startLine: 1, endLine: 1,
      },
    ],
  });
  t.after(() => fx.cleanup());

  const scan = scanAnnotations(fx.engine, ["src/t.ts"]);
  assert.equal(scan.declarations.length, 0);
  assert.ok(scan.warnings.some((w) => /no symbol below/.test(w)));
});

test("annotations in a file CodeGraph has not indexed warn", (t) => {
  const fx = makeFixtureRepo({
    files: { "src/new.ts": "// @spec" + ": docs/a.md#x\nfunction f() {}" },
    nodes: [], // file exists on disk but not in the index
  });
  t.after(() => fx.cleanup());

  const scan = scanAnnotations(fx.engine, ["src/new.ts"]);
  assert.equal(scan.declarations.length, 0);
  assert.ok(scan.warnings.some((w) => /no symbols in CodeGraph/.test(w)));
});

test("scannedFiles counts files actually read", (t) => {
  const fx = makeFixtureRepo({
    files: { "src/a.ts": "function a() {}" },
    nodes: [
      {
        id: "n1", kind: "function", name: "a", qualifiedName: "a",
        filePath: "src/a.ts", startLine: 1, endLine: 1,
      },
    ],
  });
  t.after(() => fx.cleanup());
  const scan = scanAnnotations(fx.engine, ["src/a.ts", "src/missing.ts"]);
  assert.equal(scan.scannedFiles, 1);
});

test("mapping file loads and syncDeclarations is idempotent", (t) => {
  const fx = makeFixtureRepo({
    files: {
      "src/auth.ts": "function login() {\n  return 1;\n}",
      "docs/auth.md": "## Login Flow\nhow login works",
    },
    nodes: [
      {
        id: "n1", kind: "function", name: "login", qualifiedName: "login",
        filePath: "src/auth.ts", startLine: 1, endLine: 3,
      },
    ],
  });
  t.after(() => fx.cleanup());
  fx.engine.indexSpecFile("docs/auth.md");

  writeFileSync(
    join(fx.root, ".drift", "links.json"),
    JSON.stringify([{ symbol: "login", spec: "docs/auth.md#login-flow" }]),
  );
  const decls = loadMappingFile(fx.root);
  assert.equal(decls.length, 1);
  assert.equal(decls[0].origin, "mapping");

  const first = syncDeclarations(fx.engine, decls);
  assert.deepEqual([first.created, first.kept, first.errors.length], [1, 0, 0]);
  const second = syncDeclarations(fx.engine, decls);
  assert.deepEqual([second.created, second.kept], [0, 1]);
});

test("unknown symbols in declarations are reported as errors", (t) => {
  const fx = makeFixtureRepo({
    files: { "docs/a.md": "## X\nbody" },
    nodes: [],
  });
  t.after(() => fx.cleanup());
  fx.engine.indexSpecFile("docs/a.md");
  const r = syncDeclarations(fx.engine, [
    { symbol: "ghost", anchorId: "docs/a.md#x", origin: "mapping", sourceFile: "m", line: 1 },
  ]);
  assert.equal(r.created, 0);
  assert.ok(r.errors[0].includes("symbol not found"));
});
