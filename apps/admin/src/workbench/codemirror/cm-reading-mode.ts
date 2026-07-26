import { StateEffect, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";

/**
 * Reading (focus) mode for the CM live preview (see cm-live-preview.ts):
 * "read" (default — only the near-cursor construct shows source, everything
 * else is replaced by previews) vs "write" (source everywhere, previews
 * beside/below), persisted to localStorage.
 *
 * The "inside" definition is fixed to region mode: the cursor head within
 * `from−1..to+1` inclusive (the ±1 slack exists because CM cursor motion
 * skips replaced ranges entirely — the head jumps between the adjacent
 * positions, which are the only way to "enter" a hidden block).
 *
 * This module deliberately imports nothing from cm-live-preview.ts: the mode
 * setter refreshes live views itself (readingModeRefresh effect), keeping
 * the dependency one-directional.
 *
 * No monaco imports: this module must stay loadable in Node test runs.
 */

export type ReadingMode = "read" | "write";

const READING_MODE_STORAGE_KEY = "workbench.readingMode";

let cachedReadingMode: ReadingMode | null = null;

export function getReadingMode(): ReadingMode {
  if (cachedReadingMode === null) {
    try {
      const value = window.localStorage.getItem(READING_MODE_STORAGE_KEY);
      cachedReadingMode = value === "write" ? "write" : "read";
    } catch {
      // window/localStorage unavailable (non-browser test run): default.
      cachedReadingMode = "read";
    }
  }
  return cachedReadingMode;
}

/** Forces a decoration rebuild in live views after a mode change. */
export const readingModeRefresh = StateEffect.define<null>();

// Views with the reading-mode extension active; the setter refreshes them.
const readingModeViews = new Set<EditorView>();

export function setReadingMode(mode: ReadingMode): void {
  if (mode === getReadingMode()) {
    return;
  }
  cachedReadingMode = mode;
  try {
    window.localStorage.setItem(READING_MODE_STORAGE_KEY, mode);
  } catch {
    // Ignore persistence failures; the in-memory value still applies.
  }
  for (const view of readingModeViews) {
    view.dispatch({ effects: readingModeRefresh.of(null) });
  }
}

/** region membership: the cursor head sits inside the range (inclusive). */
export function isInCursorRegion(rangeFrom: number, rangeTo: number, head: number): boolean {
  return head >= rangeFrom && head <= rangeTo;
}

// Registration-only plugin: keeps readingModeViews accurate so the setter
// can push refreshes. Provides no decorations.
const readingModeViewTracker = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {
      readingModeViews.add(view);
    }

    destroy() {
      readingModeViews.delete(this.view);
    }
  }
);

export const cmReadingModeSupport: Extension = [readingModeViewTracker];
