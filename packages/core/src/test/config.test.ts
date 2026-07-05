import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, validateConfig } from "../config.js";
import type { DriftConfig } from "../types.js";

function withRepo(fn: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), "drift-config-"));
  try {
    fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function cfg(overrides: Partial<DriftConfig>): DriftConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

test('docsDir "." is rejected as an error (would index node_modules)', () => {
  withRepo((root) => {
    for (const dir of [".", "", "./"]) {
      const errors = validateConfig(root, cfg({ docsDir: dir })).filter(
        (i) => i.severity === "error",
      );
      assert.equal(errors.length, 1, `docsDir "${dir}" should error`);
      assert.equal(errors[0].field, "docsDir");
    }
  });
});

test("absolute and escaping docsDir are errors", () => {
  withRepo((root) => {
    assert.ok(
      validateConfig(root, cfg({ docsDir: "/etc/docs" })).some((i) => i.severity === "error"),
    );
    assert.ok(
      validateConfig(root, cfg({ docsDir: "../other/docs" })).some(
        (i) => i.severity === "error",
      ),
    );
  });
});

test("docsDir inside node_modules warns", () => {
  withRepo((root) => {
    const issues = validateConfig(root, cfg({ docsDir: "node_modules/pkg/docs" }));
    assert.ok(issues.some((i) => i.severity === "warning" && /node_modules/.test(i.message)));
  });
});

test("missing docsDir warns, existing docsDir is clean", () => {
  withRepo((root) => {
    const missing = validateConfig(root, cfg({ docsDir: "docs" }));
    assert.ok(missing.some((i) => i.severity === "warning" && /does not exist/.test(i.message)));

    mkdirSync(join(root, "docs"));
    assert.deepEqual(validateConfig(root, cfg({ docsDir: "docs" })), []);
  });
});

test("unknown strategies and agents warn", () => {
  withRepo((root) => {
    mkdirSync(join(root, "docs"));
    const issues = validateConfig(
      root,
      cfg({
        strategies: ["annotation", "telepathy" as never],
        agents: ["claude-code", "clippy" as never],
      }),
    );
    assert.equal(issues.filter((i) => i.field === "strategies").length, 1);
    assert.equal(issues.filter((i) => i.field === "agents").length, 1);
    assert.ok(issues.every((i) => i.severity === "warning"));
  });
});
