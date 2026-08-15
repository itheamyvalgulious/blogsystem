import {
  acceptCompletion,
  closeCompletion,
  completionStatus,
  startCompletion
} from "@codemirror/autocomplete";
import { EditorSelection, Text, Transaction, type ChangeSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  insertCmSnippet,
  isCmSnippetActive,
  nextCmSnippetField,
  prevCmSnippetField
} from "./cm-snippets";

import {
  EditorOption,
  type EditorContentChangedEvent,
  type EditorDisposable,
  type EditorEditOperation,
  type EditorOptionId,
  type EditorPosition,
  type EditorRange,
  type EditorScrollEvent,
  type EditorSelection as WorkbenchEditorSelection,
  type SnippetControllerHandle,
  type WorkbenchEditorHandle,
  type WorkbenchTextModelHandle
} from "../editor-engine";

/**
 * CodeMirror 6 implementation of the engine-neutral workbench editor handle.
 *
 * Positions are converted between Monaco-style 1-based {lineNumber, column}
 * pairs and CM document offsets via the document's line index. The handle is
 * bound to an EditorView accessor (the view outlives document switches; the
 * component swaps EditorStates per path), so every method reads the *current*
 * state at call time.
 *
 * Doc/selection/type events are emitted by the editor component's
 * `EditorView.updateListener` bridge (see cm-editor.tsx) through the
 * `internals` object; scroll/focus listeners are attached here directly.
 */

export class CmRange implements EditorRange {
  constructor(
    public startLineNumber: number,
    public startColumn: number,
    public endLineNumber: number,
    public endColumn: number
  ) {}
}

export class CmSelection extends CmRange implements WorkbenchEditorSelection {
  constructor(
    public selectionStartLineNumber: number,
    public selectionStartColumn: number,
    public positionLineNumber: number,
    public positionColumn: number
  ) {
    const selectionStartFirst =
      selectionStartLineNumber < positionLineNumber ||
      (selectionStartLineNumber === positionLineNumber && selectionStartColumn <= positionColumn);
    super(
      selectionStartFirst ? selectionStartLineNumber : positionLineNumber,
      selectionStartFirst ? selectionStartColumn : positionColumn,
      selectionStartFirst ? positionLineNumber : selectionStartLineNumber,
      selectionStartFirst ? positionColumn : selectionStartColumn
    );
  }

  isEmpty(): boolean {
    return (
      this.startLineNumber === this.endLineNumber && this.startColumn === this.endColumn
    );
  }

  getPosition(): EditorPosition {
    return { column: this.positionColumn, lineNumber: this.positionLineNumber };
  }

  getStartPosition(): EditorPosition {
    return { column: this.selectionStartColumn, lineNumber: this.selectionStartLineNumber };
  }
}

function clampLine(doc: Text, lineNumber: number) {
  return doc.line(Math.max(1, Math.min(lineNumber, doc.lines)));
}

function offsetAt(doc: Text, position: EditorPosition): number {
  const line = clampLine(doc, position.lineNumber);
  return line.from + Math.max(0, Math.min(position.column - 1, line.length));
}

export function positionAt(doc: Text, offset: number): EditorPosition {
  const line = doc.lineAt(Math.max(0, Math.min(offset, doc.length)));
  return { column: offset - line.from + 1, lineNumber: line.number };
}

export function rangeFromOffsets(doc: Text, from: number, to: number): EditorRange {
  const start = positionAt(doc, from);
  const end = positionAt(doc, to);
  return {
    endColumn: end.column,
    endLineNumber: end.lineNumber,
    startColumn: start.column,
    startLineNumber: start.lineNumber
  };
}

function offsetsOfRange(doc: Text, range: EditorRange): { from: number; to: number } {
  const from = offsetAt(doc, { column: range.startColumn, lineNumber: range.startLineNumber });
  const to = offsetAt(doc, { column: range.endColumn, lineNumber: range.endLineNumber });
  return from <= to ? { from, to } : { from: to, to: from };
}

function toEditorSelection(doc: Text, range: { anchor: number; head: number }): WorkbenchEditorSelection {
  const anchor = positionAt(doc, range.anchor);
  const head = positionAt(doc, range.head);
  return new CmSelection(anchor.lineNumber, anchor.column, head.lineNumber, head.column);
}

export interface CmEditorHandleInternals {
  emitContentChanged(event: EditorContentChangedEvent): void;
  emitCursorPositionChanged(): void;
  emitType(text: string): void;
  notifyDisposed(): void;
  notifyModelChanged(): void;
}

export interface CmEditorHandleBundle {
  handle: WorkbenchEditorHandle;
  internals: CmEditorHandleInternals;
}

function createListenerSet<T>() {
  const listeners = new Set<(event: T) => void>();
  return {
    add: (listener: (event: T) => void): EditorDisposable => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    clear: () => listeners.clear(),
    emit: (event: T) => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    }
  };
}

export function createCmEditorHandle(getView: () => EditorView | null): CmEditorHandleBundle {
  const contentChangedListeners = createListenerSet<EditorContentChangedEvent>();
  const cursorPositionListeners = createListenerSet<void>();
  const scrollListeners = createListenerSet<EditorScrollEvent>();
  const focusListeners = createListenerSet<void>();
  const modelListeners = createListenerSet<void>();
  const disposeListeners = createListenerSet<void>();
  const typeListeners = createListenerSet<string>();

  const getDoc = () => getView()?.state.doc ?? Text.empty;

  // --- scroll / focus DOM listeners ---------------------------------------
  const viewAtCreation = getView();
  let lastScrollTop = viewAtCreation?.scrollDOM.scrollTop ?? 0;
  let lastScrollLeft = viewAtCreation?.scrollDOM.scrollLeft ?? 0;

  const handleScroll = () => {
    const view = getView();
    if (!view) {
      return;
    }
    const scrollTop = view.scrollDOM.scrollTop;
    const scrollLeft = view.scrollDOM.scrollLeft;
    const event: EditorScrollEvent = {
      scrollLeftChanged: scrollLeft !== lastScrollLeft,
      scrollTopChanged: scrollTop !== lastScrollTop
    };
    lastScrollTop = scrollTop;
    lastScrollLeft = scrollLeft;
    if (event.scrollTopChanged || event.scrollLeftChanged) {
      scrollListeners.emit(event);
    }
  };

  const handleFocus = () => focusListeners.emit(undefined);

  viewAtCreation?.scrollDOM.addEventListener("scroll", handleScroll);
  viewAtCreation?.contentDOM.addEventListener("focus", handleFocus);

  let disposed = false;

  // --- model handle --------------------------------------------------------
  const model: WorkbenchTextModelHandle = {
    getValue: () => getDoc().toString(),
    getLineCount: () => getDoc().lines,
    getLineContent: (lineNumber) => clampLine(getDoc(), lineNumber).text,
    getLineMaxColumn: (lineNumber) => clampLine(getDoc(), lineNumber).length + 1,
    getLineFirstNonWhitespaceColumn: (lineNumber) => {
      const line = clampLine(getDoc(), lineNumber);
      const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
      // Monaco returns line.length + 1 for whitespace-only (and empty) lines.
      return indent < line.length ? indent + 1 : line.length + 1;
    },
    getValueInRange: (range) => {
      const doc = getDoc();
      const { from, to } = offsetsOfRange(doc, range);
      return doc.sliceString(from, to);
    },
    getOffsetAt: (position) => offsetAt(getDoc(), position),
    getPositionAt: (offset) => positionAt(getDoc(), offset),
    getFullModelRange: () => {
      const doc = getDoc();
      return {
        endColumn: doc.line(doc.lines).length + 1,
        endLineNumber: doc.lines,
        startColumn: 1,
        startLineNumber: 1
      };
    },
    getEOL: () => "\n",
    findMatches: (searchString, _searchOnlyEditableRange, isRegex, matchCase, _wordSeparators, _captureMatches) => {
      // `searchOnlyEditableRange` / `wordSeparators` have no CM equivalent here
      // (single full-document editable range); `captureMatches` only affects
      // match-group reporting, which the neutral interface does not expose.
      const doc = getDoc();
      const text = doc.toString();
      const matches: Array<{ range: EditorRange }> = [];
      if (searchString.length === 0) {
        return matches;
      }

      if (isRegex) {
        let regex: RegExp;
        try {
          regex = new RegExp(searchString, matchCase ? "gm" : "gim");
        } catch {
          return matches;
        }
        for (const match of text.matchAll(regex)) {
          matches.push({ range: rangeFromOffsets(doc, match.index, match.index + match[0].length) });
        }
        return matches;
      }

      const haystack = matchCase ? text : text.toLowerCase();
      const needle = matchCase ? searchString : searchString.toLowerCase();
      let index = haystack.indexOf(needle);
      while (index !== -1) {
        matches.push({ range: rangeFromOffsets(doc, index, index + needle.length) });
        index = haystack.indexOf(needle, index + needle.length);
      }
      return matches;
    }
  };

  const snippetController: SnippetControllerHandle = {
    insert: (template) => {
      const view = getView();
      if (view) {
        const { main } = view.state.selection;
        insertCmSnippet(view, template, main.from, main.to);
      }
    },
    isInSnippet: () => {
      const view = getView();
      return view ? isCmSnippetActive(view.state) : false;
    }
  };

  const handle: WorkbenchEditorHandle = {
    getValue: () => model.getValue(),

    executeEdits: (_source, edits: EditorEditOperation[]) => {
      const view = getView();
      if (!view) {
        return false;
      }
      if (edits.length === 0) {
        return true;
      }

      const { state } = view;
      const doc = state.doc;
      const resolved = edits.map((edit) => ({
        ...offsetsOfRange(doc, edit.range),
        forceMoveMarkers: edit.forceMoveMarkers === true,
        insert: edit.text
      }));
      // Apply all edits in a single dispatch; descending offset order keeps
      // earlier edits' coordinates valid (CM normalizes order internally
      // anyway) and mirrors how Monaco batches executeEdits operations.
      resolved.sort((a, b) => b.from - a.from || b.to - a.to);

      const changeSpecs: ChangeSpec[] = resolved.map(({ from, insert, to }) => ({ from, insert, to }));
      const changeSet = state.changes(changeSpecs);

      let selection: EditorSelection;
      if (resolved.some((edit) => edit.forceMoveMarkers)) {
        // forceMoveMarkers: selections move with the edit (assoc 1 ≈ end of
        // inserted text), matching Monaco's tracked-marker behavior.
        selection = state.selection.map(changeSet, 1);
      } else {
        // Approximation of Monaco's default (forceMoveMarkers: false):
        // selections touching an edit are mapped through it; disjoint
        // selections keep their original offsets (clamped to the new length)
        // rather than shifting with text before them. An insertion point
        // counts as touching a caret at the same offset, so typing-style
        // inserts still leave the cursor after the inserted text.
        const touchesEdit = (from: number, to: number) =>
          resolved.some((edit) =>
            edit.from === edit.to
              ? from <= edit.from && edit.from <= to
              : from <= edit.to && edit.from <= to
          );
        selection = EditorSelection.create(
          state.selection.ranges.map((range) => {
            if (!touchesEdit(range.from, range.to)) {
              return EditorSelection.range(
                Math.min(range.anchor, changeSet.newLength),
                Math.min(range.head, changeSet.newLength)
              );
            }
            return EditorSelection.range(
              changeSet.mapPos(range.anchor, 1),
              changeSet.mapPos(range.head, 1)
            );
          }),
          state.selection.mainIndex
        );
      }

      view.dispatch({ changes: changeSpecs, selection });
      return true;
    },

    // CM has no explicit undo-stop command: its history groups changes by
    // time/user-event automatically, so isolation happens naturally between
    // discrete user actions. Kept as a documented no-op for parity.
    pushUndoStop: () => {},

    trigger: (_source, commandId, args) => {
      const view = getView();
      if (!view) {
        return;
      }
      switch (commandId) {
        case "type": {
          const text = String((args as { text?: unknown } | null)?.text ?? "");
          view.dispatch({
            ...view.state.replaceSelection(text),
            annotations: Transaction.userEvent.of("input.type")
          });
          break;
        }
        case "editor.action.triggerSuggest":
          startCompletion(view);
          break;
        case "hideSuggestWidget":
          closeCompletion(view);
          break;
        case "acceptSelectedSuggestion":
          acceptCompletion(view);
          break;
        case "jumpToNextSnippetPlaceholder":
          nextCmSnippetField({ dispatch: view.dispatch, state: view.state });
          break;
        case "jumpToPrevSnippetPlaceholder":
          prevCmSnippetField({ dispatch: view.dispatch, state: view.state });
          break;
        default:
          // Monaco-specific command ids (e.g. editor.action.copyLinesDownAction)
          // have no CM equivalent yet: deliberate silent no-op.
          break;
      }
    },

    getPosition: () => {
      const view = getView();
      return view ? positionAt(view.state.doc, view.state.selection.main.head) : null;
    },
    setPosition: (position) => {
      const view = getView();
      if (!view) {
        return;
      }
      const offset = offsetAt(view.state.doc, position);
      view.dispatch({ selection: { anchor: offset } });
    },
    getSelection: () => {
      const view = getView();
      return view ? toEditorSelection(view.state.doc, view.state.selection.main) : null;
    },
    getSelections: () => {
      const view = getView();
      return view ? view.state.selection.ranges.map((range) => toEditorSelection(view.state.doc, range)) : null;
    },
    setSelection: (selection) => {
      const view = getView();
      if (!view) {
        return;
      }
      const doc = view.state.doc;
      const anchorPosition: EditorPosition =
        "selectionStartLineNumber" in selection
          ? { column: selection.selectionStartColumn, lineNumber: selection.selectionStartLineNumber }
          : { column: selection.startColumn, lineNumber: selection.startLineNumber };
      const headPosition: EditorPosition =
        "positionLineNumber" in selection
          ? { column: selection.positionColumn, lineNumber: selection.positionLineNumber }
          : { column: selection.endColumn, lineNumber: selection.endLineNumber };
      view.dispatch({
        selection: { anchor: offsetAt(doc, anchorPosition), head: offsetAt(doc, headPosition) }
      });
    },
    setSelections: (selections) => {
      const view = getView();
      if (!view || selections.length === 0) {
        return;
      }
      const doc = view.state.doc;
      view.dispatch({
        selection: EditorSelection.create(
          selections.map((selection) =>
            EditorSelection.range(
              offsetAt(doc, { column: selection.selectionStartColumn, lineNumber: selection.selectionStartLineNumber }),
              offsetAt(doc, { column: selection.positionColumn, lineNumber: selection.positionLineNumber })
            )
          ),
          0
        )
      });
    },

    getScrollTop: () => getView()?.scrollDOM.scrollTop ?? 0,
    getScrollLeft: () => getView()?.scrollDOM.scrollLeft ?? 0,
    setScrollTop: (value) => {
      const view = getView();
      if (view) {
        view.scrollDOM.scrollTop = value;
      }
    },
    setScrollLeft: (value) => {
      const view = getView();
      if (view) {
        view.scrollDOM.scrollLeft = value;
      }
    },
    revealLineInCenter: (lineNumber) => {
      const view = getView();
      if (!view) {
        return;
      }
      const pos = clampLine(view.state.doc, lineNumber).from;
      view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    },
    revealPosition: (position) => {
      const view = getView();
      if (!view) {
        return;
      }
      view.dispatch({ effects: EditorView.scrollIntoView(offsetAt(view.state.doc, position)) });
    },

    onDidChangeModelContent: (listener) => contentChangedListeners.add(listener),
    onDidChangeCursorPosition: (listener) => cursorPositionListeners.add(listener),
    onDidScrollChange: (listener) => scrollListeners.add(listener),
    onDidFocusEditorText: (listener) => focusListeners.add(listener),
    onDidChangeModel: (listener) => modelListeners.add(listener),
    onDidDispose: (listener) => disposeListeners.add(listener),
    onDidType: (listener) => typeListeners.add(listener),

    getModel: () => (getView() ? model : null),
    getDomNode: () => getView()?.dom ?? null,
    hasTextFocus: () => getView()?.hasFocus ?? false,
    focus: () => getView()?.focus(),
    getSnippetController: () => snippetController,
    getOption: (option: EditorOptionId) => {
      switch (option) {
        case EditorOption.readOnly:
          return getView()?.state.readOnly ?? false;
      }
    },

    // CM reports the suggest widget from its completion state ("pending"
    // counts as visible: the panel is about to open, matching Monaco's
    // DOM-observed lifecycle closely enough for when-context gating).
    getEditorFeatureState: () => {
      const view = getView();
      return {
        suggestWidgetVisible: view ? completionStatus(view.state) !== null : false
      };
    }
  };

  const internals: CmEditorHandleInternals = {
    emitContentChanged: (event) => {
      if (!disposed) {
        contentChangedListeners.emit(event);
      }
    },
    emitCursorPositionChanged: () => {
      if (!disposed) {
        cursorPositionListeners.emit(undefined);
      }
    },
    emitType: (text) => {
      if (!disposed) {
        typeListeners.emit(text);
      }
    },
    notifyDisposed: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      const view = getView();
      view?.scrollDOM.removeEventListener("scroll", handleScroll);
      view?.contentDOM.removeEventListener("focus", handleFocus);
      disposeListeners.emit(undefined);
      contentChangedListeners.clear();
      cursorPositionListeners.clear();
      scrollListeners.clear();
      focusListeners.clear();
      modelListeners.clear();
      disposeListeners.clear();
      typeListeners.clear();
    },
    notifyModelChanged: () => {
      if (!disposed) {
        modelListeners.emit(undefined);
      }
    }
  };

  return { handle, internals };
}
