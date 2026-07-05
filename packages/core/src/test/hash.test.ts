import { test } from "node:test";
import assert from "node:assert/strict";
import { hashCode, hashSpecText, normalizeCode, normalizeSpecText } from "../hash.js";

test("code hash ignores comments and whitespace-only reformatting", () => {
  const a = `function login(user) {\n  return token(user);\n}`;
  const b = `// entry point\nfunction login(user) {\n    /* verbose */\n    return token(user);\n}`;
  const c = `function   login(user)  {  return token(user);  }`;
  assert.equal(hashCode(a), hashCode(b));
  assert.equal(hashCode(a), hashCode(c));
});

test("code hash changes on a real code change", () => {
  assert.notEqual(
    hashCode(`return token(user);`),
    hashCode(`return token(admin);`),
  );
});

test("python-style comments are stripped", () => {
  assert.equal(
    normalizeCode(`def f():  # docs\n    return 1`),
    normalizeCode(`def f():\n    return 1`),
  );
});

test("spec hash ignores trailing whitespace and blank-line runs", () => {
  const a = "line one\nline two";
  const b = "line one   \n\n\n\nline two  \n";
  // normalizeSpecText collapses 3+ newlines to 2, so add matching blank line
  assert.equal(hashSpecText("line one\n\nline two"), hashSpecText(b));
  assert.notEqual(hashSpecText(a), hashSpecText("line one\nline 2"));
});

test("normalizeSpecText trims and collapses", () => {
  assert.equal(normalizeSpecText("  \na\n\n\n\nb\n  "), "a\n\nb");
});
