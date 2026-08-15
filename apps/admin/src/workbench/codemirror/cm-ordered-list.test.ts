import assert from "node:assert/strict";
import test from "node:test";

import { EditorState } from "@codemirror/state";

import { orderedListEnter, orderedListEnterCommand } from "./cm-ordered-list";

test("ordered list Enter command is explicit and does not classify a following paragraph as a list", () => {
  let state = EditorState.create({
    doc: "- item",
    selection: { anchor: 6 }
  });
  let dispatched = false;

  assert.equal(
    orderedListEnterCommand({
      state,
      dispatch: (transaction) => {
        dispatched = true;
        state = transaction.state;
        assert.ok(transaction.effects.some((effect) => effect.is(orderedListEnter)));
      }
    }),
    true
  );
  assert.equal(dispatched, true);
  assert.equal(state.doc.toString(), "- item\n- ");

  const ordinaryParagraph = EditorState.create({
    doc: "- item\nxxx",
    selection: { anchor: 10 }
  });
  assert.equal(
    orderedListEnterCommand({
      state: ordinaryParagraph,
      dispatch: () => {
        throw new Error("A following ordinary paragraph must not continue the list.");
      }
    }),
    false
  );
});
