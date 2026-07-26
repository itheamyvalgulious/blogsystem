import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { findDocumentWordCompletion, wordPrefixBefore } from "./cm-tab-completion";

describe("wordPrefixBefore", () => {
  it("extracts the word prefix before the caret", () => {
    assert.equal(wordPrefixBefore("hello wor", 9), "wor");
    assert.equal(wordPrefixBefore("  ab", 4), "ab");
    assert.equal(wordPrefixBefore("x", 1), "x");
    assert.equal(wordPrefixBefore("\\begin{al", 9), "al");
    assert.equal(wordPrefixBefore("foo ", 4), "");
  });
});

describe("findDocumentWordCompletion", () => {
  it("completes a single candidate outright", () => {
    assert.equal(findDocumentWordCompletion("abcd xy ab", "ab"), "cd");
  });

  it("extends to the longest common prefix with multiple candidates", () => {
    assert.equal(findDocumentWordCompletion("align align* al", "al"), "ign");
    assert.equal(findDocumentWordCompletion("alpha alpine alps al", "al"), "p");
    assert.equal(findDocumentWordCompletion("alpha album al", "al"), null);
  });

  it("returns null when there are no candidates", () => {
    assert.equal(findDocumentWordCompletion("nothing here", "zzz"), null);
    assert.equal(findDocumentWordCompletion("ab ab", "ab"), null);
    assert.equal(findDocumentWordCompletion("word", ""), null);
  });

  it("ignores candidates that do not extend the prefix", () => {
    assert.equal(findDocumentWordCompletion("abc abc", "abc"), null);
  });

  it("supports unicode words", () => {
    assert.equal(findDocumentWordCompletion("公式推导 公", "公"), "式推导");
  });
});
