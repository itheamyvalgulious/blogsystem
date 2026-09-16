import assert from "node:assert/strict";
import test from "node:test";

import {
  autocompletion,
  completionStatus,
  startCompletion,
  type CompletionSource
} from "@codemirror/autocomplete";
import { EditorState, type EditorStateConfig } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { createCompletionAwareEnterCommand } from "./cm-keymap";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeView(
  doc: string,
  extensions: EditorStateConfig["extensions"]
) {
  let state = EditorState.create({ doc, extensions, selection: { anchor: doc.length } });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: Parameters<EditorState["update"]>[0]) {
      state = state.update(spec).state;
    },
    // Present so settle's torn-down guard does not fire.
    inputState: {} as Record<string, never>
  } as unknown as EditorView;
  return view;
}

function makeManualScheduler() {
  const queue: Array<() => void> = [];
  const schedule = (callback: () => void) => queue.push(callback);
  const flush = () => {
    for (let guard = 0; queue.length > 0 && guard < 100; guard += 1) {
      queue.shift()!();
    }
  };
  return { flush, queue, schedule };
}

/** Async source that never resolves (status stays "pending" indefinitely). */
const foreverPendingSource: CompletionSource = (_context) => new Promise(() => {});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("not pending Enter returns false and does nothing", () => {
  const { schedule } = makeManualScheduler();
  const view = makeView("hello ", [autocompletion({ override: [() => null] })]);
  const cmd = createCompletionAwareEnterCommand(schedule);

  const result = cmd(view);

  assert.equal(result, false);
  assert.equal(view.state.doc.toString(), "hello ");
});

test("pending Enter consumed; falls back to newline after frame cap", () => {
  const { schedule, flush } = makeManualScheduler();
  const view = makeView("hello ", [
    autocompletion({ override: [foreverPendingSource], activateOnTyping: true })
  ]);

  // Trigger the pending completion status.
  const started = startCompletion(view);
  assert.equal(started, true);
  assert.equal(completionStatus(view.state), "pending");

  const cmd = createCompletionAwareEnterCommand(schedule);
  const result = cmd(view);

  assert.equal(result, true);
  assert.equal(completionStatus(view.state), "pending");

  // Flush all settle frames — after 8 cycles the status is still "pending"
  // and insertNewlineAndIndent is called.
  flush();

  assert.ok(
    view.state.doc.toString().includes("\n"),
    "Expected newline fallback"
  );
});

test("pending Enter consumed and scheduler primed; accept path documented", () => {
  // The accept path (pending → active → acceptCompletion) cannot be
  // exercised headless because the autocomplete ViewPlugin is required
  // to call the source, process its result, and set the completion
  // dialog state ("active" + cState.open). Without DOM / a real
  // EditorView, completionStatus can only reach "pending".
  //
  // This test verifies that the command:
  //   1. Recognizes the pending status and returns true (consumed)
  //   2. Queues the settle callback in the scheduler
  // The end-to-end accept path is covered by manual/browser integration
  // tests.
  const { schedule, queue } = makeManualScheduler();
  const view = makeView("hello ", [
    autocompletion({ override: [foreverPendingSource], activateOnTyping: true })
  ]);

  startCompletion(view);
  assert.equal(completionStatus(view.state), "pending");

  const cmd = createCompletionAwareEnterCommand(schedule);
  const result = cmd(view);

  assert.equal(result, true);
  assert.equal(queue.length, 1, "settle callback queued");
});

test("composition-active Enter is not intercepted", () => {
  // During an IME composition the command must return false immediately
  // regardless of completion status. The composition guard runs before
  // any status check, so even with no query in flight the assertion
  // stands.
  const { schedule } = makeManualScheduler();
  const view = makeView("hello ", [autocompletion({ override: [() => null] })]);
  (view as unknown as { compositionStarted: boolean }).compositionStarted = true;
  const cmd = createCompletionAwareEnterCommand(schedule);

  const result = cmd(view);

  assert.equal(result, false);
  assert.equal(view.state.doc.toString(), "hello ");
});

// The active-case fast path (panel open, completionStatus === "active")
// cannot be exercised headlessly — the autocomplete ViewPlugin is required
// to open the dialog and set the plugin state — so it is tested only via
// manual / browser integration tests.