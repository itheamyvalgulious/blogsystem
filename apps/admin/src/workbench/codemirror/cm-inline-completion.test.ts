import assert from "node:assert/strict";
import test from "node:test";

import { EditorState } from "@codemirror/state";

import {
  aiGhostSuggestionField,
  setAiGhostSuggestion
} from "./cm-inline-completion";

function createState(doc = "hello world") {
  return EditorState.create({ doc, extensions: [aiGhostSuggestionField] });
}

test("ghost suggestion field starts empty and accepts a set effect", () => {
  const state = createState();
  assert.equal(state.field(aiGhostSuggestionField), null);

  // The set-effect transaction itself must not auto-clear the suggestion.
  const next = state.update({
    effects: setAiGhostSuggestion.of({ from: 5, text: " completion" })
  }).state;
  assert.deepEqual(next.field(aiGhostSuggestionField), { from: 5, text: " completion" });
});

test("document change clears the active suggestion", () => {
  const withGhost = createState().update({
    effects: setAiGhostSuggestion.of({ from: 5, text: " completion" })
  }).state;

  const edited = withGhost.update({ changes: { from: 0, insert: ">" } }).state;
  assert.equal(edited.field(aiGhostSuggestionField), null);
});

test("selection change clears the active suggestion", () => {
  const withGhost = createState().update({
    effects: setAiGhostSuggestion.of({ from: 5, text: " completion" })
  }).state;

  const moved = withGhost.update({ selection: { anchor: 1 } }).state;
  assert.equal(moved.field(aiGhostSuggestionField), null);
});

test("unrelated transactions keep the suggestion", () => {
  const withGhost = createState().update({
    effects: setAiGhostSuggestion.of({ from: 5, text: " completion" })
  }).state;

  const untouched = withGhost.update({}).state;
  assert.deepEqual(untouched.field(aiGhostSuggestionField), { from: 5, text: " completion" });
});

test("null effect clears the suggestion explicitly", () => {
  const withGhost = createState().update({
    effects: setAiGhostSuggestion.of({ from: 5, text: " completion" })
  }).state;

  const cleared = withGhost.update({ effects: setAiGhostSuggestion.of(null) }).state;
  assert.equal(cleared.field(aiGhostSuggestionField), null);
});
