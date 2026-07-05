import { test } from "node:test";
import assert from "node:assert/strict";
import { extractAnchors, slugify } from "../anchors.js";

test("slugify matches GitHub-style slugs", () => {
  assert.equal(slugify("Token Refresh"), "token-refresh");
  assert.equal(slugify("  Login / Logout Flow!  "), "login-logout-flow");
  assert.equal(slugify("日本語の見出し"), "日本語の見出し");
});

test("extracts one anchor per heading with correct body ranges", () => {
  const md = [
    "# Auth",
    "intro",
    "## Login Flow",
    "login body",
    "## Token Refresh",
    "refresh body",
  ].join("\n");
  const anchors = extractAnchors("docs/auth.md", md);
  assert.deepEqual(
    anchors.map((a) => a.id),
    ["docs/auth.md#auth", "docs/auth.md#login-flow", "docs/auth.md#token-refresh"],
  );
  const login = anchors.find((a) => a.slug === "login-flow")!;
  assert.equal(login.startLine, 3);
  assert.equal(login.endLine, 4);
  assert.ok(login.body.includes("login body"));
  assert.ok(!login.body.includes("refresh body"));
  // the h1 section spans the whole document
  const auth = anchors.find((a) => a.slug === "auth")!;
  assert.equal(auth.endLine, 6);
});

test("explicit drift-anchor comment overrides the derived slug", () => {
  const md = [
    "<!-- drift-anchor: custom-name -->",
    "## Some Ambiguous Heading",
    "body",
  ].join("\n");
  const anchors = extractAnchors("docs/x.md", md);
  assert.equal(anchors[0].id, "docs/x.md#custom-name");
});

test("drift-anchor comment only applies immediately above a heading (regression)", () => {
  // Found by dogfooding: prose MENTIONING the comment syntax hijacked the
  // slug of the NEXT section, silently renaming it.
  const md = [
    "## Spec Anchors",
    "Override the slug with `<!-- drift-anchor: name -->` when ambiguous.",
    "more prose",
    "## Annotation Strategy",
    "body",
  ].join("\n");
  const slugs = extractAnchors("docs/d.md", md).map((a) => a.slug);
  assert.deepEqual(slugs, ["spec-anchors", "annotation-strategy"]);
});

test("duplicate headings get -1, -2 suffixes like GitHub", () => {
  const md = ["## Setup", "a", "## Setup", "b", "## Setup", "c"].join("\n");
  const slugs = extractAnchors("docs/x.md", md).map((a) => a.slug);
  assert.deepEqual(slugs, ["setup", "setup-1", "setup-2"]);
});

test("headings inside code fences are ignored", () => {
  const md = ["## Real", "```", "# not a heading", "```", "text"].join("\n");
  const anchors = extractAnchors("docs/x.md", md);
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].slug, "real");
});

test("body hash is stable across trailing-whitespace-only edits", () => {
  const a = extractAnchors("d.md", "## H\nline one\nline two")[0];
  const b = extractAnchors("d.md", "## H\nline one   \nline two  ")[0];
  assert.equal(a.bodyHash, b.bodyHash);
  const c = extractAnchors("d.md", "## H\nline one changed\nline two")[0];
  assert.notEqual(a.bodyHash, c.bodyHash);
});
