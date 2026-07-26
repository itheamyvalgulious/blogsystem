import assert from "node:assert/strict";
import test from "node:test";

import {
  matchesSnippetScope,
  normalizeAiCompletionConfig,
  parseJsoncConfig,
  parseSnippetConfigValue,
  serializeKeybindingConfig,
  serializeSnippetConfig
} from "./editor-config.js";

test("parseSnippetConfigValue supports VS Code object snippets", () => {
  const raw = `{
    // comment
    "divide": {
      "prefix": [
        "/",
        "\\\\frac"
      ],
      "body": "\\\\dfrac{$1}{$2} $0",
    },
    "lim": {
      "prefix": "\\\\lim",
      "body": "\\\\lim_{$1 \\\\to $2} $0"
    }
  }`;

  const parsed = parseSnippetConfigValue(parseJsoncConfig(raw, "latexSnippets"));

  assert.equal(parsed.format, "object");
  assert.equal(parsed.snippets.length, 2);
  assert.equal(parsed.snippets[0].name, "divide");
  assert.deepEqual(parsed.snippets[0].prefix, ["/", "\\frac"]);
  assert.equal(parsed.snippets[1].name, "lim");
});

test("serializeSnippetConfig preserves object snippet shape", () => {
  const raw = serializeSnippetConfig(
    [
      {
        name: "divide",
        prefix: ["/", "\\frac"],
        body: "\\dfrac{$1}{$2} $0"
      }
    ],
    "object"
  );

  assert.match(raw, /"divide": \{/);
  assert.doesNotMatch(raw, /"name": "divide"/);
});

test("serializeKeybindingConfig emits canonical json array", () => {
  const raw = serializeKeybindingConfig([
    {
      key: "ctrl+p",
      command: "workbench.action.showCommands"
    }
  ]);

  assert.match(raw, /"workbench\.action\.showCommands"/);
  assert.match(raw, /^\[/);
});

test("matchesSnippetScope treats markdown and latex aliases as equivalent", () => {
  assert.equal(matchesSnippetScope({ scope: "latex,tex" }, "latex"), true);
  assert.equal(matchesSnippetScope({ scope: "markdown,quarto" }, "markdown"), true);
  assert.equal(matchesSnippetScope({ scope: "markdown" }, "latex"), false);
  assert.equal(matchesSnippetScope({ scope: undefined }, "latex"), true);
});

test("parseSnippetConfigValue accepts string array bodies", () => {
  const parsed = parseSnippetConfigValue([{ name: "env", body: ["\\begin", "\\end"] }]);

  assert.equal(parsed.format, "array");
  assert.equal(parsed.snippets.length, 1);
  assert.deepEqual(parsed.snippets[0].body, ["\\begin", "\\end"]);
});

test("parseSnippetConfigValue rejects array snippets with invalid body", () => {
  assert.throws(
    () =>
      parseSnippetConfigValue([
        { name: "ok", body: "fine" },
        { name: "bad", body: 42 }
      ]),
    /Snippet "bad" body must be a string or an array of strings\./
  );

  assert.throws(
    () => parseSnippetConfigValue([{ name: "bad", body: ["ok", 1] }]),
    /Snippet "bad" body must be a string or an array of strings\./
  );
});

test("parseSnippetConfigValue rejects object snippets that are not objects", () => {
  assert.throws(
    () => parseSnippetConfigValue({ broken: null }),
    /Snippet "broken" must be an object\./
  );

  assert.throws(
    () => parseSnippetConfigValue({ broken: { prefix: "x" } }),
    /Snippet "broken" body must be a string or an array of strings\./
  );
});

test("normalizeAiCompletionConfig fills defaults for missing fields", () => {
  assert.deepEqual(normalizeAiCompletionConfig(undefined), {
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    model: "",
    maxTokens: 128,
    temperature: 0.2
  });

  assert.deepEqual(normalizeAiCompletionConfig({ enabled: true, model: "demo" }), {
    enabled: true,
    baseUrl: "https://api.openai.com/v1",
    model: "demo",
    maxTokens: 128,
    temperature: 0.2
  });
});

test("normalizeAiCompletionConfig drops fields with the wrong type", () => {
  const normalized = normalizeAiCompletionConfig({
    enabled: "yes",
    baseUrl: 42,
    model: null,
    apiKey: 7,
    provider: "gpt",
    maxTokens: "64",
    temperature: "hot"
  });

  assert.deepEqual(normalized, {
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    model: "",
    maxTokens: 128,
    temperature: 0.2
  });
  assert.equal("apiKey" in normalized, false);
  assert.equal("provider" in normalized, false);
});

test("normalizeAiCompletionConfig keeps well-typed optional fields", () => {
  const normalized = normalizeAiCompletionConfig({
    enabled: true,
    baseUrl: "https://llm.example.com/v1",
    model: "demo-model",
    apiKey: "sk-test",
    provider: "anthropic",
    maxTokens: 32,
    temperature: 0.5
  });

  assert.deepEqual(normalized, {
    enabled: true,
    baseUrl: "https://llm.example.com/v1",
    model: "demo-model",
    apiKey: "sk-test",
    provider: "anthropic",
    maxTokens: 32,
    temperature: 0.5
  });
});
