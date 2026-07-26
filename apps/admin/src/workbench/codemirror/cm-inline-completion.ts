import { StateEffect, StateField, type Extension } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  WidgetType,
  type Command,
  type DecorationSet
} from "@codemirror/view";

import {
  buildAiCompletionRequestInput,
  getAiCompletionStatusWithRetry,
  requestAiCompletionText
} from "../../ai-inline-completion";
import { positionAt } from "./cm-handle";

/**
 * AI inline completion ("ghost text") for the CodeMirror "live" engine,
 * mirroring the Monaco provider in src/ai-inline-completion.ts.
 *
 * Flow: after every document/selection change a 300ms debounce fires a
 * request (state-reference compared, so superseded schedules never hit the
 * network). A response is applied only when the document and caret are
 * untouched since the request. The suggestion lives in a StateField that any
 * doc/selection change auto-clears, and renders as an inline widget after
 * the caret (`.cm-ai-ghost`). Tab accepts (chained after nextSnippetField in
 * cm-keymap), Escape clears (lower priority than closing the completion
 * panel).
 *
 * The extension is only mounted on markdown editors (all CM instances are
 * markdown) and requests only fire while the AI completion status is
 * enabled — same gating as the Monaco side.
 *
 * No monaco imports: this module must stay loadable in Node test runs.
 */

const AI_GHOST_DEBOUNCE_MS = 300;

export interface AiGhostSuggestion {
  from: number;
  text: string;
}

export const setAiGhostSuggestion = StateEffect.define<AiGhostSuggestion | null>();

/**
 * Holds the current suggestion. Field order matters: the decoration field
 * below reads this field from `tr.state`, so it must be updated first (it is
 * listed first in the extension array).
 */
export const aiGhostSuggestionField = StateField.define<AiGhostSuggestion | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setAiGhostSuggestion)) {
        value = effect.value;
      }
    }
    // The suggestion was computed for one exact buffer+caret pair: any
    // document change or explicit selection change invalidates it.
    if (value && (tr.docChanged || tr.selection)) {
      value = null;
    }
    return value;
  }
});

class AiGhostWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  override eq(other: AiGhostWidget): boolean {
    return other.text === this.text;
  }

  override toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-ai-ghost";
    // Multi-line suggestions preview only the first line; accepting still
    // inserts the full text.
    const newlineIndex = this.text.indexOf("\n");
    span.textContent = newlineIndex === -1 ? this.text : this.text.slice(0, newlineIndex);
    return span;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

const aiGhostDecorationField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_decorations, tr) {
    const suggestion = tr.state.field(aiGhostSuggestionField);
    if (!suggestion || suggestion.text.length === 0) {
      return Decoration.none;
    }
    const widget = Decoration.widget({
      side: 1,
      widget: new AiGhostWidget(suggestion.text)
    });
    return Decoration.set([widget.range(suggestion.from)]);
  },
  provide: (field) => EditorView.decorations.from(field)
});

const aiGhostTimers = new WeakMap<EditorView, ReturnType<typeof setTimeout>>();

export function cancelAiGhostRequest(view: EditorView): void {
  const pending = aiGhostTimers.get(view);
  if (pending) {
    clearTimeout(pending);
    aiGhostTimers.delete(view);
  }
}

async function requestAiGhost(view: EditorView): Promise<void> {
  if (!getAiCompletionStatusWithRetry()?.enabled) {
    return;
  }
  const state = view.state;
  const { main } = state.selection;
  if (!main.empty) {
    return;
  }

  const doc = state.doc;
  const head = main.head;
  const position = positionAt(doc, head);
  const input = buildAiCompletionRequestInput(
    doc.toString(),
    head,
    position.lineNumber,
    position.column
  );
  // Nothing before the caret (document start / blank line): there is no
  // context worth completing, so skip the request entirely.
  if (input.prefix.trim().length === 0) {
    return;
  }
  const completion = await requestAiCompletionText(input);
  if (!completion) {
    return;
  }
  // Stale guard: only apply when the buffer and caret are exactly as
  // requested.
  if (view.state.doc !== doc || view.state.selection.main.head !== head) {
    return;
  }
  view.dispatch({ effects: setAiGhostSuggestion.of({ from: head, text: completion }) });
}

const aiGhostRequestListener = EditorView.updateListener.of((update) => {
  if (!update.docChanged && !update.selectionSet) {
    return;
  }
  cancelAiGhostRequest(update.view);
  const state = update.state;
  aiGhostTimers.set(
    update.view,
    setTimeout(() => {
      aiGhostTimers.delete(update.view);
      // Superseded only when the buffer or caret actually moved; unrelated
      // transactions (completion state, decoration refreshes) must not cancel
      // the schedule — the request itself re-checks staleness before applying.
      const current = update.view.state;
      if (current.doc !== state.doc || !current.selection.main.eq(state.selection.main)) {
        return;
      }
      void requestAiGhost(update.view);
    }, AI_GHOST_DEBOUNCE_MS)
  );
});

/**
 * Accepts the active ghost suggestion, inserting the full suggestion text
 * (including lines hidden from the single-line preview). Returns false when
 * no ghost is active so the Tab chain can fall through.
 */
export const acceptAiGhostSuggestion: Command = (view) => {
  const suggestion = view.state.field(aiGhostSuggestionField, false);
  if (!suggestion || suggestion.text.length === 0) {
    return false;
  }
  view.dispatch({
    changes: { from: suggestion.from, insert: suggestion.text },
    effects: setAiGhostSuggestion.of(null),
    selection: { anchor: suggestion.from + suggestion.text.length }
  });
  return true;
};

/** Clears the active ghost suggestion; false when none is active. */
export const clearAiGhostSuggestion: Command = (view) => {
  if (!view.state.field(aiGhostSuggestionField, false)) {
    return false;
  }
  view.dispatch({ effects: setAiGhostSuggestion.of(null) });
  return true;
};

export function createCmAiInlineCompletionExtension(): Extension {
  return [aiGhostSuggestionField, aiGhostDecorationField, aiGhostRequestListener];
}
