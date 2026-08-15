import assert from "node:assert/strict";
import test from "node:test";
import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import {
  cmSnippetExtension,
  getCmSnippetState,
  insertCmSnippet,
  nextCmSnippetField,
  parseCmSnippetTemplate,
  prevCmSnippetField
} from "./cm-snippets";

test("numeric snippet markers are removed and the first field is ordered by number", () => {
  const result = parseCmSnippetTemplate("before ${2} middle ${1:default} end $0");

  assert.equal(result.text, "before  middle default end ");
  assert.deepEqual(
    result.tabstops.map(({ final, from, number, to }) => ({ final, from, number, to })),
    [
      { final: false, from: 7, number: 2, to: 7 },
      { final: false, from: 15, number: 1, to: 22 },
      { final: true, from: 27, number: 0, to: 27 }
    ]
  );
});

test("an empty numeric field reserves no document character", () => {
  const result = parseCmSnippetTemplate("left${1}right");

  assert.equal(result.text, "leftright");
  assert.deepEqual(result.tabstops, [
    { final: false, from: 4, number: 1, to: 4 }
  ]);
});

test("repeated fields share the first default text while remaining separate ranges", () => {
  const result = parseCmSnippetTemplate("${1:name} and ${1}");

  assert.equal(result.text, "name and name");
  assert.deepEqual(
    result.tabstops.map(({ from, number, to }) => ({ from, number, to })),
    [
      { from: 0, number: 1, to: 4 },
      { from: 9, number: 1, to: 13 }
    ]
  );
});

test("a zero tabstop never gets default text", () => {
  const result = parseCmSnippetTemplate("${1:text} ${0:ignored}");

  assert.equal(result.text, "text ");
  assert.deepEqual(result.tabstops.at(-1), {
    final: true,
    from: 5,
    number: 0,
    to: 5
  });
});

test("escaped braces in a placeholder default are unescaped", () => {
  const result = parseCmSnippetTemplate("${1:map\\{key\\}}");

  assert.equal(result.text, "map{key}");
});

test("multi-line snippets create real document lines and select their first field", () => {
  let state = EditorState.create({
    doc: "",
    extensions: [cmSnippetExtension]
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    }
  } as unknown as EditorView;
  const template = "$$\n\\begin{gathered}\n$1\n\\end{gathered}\n$$";
  const parsed = parseCmSnippetTemplate(template);

  insertCmSnippet(view, template);

  assert.equal(state.doc.toString(), "$$\n\\begin{gathered}\n\n\\end{gathered}\n$$");
  assert.equal(state.doc.lines, 5);
  assert.deepEqual(
    { from: state.selection.main.from, to: state.selection.main.to },
    { from: parsed.tabstops[0].from, to: parsed.tabstops[0].to }
  );
});

test("a snippet with only $0 places the caret at its final tabstop", () => {
  let state = EditorState.create({
    doc: "",
    extensions: [cmSnippetExtension]
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    }
  } as unknown as EditorView;
  const template = "before\n$0\nafter";
  const parsed = parseCmSnippetTemplate(template);

  insertCmSnippet(view, template);

  assert.equal(state.doc.toString(), "before\n\nafter");
  assert.deepEqual(
    { from: state.selection.main.from, to: state.selection.main.to },
    { from: parsed.tabstops[0].from, to: parsed.tabstops[0].to }
  );
});

test("nested snippets preserve the outer tabstops after the inner snippet finishes", () => {
  let state = EditorState.create({
    doc: "",
    extensions: [cmSnippetExtension]
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    }
  } as unknown as EditorView;

  insertCmSnippet(view, "\\dfrac{$1}{$2} $0");
  const outer = parseCmSnippetTemplate("\\dfrac{$1}{$2} $0");
  assert.equal(state.doc.toString(), "\\dfrac{}{} ");
  assert.deepEqual(
    { from: state.selection.main.from, to: state.selection.main.to },
    {
      from: outer.tabstops[0].from,
      to: outer.tabstops[0].to
    }
  );

  insertCmSnippet(view, "\\dfrac{$1}{$2} $0");
  assert.equal(state.doc.toString(), "\\dfrac{\\dfrac{}{} }{} ");
  assert.equal(getCmSnippetState(state)?.kind, "active");

  assert.equal(nextCmSnippetField({ state, dispatch: view.dispatch }), true);
  // Reaching the inner `$0` destroys the inner node immediately.
  assert.equal(nextCmSnippetField({ state, dispatch: view.dispatch }), true);
  assert.equal(getCmSnippetState(state)?.kind, "active");
  assert.equal(prevCmSnippetField({ state, dispatch: view.dispatch }), false);

  const outerSecondFrom = state.doc.toString().lastIndexOf("{}") + 1;
  assert.equal(nextCmSnippetField({ state, dispatch: view.dispatch }), true);
  assert.deepEqual(
    { from: state.selection.main.from, to: state.selection.main.to },
    { from: outerSecondFrom, to: outerSecondFrom }
  );

  // Reaching the outer `$0` destroys the root node too, so Shift-Tab no
  // longer re-enters any of the completed fields.
  assert.equal(nextCmSnippetField({ state, dispatch: view.dispatch }), true);
  assert.equal(getCmSnippetState(state), null);
  assert.equal(prevCmSnippetField({ state, dispatch: view.dispatch }), false);
});
