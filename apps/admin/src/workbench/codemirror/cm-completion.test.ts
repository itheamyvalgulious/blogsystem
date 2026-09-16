import assert from "node:assert/strict";
import test from "node:test";

import { CompletionContext } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import type { ArticleSummary } from "@blog-system/content-core";

import type { SnippetCompletionMatch } from "../../snippet-completion";
import type { NormalizedSnippet, WorkbenchDocument } from "../types";
import {
  buildNoteReferenceOptions,
  buildSnippetCompletionOptions,
  createCmCompletionExtension,
  workbenchCompletionSource
} from "./cm-completion";
import { setWorkbenchCompletionContext } from "./cm-context";
import { cmSnippetExtension, getCmSnippetState } from "./cm-snippets";

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

test("inline dollar snippet replaces the trigger and types into $1", () => {
  const [option] = buildSnippetCompletionOptions([
    makeMatch("inline latex", "$", "$", " $$1$ $0")
  ]);
  let state = EditorState.create({
    doc: "$",
    extensions: [cmSnippetExtension],
    selection: { anchor: 1 }
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    }
  } as unknown as EditorView;

  if (typeof option.apply !== "function") {
    throw new Error("Snippet completion must expose a custom apply function.");
  }
  option.apply(view, option, 1, 1);
  assert.equal(state.doc.toString(), " $$ ");
  assert.deepEqual(
    { from: state.selection.main.from, to: state.selection.main.to },
    { from: 2, to: 2 }
  );
  assert.equal(getCmSnippetState(state)?.kind, "active");

  state = state.update({
    changes: { from: 2, to: 2, insert: "a" },
    selection: { anchor: 3 }
  }).state;
  assert.equal(state.doc.toString(), " $a$ ");
});

// ---------------------------------------------------------------------------
// option.apply hardening tests
// ---------------------------------------------------------------------------

test("stale panel aborts — neither head-anchored nor fallback range matches", () => {
  // match.replacementText = "xyz" (3 chars). The doc around the caret and
  // around the fallback (to=4) both contain "abc$3$汉字" substrings that
  // do not equal "xyz", so the panel is stale and apply must abort.
  const match = makeMatch("test", "xyz", "xyz", "replacement body");
  const [option] = buildSnippetCompletionOptions([match]);
  let state = EditorState.create({
    doc: "abc$3$汉字",
    extensions: [cmSnippetExtension],
    selection: { anchor: 8 }
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    }
  } as unknown as EditorView;

  if (typeof option.apply !== "function") {
    throw new Error("Snippet completion must expose a custom apply function.");
  }
  // to=4: the fallback range 4-3..4 (index 1..4) = "bc$" ≠ "xyz".
  // head range = 8-3..8 (index 5..8) = "$汉字" ≠ "xyz".
  option.apply(view, option, 0, 4);
  // Document must be unchanged — the stale panel was rejected.
  assert.equal(state.doc.toString(), "abc$3$汉字");
});

test("composition guard aborts — compositionStarted is true", () => {
  const [option] = buildSnippetCompletionOptions([
    makeMatch("inline latex", "$", "$", " $$1$ $0")
  ]);
  let state = EditorState.create({
    doc: "$",
    extensions: [cmSnippetExtension],
    selection: { anchor: 1 }
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    },
    // Composition is active — guards must prevent any document change.
    compositionStarted: true
  } as unknown as EditorView;

  if (typeof option.apply !== "function") {
    throw new Error("Snippet completion must expose a custom apply function.");
  }
  option.apply(view, option, 1, 1);
  // Doc unchanged despite head-anchored text matching "$".
  assert.equal(state.doc.toString(), "$");
});

test("valid fallback still applies — head-anchored slice mismatches, fallback range matches", () => {
  // Doc: "abc$x", caret at end (position 5). match.replacementText = "$".
  // to=4: head-anchored slice (4..5) = "x" ≠ "$", fallback slice (3..4) =
  // "$" matches. Apply must use the fallback range.
  const match = makeMatch("test", "$", "$", " $$1$ $0");
  const [option] = buildSnippetCompletionOptions([match]);
  let state = EditorState.create({
    doc: "abc$x",
    extensions: [cmSnippetExtension],
    selection: { anchor: 5 }
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    }
  } as unknown as EditorView;

  if (typeof option.apply !== "function") {
    throw new Error("Snippet completion must expose a custom apply function.");
  }
  option.apply(view, option, 3, 4);
  // The "$" at position 3 is replaced with the snippet body " $$1$ $0",
  // which the cmSnippetExtension expands to " $$ " (fields removed).
  assert.equal(state.doc.toString(), "abc $$ x");
  assert.equal(getCmSnippetState(state)?.kind, "active");
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

// ---------------------------------------------------------------------------
// Completion source tests (requires cmMathContextExtension)
// ---------------------------------------------------------------------------

function resetCompletionContext() {
  setWorkbenchCompletionContext({
    activeDocument: null,
    articleSummaries: [],
    latexSnippets: [],
    markdownSnippets: []
  });
}

test("workbenchCompletionSource — latex snippets inside a closed math pair", () => {
  resetCompletionContext();

  setWorkbenchCompletionContext({
    activeDocument: { kind: "article" } as unknown as WorkbenchDocument,
    articleSummaries: [],
    latexSnippets: [
      { body: "\\frac{$1}{$2}$0", environment: "latex", name: "frac", prefix: ["\\frac"] }
    ],
    markdownSnippets: []
  });

  const state = EditorState.create({
    doc: "$\\fra$",
    extensions: [createCmCompletionExtension()],
    selection: { anchor: 5 }
  });

  const result = workbenchCompletionSource(new CompletionContext(state, 5, false));
  assert(result !== null);
  assert.equal(result.from, 5);
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].label, "frac");

  resetCompletionContext();
});

test("workbenchCompletionSource — markdown context offers only markdown snippets", () => {
  resetCompletionContext();

  setWorkbenchCompletionContext({
    activeDocument: { kind: "article" } as unknown as WorkbenchDocument,
    articleSummaries: [],
    latexSnippets: [
      { body: "\\frbody", environment: "latex", name: "fr", prefix: ["\\fr"] }
    ],
    markdownSnippets: [
      { body: "world body", environment: "markdown", name: "world", prefix: ["world"] }
    ]
  });

  const state = EditorState.create({
    doc: "hello wor",
    extensions: [createCmCompletionExtension()],
    selection: { anchor: 9 }
  });

  const result = workbenchCompletionSource(new CompletionContext(state, 9, false));
  assert(result !== null);
  assert.equal(result.options.length, 1);
  assert.equal(result.options[0].label, "world");

  resetCompletionContext();
});

test("workbenchCompletionSource — no active document returns null", () => {
  resetCompletionContext();

  setWorkbenchCompletionContext({
    activeDocument: null,
    articleSummaries: [],
    latexSnippets: [],
    markdownSnippets: []
  });

  const state = EditorState.create({
    doc: "$a$",
    extensions: [createCmCompletionExtension()],
    selection: { anchor: 2 }
  });

  const result = workbenchCompletionSource(new CompletionContext(state, 2, false));
  assert(result === null);

  resetCompletionContext();
});
