import type { Extension, Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate
} from "@codemirror/view";

import {
  scanDocumentMathPairs,
  tokenizeLatexMathFragment
} from "../../markdown-math-scanner";

/**
 * LaTeX math highlighting for the CodeMirror "live" engine.
 *
 * `scanDocumentMathPairs` locates `$...$`/`$$...$$` regions over the whole
 * document; inside each region the shared `tokenizeLatexMathFragment`
 * classifier splits the fragment into keyword/comment/number/delimiter/type
 * tokens, emitted as `.cm-mtok-*` mark decorations. Everything outside math
 * regions is left to @codemirror/lang-markdown's base highlighting.
 *
 * Decorations are computed for the visible viewport only (viewport-driven
 * ViewPlugin), and recomputed on document/viewport changes. The scan is cheap
 * and always in sync with the current buffer.
 *
 * No monaco imports: this module must stay loadable in Node test runs.
 */

const MATH_TOKEN_CLASS_PREFIX = "cm-mtok-";

export interface LatexMathTokenSpan {
  className: string;
  from: number;
  to: number;
}

/**
 * Adapts `tokenizeLatexMathFragment` (startIndex/scopes pairs) to absolute
 * spans with a CSS class per token; whitespace (empty scope) is skipped.
 * Pure and fragment-relative — the ViewPlugin adds the region offset.
 */
export function classifyLatexMathFragment(fragment: string): LatexMathTokenSpan[] {
  const tokens = tokenizeLatexMathFragment(fragment, 0);
  const spans: LatexMathTokenSpan[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const from = token.startIndex;
    const to = index + 1 < tokens.length ? tokens[index + 1].startIndex : fragment.length;
    if (!token.scopes || to <= from) {
      continue;
    }
    spans.push({ className: `${MATH_TOKEN_CLASS_PREFIX}${token.scopes}`, from, to });
  }

  return spans;
}

function buildMathDecorations(
  view: EditorView
): DecorationSet {
  const { state } = view;
  const doc = state.doc;
  const pairs = scanDocumentMathPairs(doc.toString());
  if (pairs.length === 0) {
    return Decoration.none;
  }

  const markCache = new Map<string, Decoration>();
  const markFor = (className: string): Decoration => {
    let mark = markCache.get(className);
    if (!mark) {
      mark = Decoration.mark({ class: className });
      markCache.set(className, mark);
    }
    return mark;
  };

  const ranges: Range<Decoration>[] = [];
  for (const pair of pairs) {
    const startLine = doc.line(Math.min(pair.startLine, doc.lines));
    const endLine = doc.line(Math.min(pair.endLine, doc.lines));
    const from = startLine.from + pair.startCol - 1;
    // MathPair.endCol is the end-exclusive 0-based offset within the line
    // (see markdown-math-scanner.scanDocumentMathPairs).
    const to = Math.min(endLine.from + pair.endCol, doc.length);
    if (to <= from) {
      continue;
    }
    const visible = view.visibleRanges.some(
      (range) => range.to >= from && range.from <= to
    );
    if (!visible) {
      continue;
    }

    const fragment = doc.sliceString(from, to);
    for (const span of classifyLatexMathFragment(fragment)) {
      ranges.push(markFor(span.className).range(from + span.from, from + span.to));
    }
  }

  return Decoration.set(ranges, true);
}

export const cmMathHighlight: Extension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildMathDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildMathDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations }
);
