import { test } from "node:test";
import assert from "node:assert/strict";
import { makeFixtureRepo, type FixtureRepo } from "./helpers.js";

const AUTH_TS = [
  "class AuthService {", // 1
  "  login(user) {", // 2
  "    return token(user);", // 3
  "  }", // 4
  "  refresh(t) {", // 5
  "    return renew(t);", // 6
  "  }", // 7
  "}", // 8
].join("\n");

const AUTH_MD = [
  "# Auth",
  "overview",
  "## Login Flow",
  "login must return a session token",
  "## Token Refresh",
  "refresh renews the token",
].join("\n");

function authFixture(): FixtureRepo {
  return makeFixtureRepo({
    files: { "src/auth.ts": AUTH_TS, "docs/auth.md": AUTH_MD },
    nodes: [
      {
        id: "c1", kind: "class", name: "AuthService", qualifiedName: "AuthService",
        filePath: "src/auth.ts", startLine: 1, endLine: 8,
      },
      {
        id: "m1", kind: "method", name: "login", qualifiedName: "AuthService::login",
        filePath: "src/auth.ts", startLine: 2, endLine: 4,
      },
      {
        id: "m2", kind: "method", name: "refresh", qualifiedName: "AuthService::refresh",
        filePath: "src/auth.ts", startLine: 5, endLine: 7,
      },
    ],
  });
}

test("link → fresh → code edit → stale(code) → approve → fresh", (t) => {
  const fx = authFixture();
  t.after(() => fx.cleanup());
  fx.engine.indexSpecFile("docs/auth.md");

  const link = fx.engine.link("AuthService::login", "docs/auth.md#login-flow", "annotation");
  assert.equal(fx.engine.evaluateLink(link).status, "fresh");

  // indentation / comment-only reformat must NOT flag stale
  fx.write(
    "src/auth.ts",
    AUTH_TS.replace("    return token(user);", "        return token(user); // reindent"),
  );
  assert.equal(fx.engine.evaluateLink(link).status, "fresh");

  // real change flags the code side
  fx.write("src/auth.ts", AUTH_TS.replace("token(user)", "token(admin)"));
  const stale = fx.engine.evaluateLink(link);
  assert.equal(stale.status, "stale");
  assert.deepEqual(stale.drift, { symbol: true, anchor: false });

  const approved = fx.engine.approve(link.id, "tester");
  assert.equal(approved.status, "fresh");
});

test("spec edit flags the anchor side", (t) => {
  const fx = authFixture();
  t.after(() => fx.cleanup());
  fx.engine.indexSpecFile("docs/auth.md");
  const link = fx.engine.link("AuthService::login", "docs/auth.md#login-flow", "annotation");

  fx.write("docs/auth.md", AUTH_MD.replace("session token", "refresh token pair"));
  fx.engine.indexSpecFile("docs/auth.md");

  const ev = fx.engine.evaluateLink(fx.engine.store.getLink(link.id)!);
  assert.equal(ev.status, "stale");
  assert.deepEqual(ev.drift, { symbol: false, anchor: true });
});

test("removed anchor breaks the link and approve refuses", (t) => {
  const fx = authFixture();
  t.after(() => fx.cleanup());
  fx.engine.indexSpecFile("docs/auth.md");
  const link = fx.engine.link("AuthService::login", "docs/auth.md#login-flow", "annotation");

  fx.write("docs/auth.md", "# Auth\nonly intro left");
  fx.engine.indexSpecFile("docs/auth.md");

  const ev = fx.engine.evaluateLink(fx.engine.store.getLink(link.id)!);
  assert.equal(ev.status, "broken");
  assert.equal(ev.missing.anchor, true);
  assert.throws(() => fx.engine.approve(link.id), /broken/);
});

test("specContext falls back to the enclosing class with inferred: true", (t) => {
  const fx = authFixture();
  t.after(() => fx.cleanup());
  fx.engine.indexSpecFile("docs/auth.md");
  fx.engine.link("AuthService", "docs/auth.md#auth", "mapping");

  const ctx = fx.engine.specContext("AuthService::refresh");
  assert.ok(ctx);
  assert.equal(ctx!.inferred, true);
  assert.equal(ctx!.resolvedSymbol, "AuthService");
  assert.equal(ctx!.entries.length, 1);
  assert.equal(ctx!.freshness.total, 1);
});

test("specContext prefers direct links (inferred: false)", (t) => {
  const fx = authFixture();
  t.after(() => fx.cleanup());
  fx.engine.indexSpecFile("docs/auth.md");
  fx.engine.link("AuthService", "docs/auth.md#auth", "mapping");
  fx.engine.link("AuthService::login", "docs/auth.md#login-flow", "annotation");

  const ctx = fx.engine.specContext("AuthService::login")!;
  assert.equal(ctx.inferred, false);
  assert.equal(ctx.entries[0].anchorId, "docs/auth.md#login-flow");
});

test("codeForSpec returns linkId, heading and status for anchor and whole file", (t) => {
  const fx = authFixture();
  t.after(() => fx.cleanup());
  fx.engine.indexSpecFile("docs/auth.md");
  const l1 = fx.engine.link("AuthService::login", "docs/auth.md#login-flow", "annotation");
  fx.engine.link("AuthService::refresh", "docs/auth.md#token-refresh", "annotation");

  const one = fx.engine.codeForSpec("docs/auth.md#login-flow");
  assert.equal(one.length, 1);
  assert.equal(one[0].linkId, l1.id);
  assert.equal(one[0].heading, "Login Flow");
  assert.equal(one[0].status, "fresh");

  const all = fx.engine.codeForSpec("docs/auth.md");
  assert.equal(all.length, 2);
});

test("evaluateForChangedFiles scopes to touched files and dedupes", (t) => {
  const fx = authFixture();
  t.after(() => fx.cleanup());
  fx.engine.indexSpecFile("docs/auth.md");
  fx.engine.link("AuthService::login", "docs/auth.md#login-flow", "annotation");
  fx.engine.link("AuthService::refresh", "docs/auth.md#token-refresh", "annotation");

  // touching both the code file and the doc must not duplicate links
  const evals = fx.engine.evaluateForChangedFiles(["src/auth.ts", "docs/auth.md"]);
  assert.equal(evals.length, 2);

  assert.equal(fx.engine.evaluateForChangedFiles(["src/unrelated.ts"]).length, 0);
});

test("re-linking an existing pair re-pins hashes instead of duplicating", (t) => {
  const fx = authFixture();
  t.after(() => fx.cleanup());
  fx.engine.indexSpecFile("docs/auth.md");
  const first = fx.engine.link("AuthService::login", "docs/auth.md#login-flow", "annotation");
  fx.write("src/auth.ts", AUTH_TS.replace("token(user)", "token(admin)"));
  const second = fx.engine.link("AuthService::login", "docs/auth.md#login-flow", "annotation");
  assert.equal(first.id, second.id);
  assert.equal(fx.engine.evaluateLink(second).status, "fresh");
  assert.equal(fx.engine.store.allLinks().length, 1);
});
