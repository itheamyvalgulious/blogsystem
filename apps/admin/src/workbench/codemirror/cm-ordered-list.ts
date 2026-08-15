import {
  EditorSelection,
  StateEffect,
  type EditorState,
  type Extension,
  type StateCommand
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";

import { getListContinuationPrefix, getOrderedListRenumberEdits } from "../ordered-list";

/** Marks the one transaction created by the real list-continuation Enter. */
export const orderedListEnter = StateEffect.define<void>();

const LIST_ITEM_PREFIX_PATTERN = /^([ \t]*)(?:(?:\d+\.|[-*+])[ \t]+)/;

/**
 * Markdown permits an unindented lazy paragraph continuation inside a list
 * item.  That is useful for rendering, but it should not make the following
 * ordinary paragraph foldable as part of the list item in this editor:
 *
 *   - item
 *   paragraph
 *
 * Keep folding for genuinely indented continuation content and nested list
 * items, while cutting the fold at the first non-list line at the item's
 * indentation level.
 */
export function foldListItem(node: SyntaxNode, state: EditorState) {
  const firstLine = state.doc.lineAt(node.from);
  const markerMatch = LIST_ITEM_PREFIX_PATTERN.exec(firstLine.text);
  if (!markerMatch || node.from !== firstLine.from) {
    return null;
  }

  const listIndent = markerMatch[1].length;
  let foldTo = firstLine.to;
  for (let lineNumber = firstLine.number + 1; lineNumber <= state.doc.lines; lineNumber += 1) {
    const line = state.doc.line(lineNumber);
    if (line.from >= node.to || line.text.trim().length === 0) {
      break;
    }

    const indent = /^[ \t]*/.exec(line.text)?.[0].length ?? 0;
    if (indent <= listIndent) {
      break;
    }

    foldTo = line.to;
  }

  return foldTo > firstLine.to ? { from: firstLine.to, to: foldTo } : null;
}

/** Paragraphs carry the default fold prop inside a ListItem, so override
 * their inherited range as well as the ListItem node itself. */
export function foldMarkdownParagraph(node: SyntaxNode, state: EditorState) {
  for (let current = node.parent; current; current = current.parent) {
    if (current.name === "ListItem") {
      return foldListItem(current, state);
    }
  }
  return { from: state.doc.lineAt(node.from).to, to: node.to };
}

function renumberOrderedLists(view: EditorView): void {
  const edits = getOrderedListRenumberEdits(view.state.doc.toString());
  if (edits.length === 0) {
    return;
  }

  view.dispatch({
    changes: edits.map((edit) => {
      const line = view.state.doc.line(edit.lineNumber);
      return {
        from: line.from + edit.startColumn - 1,
        insert: edit.text,
        to: line.from + edit.endColumn - 1
      };
    })
  });
}

/**
 * Enter handling lives in the regular keymap so completionKeymap can run
 * first.  The Markdown package also has an Enter binding, so cm-editor
 * disables that package keymap and installs this command beside the rest of
 * the workbench keymap.
 */
export const orderedListEnterCommand: StateCommand = ({ state, dispatch }) => {
  const selection = state.selection.main;
  if (!selection.empty) {
    return false;
  }

  const line = state.doc.lineAt(selection.head);
  const beforeCursor = state.sliceDoc(line.from, selection.head);
  const continuationPrefix = getListContinuationPrefix(beforeCursor);
  if (!continuationPrefix) {
    return false;
  }

  const insertedText = `${state.lineBreak}${continuationPrefix}`;
  dispatch(
    state.update({
      changes: { from: selection.head, insert: insertedText },
      effects: orderedListEnter.of(undefined),
      selection: EditorSelection.cursor(selection.head + insertedText.length),
      scrollIntoView: true,
      userEvent: "input"
    })
  );
  return true;
};

let isRenumbering = false;

export const cmOrderedListExtension: Extension = [
  EditorView.updateListener.of((update) => {
    if (
      !update.docChanged ||
      isRenumbering ||
      !update.transactions.some((transaction) =>
        transaction.effects.some((effect) => effect.is(orderedListEnter))
      )
    ) {
      return;
    }

    isRenumbering = true;
    try {
      renumberOrderedLists(update.view);
    } finally {
      isRenumbering = false;
    }
  })
];
