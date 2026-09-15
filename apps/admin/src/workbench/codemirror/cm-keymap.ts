import { acceptCompletion, completionKeymap, completionStatus } from "@codemirror/autocomplete";
import { defaultKeymap, historyKeymap, indentLess, indentMore, insertNewlineAndIndent } from "@codemirror/commands";
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
 *
 * The workbench-level Enter binding:
 * - Returns false immediately during an IME composition (never intercept a
 *   key that belongs to the input method — a deferred newline dispatched
 *   mid-composition corrupts CM's composition tracking).
 * - When the completion panel is visible (`"active"`), accepts the
 *   completion at high precedence — plugging the gap where
 *   completionKeymap's Enter sometimes fell through (interactionDelay
 *   window / disabled guards).
 * - When a completion query is pending, defers the newline decision for a
 *   few frames so a fast Enter can accept the just-typed snippet
 *   completion instead of racing the async query into a newline.
 * All other Enter paths fall through unchanged.
 */

// StateCommand takes a {state, dispatch} target, which EditorView satisfies
// structurally, so commands can be invoked with the view directly.
const runStateCommand = (command: StateCommand): Command => (view) => command(view);

const nextSnippetFieldCommand = runStateCommand(nextCmSnippetField);
const prevSnippetFieldCommand = runStateCommand(prevCmSnippetField);
const indentMoreCommand = runStateCommand(indentMore);
const indentLessCommand = runStateCommand(indentLess);
const selectNextOccurrenceCommand = runStateCommand(selectNextOccurrence);

export type EnterFrameScheduler = (callback: () => void) => void;

const PENDING_COMPLETION_WAIT_FRAMES = 8;

/**
 * Enter that cooperates with an in-flight completion query and provides
 * IME-aware composition safety.
 *
 * CodeMirror schedules the completion source query asynchronously after the
 * keystroke's transaction (internal setTimeout + promise). A fast Enter can
 * therefore be processed before the panel opens and fall through to a
 * newline, even though the query would have offered a completion a few
 * milliseconds later.
 *
 * Composition safety:
 * - Returns false immediately when `view.compositionStarted` is true: the key
 *   belongs to the input method and must not be intercepted.
 * - The settle callback also guards against compositions that began during
 *   the wait — a delayed dispatch mid-composition corrupts CM's tracking.
 *
 * Active-panel fast path:
 * - When completions are visible (`"active"`), accepts right here at high
 *   precedence. This plugs the gap where completionKeymap's Enter
 *   sometimes fell through (interactionDelay window / disabled guards).
 *
 * Pending path:
 * - When Enter arrives while a query is PENDING, consume it and re-check for
 *   a few frames: accept the completion once the panel activates, or insert
 *   the deferred newline when no completion materializes.
 * Every other Enter path is untouched (the command returns false so the
 * completion/ordered-list/default chain keeps handling it).
 */
export function createCompletionAwareEnterCommand(
  schedule: EnterFrameScheduler = (callback) => requestAnimationFrame(callback)
) {
  return (view: EditorView): boolean => {
    // During an IME composition the key belongs to the input method: never
    // intercept (a deferred newline dispatched mid-composition corrupts
    // CodeMirror's composition tracking — see cm-completion.ts).
    if (view.compositionStarted) {
      return false;
    }

    const status = completionStatus(view.state);
    if (status === "active") {
      // The panel is open: accept right here at high precedence. Relying on
      // completionKeymap's Enter left gaps (its interactionDelay window and
      // disabled/selected guards) where a displayed panel's Enter still fell
      // through to a newline.
      return acceptCompletion(view);
    }

    if (status !== "pending") {
      return false;
    }

    let frames = 0;
    const settle = () => {
      // Torn-down views must not dispatch (matches the guard style used in
      // cm-editor.tsx for late async work).
      if ((view as unknown as { inputState?: unknown }).inputState === undefined) {
        return;
      }
      // A composition began while we waited: the key belongs to the IME now.
      if (view.compositionStarted) {
        return;
      }
      const currentStatus = completionStatus(view.state);
      if (currentStatus === "active") {
        acceptCompletion(view);
        return;
      }
      if (currentStatus === "pending" && frames < PENDING_COMPLETION_WAIT_FRAMES) {
        frames += 1;
        schedule(settle);
        return;
      }
      // No completion arrived (the query returned null or took too long):
      // perform the newline the user asked for.
      // Re-check composition guard before dispatching.
      if (view.compositionStarted) {
        return;
      }
      insertNewlineAndIndent(view);
    };
    schedule(settle);
    return true;
  };
}

const completionAwareEnter = createCompletionAwareEnterCommand();

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
  { key: "Enter", run: (view: EditorView) => completionAwareEnter(view) },
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
    // would otherwise lose to defaultKeymap's insertNewlineAndIndent. The
    // workbench-level Enter (above) handles the pending case first;
    // completionKeymap's Enter still owns the panel-open accept path. It
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
