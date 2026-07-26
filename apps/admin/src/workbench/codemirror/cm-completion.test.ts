import assert from "node:assert/strict";
import test from "node:test";

import type { ArticleSummary } from "@blog-system/content-core";

import type { SnippetCompletionMatch } from "../../snippet-completion";
import type { NormalizedSnippet } from "../types";
import {
  buildNoteReferenceOptions,
  buildSnippetCompletionOptions
} from "./cm-completion";

function makeSnippet(name: string, prefix: string[], body: string | string[] = "body"): NormalizedSnippet {
  return { body, environment: "markdown", name, prefix };
}

function makeMatch(
  name: string,
  prefix: string,
  replacementText: string,
  body: string | string[] = "body"
): SnippetCompletionMatch {
  return {
    carryOver: false,
    prefix,
    replacementText,
    snippet: makeSnippet(name, [prefix], body)
  };
}

function makeArticle(title: string, path: string): ArticleSummary {
  return { path, title } as ArticleSummary;
}

test("buildSnippetCompletionOptions orders like the Monaco sortText", () => {
  // Monaco sortText: 0-${9999 - replacementText.length}-${prefix.length}-${prefix}
  // → longest replacement first, then shortest prefix, then alphabetical.
  const options = buildSnippetCompletionOptions([
    makeMatch("short", "\\a", "\\a"),
    makeMatch("long-replacement", "\\alpha", "\\al"),
    makeMatch("longer-prefix", "\\alpha", "\\a"),
    makeMatch("b-prefix", "bb", "bb"),
    makeMatch("a-prefix", "aa", "aa")
  ]);

  assert.deepEqual(
    options.map((option) => option.label),
    ["long-replacement", "short", "a-prefix", "b-prefix", "longer-prefix"]
  );
});

test("buildSnippetCompletionOptions maps match fields to completion shape", () => {
  const [option] = buildSnippetCompletionOptions([
    makeMatch("alpha", "\\alpha", "\\al", "\\alpha")
  ]);

  assert.equal(option.label, "alpha");
  assert.equal(option.detail, "\\alpha");
  assert.equal(option.type, "snippet");
  // Per-match replacement range: applied relative to the range end.
  assert.equal(typeof option.apply, "function");
});

test("buildSnippetCompletionOptions does not mutate the input order", () => {
  const matches = [makeMatch("b", "bb", "bb"), makeMatch("a", "aa", "aa")];
  buildSnippetCompletionOptions(matches);
  assert.deepEqual(
    matches.map((match) => match.snippet.name),
    ["b", "a"]
  );
});

test("buildNoteReferenceOptions filters and shapes @note references", () => {
  const articles = [makeArticle("Beta Post", "posts/beta.md"), makeArticle("Alpha", "posts/alpha.md")];
  const options = buildNoteReferenceOptions("alp", articles);

  assert.equal(options.length, 1);
  assert.deepEqual(options[0], {
    apply: "@note/Alpha ",
    detail: "posts/alpha.md",
    label: "Alpha",
    type: "reference"
  });
});

test("buildNoteReferenceOptions matches paths and keeps suggestion order", () => {
  const articles = [makeArticle("Gamma", "notes/gamma.md"), makeArticle("Beta", "notes/beta.md")];
  const options = buildNoteReferenceOptions("notes/", articles);

  assert.deepEqual(
    options.map((option) => option.label),
    ["Beta", "Gamma"]
  );
  assert.ok(options.every((option) => option.type === "reference"));
});
