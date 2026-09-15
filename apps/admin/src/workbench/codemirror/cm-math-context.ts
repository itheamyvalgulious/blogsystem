import { StateField, type EditorState, type Extension, type Text } from "@codemirror/state";

import {
  createInitialMarkdownMathContextState,
  scanDocumentMathPairs,
  scanMarkdownMathLine,
  type MarkdownMathContextState
} from "../../markdown-math-scanner";
import { getSnippetLanguageFromMathPairs } from "../../snippet-context";
import type { SnippetLanguageId } from "../types";

/**
 * Per-line markdown-math context state field for CodeMirror.
 *
 * This field keeps the `MarkdownMathContextState` entering each line
 * (and the final state after the last line) incrementally: only changed
 * lines are rescanned, with an early-exit re-sync past the edit region.
 *
 * The completion source's snippet-language query therefore stays O(caret
 * line + rare forward walk) per keystroke, instead of O(document).
 * Semantics are identical to
 * `getSnippetLanguageFromMathPairs(scanDocumentMathPairs(text), line, col)`.
 *
 * Field value invariant: `value[k]` = entering state for 1-based line
 * `k+1`, for `k = 0..doc.lines`; `value[doc.lines]` is the state after
 * the last line. So `value.length === state.doc.lines + 1`.
 *
 * No monaco imports: this module must stay loadable in Node test runs.
 */

function statesEqual(a: MarkdownMathContextState, b: MarkdownMathContextState): boolean {
  return a.inFenceMarker === b.inFenceMarker && a.inMath === b.inMath;
}

/** Full recompute (doc creation / defensive fallback). Exported for tests. */
export function computeCmMathLineStates(doc: Text): MarkdownMathContextState[] {
  const states: MarkdownMathContextState[] = new Array(doc.lines + 1);
  let state = createInitialMarkdownMathContextState();
  for (let line = 1; line <= doc.lines; line += 1) {
    states[line - 1] = state;
    state = scanMarkdownMathLine(doc.line(line).text, state).nextState;
  }
  states[doc.lines] = state;
  return states;
}

export const cmMathContextField = StateField.define<MarkdownMathContextState[]>({
  create: (state) => computeCmMathLineStates(state.doc),

  update: (value, tr) => {
    if (!tr.docChanged) return value;
    const oldDoc = tr.startState.doc;
    const newDoc = tr.newDoc;
    if (value.length !== oldDoc.lines + 1) {
      return computeCmMathLineStates(newDoc);
    }
    let firstLine = oldDoc.lines + 1;
    let lastNewLine = 0;
    tr.changes.iterChangedRanges((fromA, _toA, fromB, toB) => {
      firstLine = Math.min(firstLine, oldDoc.lineAt(fromA).number);
      lastNewLine = Math.max(lastNewLine, newDoc.lineAt(Math.max(fromB, toB)).number);
    });
    const delta = newDoc.lines - oldDoc.lines;
    const next: MarkdownMathContextState[] = new Array(newDoc.lines + 1);
    for (let k = 0; k < firstLine - 1; k += 1) {
      next[k] = value[k];
    }
    let entering = value[firstLine - 1] ?? createInitialMarkdownMathContextState();
    for (let line = firstLine; line <= newDoc.lines; line += 1) {
      next[line - 1] = entering;
      entering = scanMarkdownMathLine(newDoc.line(line).text, entering).nextState;
      if (line > lastNewLine) {
        const aligned = line - delta;
        if (aligned >= 1 && aligned <= oldDoc.lines + 1 && statesEqual(next[line - 1], value[aligned - 1])) {
          for (let k = line; k <= newDoc.lines; k += 1) {
            next[k] = value[k - delta];
          }
          return next;
        }
      }
    }
    next[newDoc.lines] = entering;
    return next;
  }
});

export const cmMathContextExtension: Extension = cmMathContextField;

/**
 * Whether 1-based (col) on a line with the given entering state sits inside a
 * math region that the pair scanner would report as a closed MathPair.
 */
export function isMathPositionInLineStates(
  lineStates: readonly MarkdownMathContextState[],
  doc: Text,
  lineNumber: number,
  lineText: string,
  col: number
): boolean {
  const entering = lineStates[lineNumber - 1] ?? createInitialMarkdownMathContextState();
  const { mathRanges, nextState } = scanMarkdownMathLine(lineText, entering);
  for (let index = 0; index < mathRanges.length; index += 1) {
    const range = mathRanges[index];
    const isLast = index === mathRanges.length - 1;
    if (isLast && nextState.inMath !== null) {
      // Region continues past this line. It counts as math only if it
      // eventually closes (an unclosed region never becomes a MathPair).
      if (col < range.startIndex + 1 || col > lineText.length + 1) {
        continue;
      }
      // Scan subsequent lines with state tracking to detect when the
      // unclosed mode actually closes. A mode can close on a line even
      // when the line's resulting nextState.inMath stays the same mode
      // (close + reopen on the same line).
      const unclosedMode = nextState.inMath;
      let scanState: MarkdownMathContextState = nextState;
      for (let k = lineNumber + 1; k <= doc.lines; k += 1) {
        const lineTextK = doc.line(k).text;
        const result = scanMarkdownMathLine(lineTextK, scanState);
        if (scanState.inMath === unclosedMode) {
          // Mode change or a range that closed on this line.
          const closed = result.nextState.inMath !== unclosedMode ||
            (result.mathRanges.length > 0 && result.mathRanges[0].endIndex < lineTextK.length);
          if (closed) {
            return true;
          }
        }
        scanState = result.nextState;
      }
      return false;
    }
    if (col >= range.startIndex + 1 && col <= range.endIndex) {
      return true;
    }
  }
  return false;
}

/**
 * "latex" when the caret position sits inside a (closed) math region of the
 * document, "markdown" otherwise — semantically identical to
 * `getSnippetLanguageFromMathPairs(scanDocumentMathPairs(doc), line, col)`.
 */
export function getCmMathLanguageAt(state: EditorState, pos: number): SnippetLanguageId {
  const doc = state.doc;
  const safePos = Math.max(0, Math.min(pos, doc.length));
  const line = doc.lineAt(safePos);
  const col = safePos - line.from + 1;
  const lineStates = state.field(cmMathContextField, false);
  if (lineStates && lineStates.length === doc.lines + 1) {
    return isMathPositionInLineStates(lineStates, doc, line.number, line.text, col) ? "latex" : "markdown";
  }
  // Fallback for states that do not install the field: the pre-field
  // full-document scan with identical semantics.
  return getSnippetLanguageFromMathPairs(scanDocumentMathPairs(doc.toString()), line.number, col);
}