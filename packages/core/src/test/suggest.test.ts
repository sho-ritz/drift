import { test } from "node:test";
import assert from "node:assert/strict";
import { nameToSlug, suggestLinks, applySuggestions } from "../suggest.js";
import { makeFixtureRepo, type FixtureRepo } from "./helpers.js";

test("nameToSlug handles camelCase, PascalCase, acronyms, snake_case", () => {
  assert.equal(nameToSlug("refreshToken"), "refresh-token");
  assert.equal(nameToSlug("AuthService"), "auth-service");
  assert.equal(nameToSlug("HTTPServer"), "http-server");
  assert.equal(nameToSlug("snake_case_name"), "snake-case-name");
});

const DOC = [
  "# Auth",
  "overview text",
  "## Token Refresh",
  "The `refreshToken` method renews the session.",
  "## Login Flow",
  "Users authenticate with a password.",
  "## Password Hashing",
  "We use the hashPassword helper before storage.",
].join("\n");

function fixture(): FixtureRepo {
  const fx = makeFixtureRepo({
    files: {
      "docs/auth.md": DOC,
      "src/auth.ts": [
        "function refreshToken() {}", // 1
        "function loginFlow() {}", // 2
        "function hashPassword() {}", // 3
        "function main() {}", // 4
        "const passwordRules = 1;", // 5
      ].join("\n"),
    },
    nodes: [
      { id: "s1", kind: "function", name: "refreshToken", qualifiedName: "refreshToken", filePath: "src/auth.ts", startLine: 1, endLine: 1 },
      { id: "s2", kind: "function", name: "loginFlow", qualifiedName: "loginFlow", filePath: "src/auth.ts", startLine: 2, endLine: 2 },
      { id: "s3", kind: "function", name: "hashPassword", qualifiedName: "hashPassword", filePath: "src/auth.ts", startLine: 3, endLine: 3 },
      { id: "s4", kind: "function", name: "main", qualifiedName: "main", filePath: "src/auth.ts", startLine: 4, endLine: 4 },
      // non-suggestible kind must be excluded entirely
      { id: "s5", kind: "variable", name: "passwordRules", qualifiedName: "passwordRules", filePath: "src/auth.ts", startLine: 5, endLine: 5 },
    ],
  });
  fx.engine.indexSpecFile("docs/auth.md");
  return fx;
}

test("code-span mention and slug match rank high; bare mention ranks medium", (t) => {
  const fx = fixture();
  t.after(() => fx.cleanup());

  const s = suggestLinks(fx.engine);
  const byPair = (sym: string, anchor: string) =>
    s.find((x) => x.symbol === sym && x.anchorId === anchor);

  // `refreshToken` in a code span → high
  const codeSpan = byPair("refreshToken", "docs/auth.md#token-refresh");
  assert.ok(codeSpan, "expected refreshToken suggestion");
  assert.equal(codeSpan!.confidence, "high");

  // heading "Login Flow" slug === nameToSlug(loginFlow) → high
  const slug = byPair("loginFlow", "docs/auth.md#login-flow");
  assert.ok(slug, "expected loginFlow suggestion");
  assert.equal(slug!.confidence, "high");

  // bare-word body mention → medium
  const bare = byPair("hashPassword", "docs/auth.md#password-hashing");
  assert.ok(bare, "expected hashPassword suggestion");
  assert.equal(bare!.confidence, "medium");

  // short generic names never match bare words
  assert.ok(!s.some((x) => x.symbol === "main"));
  // non-suggestible kinds are excluded
  assert.ok(!s.some((x) => x.symbol === "passwordRules"));
  // high confidence sorts before medium
  const confidences = s.map((x) => x.confidence);
  assert.deepEqual(confidences, [...confidences].sort((a, b) => (a === b ? 0 : a === "high" ? -1 : 1)));
});

test("minConfidence: 'high' filters out medium candidates", (t) => {
  const fx = fixture();
  t.after(() => fx.cleanup());
  const s = suggestLinks(fx.engine, { minConfidence: "high" });
  assert.ok(s.length > 0);
  assert.ok(s.every((x) => x.confidence === "high"));
});

test("already-linked pairs are not re-suggested; apply creates ai-suggested links", (t) => {
  const fx = fixture();
  t.after(() => fx.cleanup());

  const before = suggestLinks(fx.engine);
  const r = applySuggestions(fx.engine, before, "tester");
  assert.equal(r.created, before.length);
  assert.deepEqual(r.errors, []);

  const links = fx.engine.store.allLinks();
  assert.equal(links.length, before.length);
  assert.ok(links.every((l) => l.origin === "ai-suggested"));

  // second pass proposes nothing new
  assert.deepEqual(suggestLinks(fx.engine), []);
});
