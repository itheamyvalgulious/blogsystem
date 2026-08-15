import { acceptCompletion, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, historyKeymap, indentLess, indentMore } from "@codemirror/commands";
import { deleteMarkupBackward } from "@codemirror/lang-markdown";
import { foldKeymap } from "@codemirror/language";
import { openSearchPanel, searchKeymap, selectNextOccurrence } from "@codemirror/search";
import { EditorSelection, Prec, type Extension, type StateCommand } from "@codemirror/state";
import { EditorView, keymap, type Command } from "@codemirror/view";

import { acceptAiGhostSuggestion, clearAiGhostSuggestion } from "./cm-inline-completion";
import { tabCompleteFromDocument } from "./cm-tab-completion";
import { clearCmSnippet, nextCmSnippetField, prevCmSnippetField } from "./cm-snippets";
import { orderedListEnterCommand } from "./cm-ordered-list";

/**
 * Keymap stack for the "live" (CodeMirror 6) editor engine.
 *
 * Layering: workbench-specific bindings live in a `Prec.high` keymap so they
 * win over the default set; history/search/fold/default/completion keymaps
 * follow at normal precedence (first match per key wins). Escape clears the
 * AI ghost suggestion *after* completionKeymap's close-completion binding,
 * so an open completion panel is closed first.
 *
 * The workbench's JSON keybinding dispatcher listens in capture phase on the
 * editor container DOM (see hooks/use-editor-integration.ts) and calls
 * `preventDefault()` when it handles a key. These CM bindings are chosen to
 * not collide with that dispatch; they must never `stopPropagation()` on
 * container-level events.
 */

// StateCommand takes a {state, dispatch} target, which EditorView satisfies
// structurally, so commands can be invoked with the view directly.
const runStateCommand = (command: StateCommand): Command => (view) => command(view);

const nextSnippetFieldCommand = runStateCommand(nextCmSnippetField);
const prevSnippetFieldCommand = runStateCommand(prevCmSnippetField);
const indentMoreCommand = runStateCommand(indentMore);
const indentLessCommand = runStateCommand(indentLess);
const selectNextOccurrenceCommand = runStateCommand(selectNextOccurrence);

/**
 * Adds a caret on the line above/below every existing caret at the same
 * column, mirroring Monaco's `editor.action.insertCursorAbove/Below`. The
 * added range is a caret at the (clamped) column of the source range head;
 * non-empty selections degrade to a caret, same as Monaco.
 */
function addCursorOnLine(direction: 1 | -1): Command {
  return (view) => {
    const { state } = view;
    const doc = state.doc;
    const occupiedHeads = new Set(state.selection.ranges.map((range) => range.head));
    const additions = [];

    for (const range of state.selection.ranges) {
      const line = doc.lineAt(range.head);
      const targetNumber = line.number + direction;
      if (targetNumber < 1 || targetNumber > doc.lines) {
        continue;
      }

      const targetLine = doc.line(targetNumber);
      const head = targetLine.from + Math.min(range.head - line.from, targetLine.length);
      if (occupiedHeads.has(head)) {
        continue;
      }

      occupiedHeads.add(head);
      additions.push(EditorSelection.cursor(head));
    }

    if (additions.length === 0) {
      return false;
    }

    view.dispatch({
      selection: EditorSelection.create([...state.selection.ranges, ...additions], state.selection.mainIndex)
    });
    return true;
  };
}

const workbenchKeymap = [
  {
    key: "Tab",
    run: (view: EditorView) =>
      nextSnippetFieldCommand(view) ||
      acceptAiGhostSuggestion(view) ||
      acceptCompletion(view) ||
      // Monaco `tabCompletion: "on"` equivalent: document-word completion.
      tabCompleteFromDocument(view) ||
      indentMoreCommand(view)
  },
  {
    key: "Shift-Tab",
    run: (view: EditorView) => prevSnippetFieldCommand(view) || indentLessCommand(view)
  },
  { key: "Ctrl-d", run: selectNextOccurrenceCommand, preventDefault: true },
  { key: "Ctrl-Alt-ArrowUp", run: addCursorOnLine(-1), preventDefault: true },
  { key: "Ctrl-Alt-ArrowDown", run: addCursorOnLine(1), preventDefault: true },
  // The CM search panel ships its own replace row, so Ctrl-H opens the same panel.
  { key: "Ctrl-f", run: openSearchPanel, preventDefault: true },
  { key: "Ctrl-h", run: openSearchPanel, preventDefault: true }
];

export const cmKeymap: Extension = [
  Prec.high(keymap.of(workbenchKeymap)),
  keymap.of([
    ...historyKeymap,
    ...searchKeymap,
    ...foldKeymap,
    // completionKeymap must precede defaultKeymap: its Enter (acceptCompletion)
    // would otherwise lose to defaultKeymap's insertNewlineAndIndent. It
    // returns false when no panel is open, so fall-through stays intact.
    ...completionKeymap,
    { key: "Enter", run: runStateCommand(orderedListEnterCommand) },
    { key: "Backspace", run: runStateCommand(deleteMarkupBackward) },
    ...defaultKeymap,
    // Lower priority than completionKeymap's Escape (close panel first).
    { key: "Escape", run: clearCmSnippet },
    { key: "Escape", run: clearAiGhostSuggestion }
  ])
];
