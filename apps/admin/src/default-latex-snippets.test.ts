import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_LATEX_SNIPPETS } from "./default-latex-snippets";
import { buildNormalizedEditorConfig, emptyConfigPayload } from "./workbench/editor-config";

test("built-in LaTeX completions are slash commands without snippet tabstops", () => {
  assert.ok(DEFAULT_LATEX_SNIPPETS.length > 100);
  assert.ok(
    DEFAULT_LATEX_SNIPPETS.every(
      (snippet) =>
        typeof snippet.prefix === "string" &&
        snippet.prefix.startsWith("\\") &&
        snippet.body === snippet.prefix &&
        !/\$\{?\d/.test(snippet.body)
    )
  );
});

test("built-in LaTeX completions are merged at runtime without changing user config", () => {
  const payload = {
    ...emptyConfigPayload,
    latexSnippets: [
      {
        body: "\\custom",
        name: "custom",
        prefix: "\\custom"
      }
    ]
  };

  const config = buildNormalizedEditorConfig(payload);
  assert.ok(config.latexSnippets.some((snippet) => snippet.name === "latex-alpha"));
  assert.ok(config.latexSnippets.some((snippet) => snippet.name === "custom"));
  assert.equal(payload.latexSnippets.length, 1);
  assert.equal(payload.latexSnippets[0]?.name, "custom");
});
