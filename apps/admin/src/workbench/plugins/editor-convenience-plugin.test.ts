import assert from "node:assert/strict";
import test from "node:test";

import {
  getListContinuationPrefix,
  getOrderedListRenumberEdits,
  renumberOrderedLists
} from "./editor-convenience-plugin";

test("ordered Enter continuation increments the current number", () => {
  assert.equal(getListContinuationPrefix("1. first item"), "2. ");
  assert.equal(getListContinuationPrefix("2. second item"), "3. ");
  assert.equal(getListContinuationPrefix("  9. indented item"), "  10. ");
});

test("Enter keeps unordered markers and leaves an empty item alone", () => {
  assert.equal(getListContinuationPrefix("- item"), "- ");
  assert.equal(getListContinuationPrefix("  * item"), "  * ");
  assert.equal(getListContinuationPrefix("1. "), null);
  assert.equal(getListContinuationPrefix("+"), null);
});

test("renumbering preserves each block's first number and line endings", () => {
  const source = "4. first\r\n9. second\r\n10. third\r\n\r\n7. another block\r\n12. next";
  const expected = "4. first\r\n5. second\r\n6. third\r\n\r\n7. another block\r\n8. next";

  assert.equal(renumberOrderedLists(source), expected);
});

test("renumber edits only the number prefix", () => {
  assert.deepEqual(
    getOrderedListRenumberEdits("4. first\n10. second\n14. third"),
    [
      { endColumn: 3, lineNumber: 2, startColumn: 1, text: "5" },
      { endColumn: 3, lineNumber: 3, startColumn: 1, text: "6" }
    ]
  );
});

test("nested ordered lists are renumbered independently of their parent", () => {
  const source = [
    "1. outer one",
    "  7. nested one",
    "  11. nested two",
    "8. outer two",
    "9. outer three"
  ].join("\n");
  const expected = [
    "1. outer one",
    "  7. nested one",
    "  8. nested two",
    "2. outer two",
    "3. outer three"
  ].join("\n");

  assert.equal(renumberOrderedLists(source), expected);
});

test("unordered and differently indented items are not mixed into a block", () => {
  const source = [
    "1. first",
    "- unordered item",
    "8. second block",
    "12. third block",
    "  3. nested first",
    "  9. nested second",
    "15. final top-level item"
  ].join("\n");
  const expected = [
    "1. first",
    "- unordered item",
    "8. second block",
    "9. third block",
    "  3. nested first",
    "  4. nested second",
    "10. final top-level item"
  ].join("\n");

  assert.equal(renumberOrderedLists(source), expected);
});

test("deleting or inserting an item is repaired by the same normalization", () => {
  assert.equal(
    renumberOrderedLists("1. first\n3. item after a deletion"),
    "1. first\n2. item after a deletion"
  );
  assert.equal(
    renumberOrderedLists("1. first\n2. inserted\n6. final"),
    "1. first\n2. inserted\n3. final"
  );
});
