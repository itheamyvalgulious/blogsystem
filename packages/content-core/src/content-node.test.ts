import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { resolveContentPath } from "./node.js";

test("resolveContentPath accepts the root itself and paths inside it", () => {
  const root = path.resolve("/tmp/blog-system-content-root");
  assert.equal(resolveContentPath(root, ""), root);
  assert.equal(resolveContentPath(root, "a.md"), path.join(root, "a.md"));
  assert.equal(resolveContentPath(root, "notes/a.md"), path.join(root, "notes", "a.md"));
});

test("resolveContentPath rejects a parent-directory escape via ..", () => {
  const root = path.resolve("/tmp/blog-system-content-root");
  assert.throws(() => resolveContentPath(root, "../sibling/secret.md"), /escapes the content root/);
  assert.throws(
    () => resolveContentPath(root, "notes/../../sibling/secret.md"),
    /escapes the content root/
  );
});

test("resolveContentPath rejects a sibling whose name extends the root basename", () => {
  // The classic prefix-confusion bypass: a contentRoot whose basename is
  // "content" with a sibling directory "content-evil" passes a bare
  // startsWith(root) check, because ".../content-evil/..." still starts with
  // ".../content". The separator-aware containment check must reject it.
  const parent = path.resolve("/tmp/blog-system");
  const root = path.join(parent, "content");
  assert.throws(
    () => resolveContentPath(root, "../content-evil/secret.md"),
    /escapes the content root/
  );
});
