import assert from "node:assert/strict";
import test from "node:test";

import { getSnippetLanguageAtOffset } from "./snippet-context";

test("uses markdown snippets outside math spans", () => {
  const source = "# Title\n\nfrontmatter";
  assert.equal(getSnippetLanguageAtOffset(source, source.length), "markdown");
});

test("uses latex snippets inside inline math spans", () => {
  const source = "Before $alpha + beta";
  assert.equal(getSnippetLanguageAtOffset(source, source.length), "latex");
});

test("uses latex snippets inside math blocks", () => {
  const source = "$$\n\\frac{a}{b}";
  assert.equal(getSnippetLanguageAtOffset(source, source.length), "latex");
});

test("uses latex snippets when cursor is right before closing $ with no gap", () => {
  const source = "$\\alpha$";
  const offset = source.indexOf("$", 1);
  assert.equal(getSnippetLanguageAtOffset(source, offset), "latex");
});

test("ignores dollar signs inside fenced code blocks", () => {
  const source = ["```ts", "const sample = '$$';", "```", "", "frontmatter"].join("\n");
  assert.equal(getSnippetLanguageAtOffset(source, source.length), "markdown");
});
