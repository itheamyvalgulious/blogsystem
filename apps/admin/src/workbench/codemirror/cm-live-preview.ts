import {
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
  type Text
} from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate, type WidgetType } from "@codemirror/view";

import { markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownConfig } from "@lezer/markdown";
import { scanDocumentMathPairs } from "../../markdown-math-tokenization";
import { hashText } from "../../utils";
import {
  getWorkbenchLivePreviewContext,
  onWorkbenchLivePreviewContextChange,
  type WorkbenchLivePreviewContext
} from "./cm-context";
// Import-cycle note: cm-live-preview-float imports runtime helpers from this
// module. The getter is hoisted and everything it resolves lives inside
// function bodies, so the cycle is safe in both evaluation orders.
import { getCmLivePreviewFloatExtension } from "./cm-live-preview-float";
import {
  createImageRowWidget,
  createInlineMathReplaceWidget,
  createInlineMathRowWidget,
  createMathBlockWidget,
  createRichBlockWidget,
  type LivePreviewImageItem,
  type PreviewJumpProvider
} from "./cm-live-preview-widgets";
// One-directional dependency: cm-reading-mode imports nothing from here.
import {
  cmReadingModeSupport,
  getReadingMode,
  isInCursorRegion,
  readingModeRefresh
} from "./cm-reading-mode";

/**
 * WYSIWYG "live preview" mosaic for the CodeMirror engine.
 *
 * `computeLivePreviewRanges` is the pure, DOM-free half: it scans the document
 * text and returns structured ranges (headings, inline-math rows, `$$` blocks,
 * images, GFM tables, fences). The StateField below only maps those ranges to
 * decorations and instantiates widgets (which live in
 * cm-live-preview-widgets.ts).
 *
 * Interaction model: source text is ALWAYS visible and editable — there are
 * no replace decorations and no selection-dependent collapse. Headings are
 * styled in place; block constructs (images, `$$` blocks, tables, fences)
 * get a persistent block widget below the relevant source line(s) rendering
 * the preview panel, while inline `$...$` formulas get a preview BAND right
 * after the formula: an inline (NON-block) widget styled as a full-width
 * inline-level box, so it wraps onto its own line box and pushes the
 * following text down (see InlineMathRowWidget for why it must never go
 * back to a mid-line block widget).
 *
 * On top of that, inline/line markdown constructs are styled directly on the
 * source (Typora/Obsidian-style) via `computeLivePreviewStyles`: it parses
 * the document with the very same lezer grammar the editor uses
 * (`markdownLanguage.parser` — nested emphasis/escapes stay correct) and
 * emits mark spans (bold/italic/strike/inline-code/link/url/delimiter fades,
 * list markers) plus line classes (blockquote bars, setext headings, hr).
 *
 * Code area detection: a line scanner tracks fenced code blocks (CommonMark
 * rule — closing fence must reuse the opening character with at least the
 * opening length) and, conservatively, indented code chunks (a line indented
 * by 4+ spaces / a tab following a blank or indented-code line; list-embedded
 * indentation is not modelled — a false positive only skips previews, never
 * corrupts them). YAML frontmatter at the document start is skipped as well.
 * This mirrors the approach `scanDocumentMathPairs` already uses for math, and
 * keeps the pure function free of any lezer/EditorState dependency so it stays
 * testable in Node.
 *
 * Performance: whole-document scans are cached in a WeakMap keyed by the
 * (immutable) Text object, so document edits rescan once. Decorations are
 * rebuilt for the whole document on each relevant transaction (cheap: they
 * are constructed from the cached ranges), while widget instantiation stays
 * lazy — CM only mounts widgets inside the viewport — and already-rendered
 * widgets survive via the content-key LRU cache in cm-live-preview-widgets.ts.
 *
 * CM6 hard rule (runtime-enforced): decorations that affect vertical layout —
 * `Decoration.line`, block widgets (`widget({block: true})`) and block
 * replacements (`replace({block: true})`) — may NOT be provided through a
 * ViewPlugin's decorations ("Block decorations may not be specified via
 * plugins"). They must come from state, hence the `StateField` +
 * `EditorView.decorations` facet wiring below. Do not move these back into a
 * ViewPlugin; plugin-provided decorations are only legal for marks and
 * non-block widgets (see cm-math-highlight / cm-inline-completion).
 *
 * No monaco imports: this module must stay loadable in Node test runs.
 */

export interface LivePreviewHeadingRange {
  kind: "heading";
  /** Line start offset. */
  from: number;
  /** Line end offset. */
  to: number;
  level: number;
  markerFrom: number;
  markerTo: number;
}

export interface LivePreviewInlineMathFormula {
  from: number;
  to: number;
  /** TeX source without the surrounding `$` delimiters. */
  tex: string;
}

export interface LivePreviewInlineMathRange {
  kind: "inlineMath";
  /** Formula start offset (the opening `$`). */
  from: number;
  /** Formula end offset — the preview band anchors here, landing under the
   *  formula's own visual line even in wrapped paragraphs. */
  to: number;
  formulas: LivePreviewInlineMathFormula[];
}

export interface LivePreviewBlockMathRange {
  kind: "blockMath";
  /** Start of the opening `$$` line. */
  from: number;
  /** End of the closing `$$` line (preview widget anchor position). */
  to: number;
  /** Full covered source text, delimiters included. */
  source: string;
}

export type { LivePreviewImageItem };

export interface LivePreviewImageRange {
  kind: "image";
  from: number;
  to: number;
  images: LivePreviewImageItem[];
}

export interface LivePreviewTableRange {
  kind: "table";
  /** Start of the header line. */
  from: number;
  /** End of the last table line (preview widget anchor position). */
  to: number;
  source: string;
}

export interface LivePreviewFenceRange {
  kind: "fence";
  /** Start of the opening fence line. */
  from: number;
  /** End of the closing fence line (preview widget anchor position). */
  to: number;
  source: string;
  /** Info-string language; "" for plain fenced code blocks. */
  language: string;
}

export type LivePreviewRange =
  | LivePreviewHeadingRange
  | LivePreviewInlineMathRange
  | LivePreviewBlockMathRange
  | LivePreviewImageRange
  | LivePreviewTableRange
  | LivePreviewFenceRange;

const HEADING_RE = /^( {0,3})(#{1,6})([ \t]+|$)/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const FRONTMATTER_FENCE_RE = /^ {0,3}---\s*$/;
const IMAGE_RE = /!\[([^\]]*)\]\(\s*(<[^>]*>|\S+?)(?:\s+["'][^"']*["'])?\s*\)/g;
const TABLE_DELIMITER_CELL_RE = /^:?-+:?$/;

interface FenceBlock {
  startLine: number;
  endLine: number;
  language: string;
}

interface LineScan {
  lines: string[];
  lineStarts: number[];
  /** Fenced code, (simplified) indented code or frontmatter lines. */
  codeLine: boolean[];
  fences: FenceBlock[];
}

function scanLines(text: string): LineScan {
  const lines = text.split("\n");
  const lineStarts: number[] = new Array(lines.length);
  const codeLine: boolean[] = new Array(lines.length).fill(false);
  const fences: FenceBlock[] = [];

  let offset = 0;
  for (let index = 0; index < lines.length; index += 1) {
    lineStarts[index] = offset;
    offset += lines[index].length + 1;
  }

  // YAML frontmatter: only when a closing `---` exists (same rule as
  // computeBodyLineOffset in preview-utils.ts).
  let frontmatterEnd = -1;
  if (lines.length > 0 && FRONTMATTER_FENCE_RE.test(lines[0])) {
    for (let index = 1; index < lines.length; index += 1) {
      if (FRONTMATTER_FENCE_RE.test(lines[index])) {
        frontmatterEnd = index;
        break;
      }
    }
  }
  for (let index = 0; index <= frontmatterEnd; index += 1) {
    codeLine[index] = true;
  }

  let fenceChar = "";
  let fenceLength = 0;
  let fenceStartLine = -1;
  let fenceLanguage = "";
  // Indented code (simplified): 4+ spaces / tab right after a blank line or
  // another indented-code line. See module comment for the trade-off.
  let blankOrIndentedBefore = true;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (index <= frontmatterEnd) {
      blankOrIndentedBefore = false;
      continue;
    }

    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      if (fenceChar && marker[0] === fenceChar && marker.length >= fenceLength) {
        codeLine[index] = true;
        fences.push({ startLine: fenceStartLine, endLine: index, language: fenceLanguage });
        fenceChar = "";
        blankOrIndentedBefore = false;
        continue;
      }
      if (!fenceChar) {
        fenceChar = marker[0];
        fenceLength = marker.length;
        fenceStartLine = index;
        fenceLanguage = line.slice(fenceMatch[0].length).trim().split(/\s+/)[0] ?? "";
        codeLine[index] = true;
        blankOrIndentedBefore = false;
        continue;
      }
      // Non-matching fence marker inside an open fence: plain content.
    }

    if (fenceChar) {
      codeLine[index] = true;
      continue;
    }

    if (line.trim() === "") {
      blankOrIndentedBefore = true;
      continue;
    }

    if (/^(?: {4}|\t)/.test(line) && blankOrIndentedBefore) {
      codeLine[index] = true;
      blankOrIndentedBefore = true;
      continue;
    }

    blankOrIndentedBefore = false;
  }

  // An unclosed fence runs to end of document (CommonMark).
  if (fenceChar) {
    fences.push({ startLine: fenceStartLine, endLine: lines.length - 1, language: fenceLanguage });
  }

  return { lines, lineStarts, codeLine, fences };
}

function splitTableRow(line: string): string[] | null {
  if (!line.includes("|")) {
    return null;
  }
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith("|")) {
    trimmed = trimmed.slice(0, -1);
  }
  // Escaped pipes (`\|`) are intentionally not honoured — keep the splitter
  // dumb; a false negative just means no table preview.
  return trimmed.split("|");
}

/** GFM pipe table: header row + valid delimiter row + >= 0 data rows. */
function matchTable(scan: LineScan, headerIndex: number): { endLine: number } | null {
  const { lines, codeLine } = scan;
  const delimiterIndex = headerIndex + 1;
  if (delimiterIndex >= lines.length || codeLine[headerIndex] || codeLine[delimiterIndex]) {
    return null;
  }

  const headerCells = splitTableRow(lines[headerIndex]);
  const delimiterCells = splitTableRow(lines[delimiterIndex]);
  if (
    !headerCells ||
    !delimiterCells ||
    headerCells.length !== delimiterCells.length ||
    !delimiterCells.every((cell) => TABLE_DELIMITER_CELL_RE.test(cell.trim()))
  ) {
    return null;
  }

  let endLine = delimiterIndex;
  while (
    endLine + 1 < lines.length &&
    !codeLine[endLine + 1] &&
    lines[endLine + 1].trim() !== "" &&
    lines[endLine + 1].includes("|")
  ) {
    endLine += 1;
  }

  return { endLine };
}

// --- Math-aware markdown grammar (DisplayMath / InlineMath) -----------------

const DOLLAR = 36; // `$`
const BACKSLASH = 92; // `\`

/** First index of an unescaped `$$` in `text` at/after `from`, or -1. */
function findClosingDoubleDollar(text: string, from: number): number {
  let index = from;
  while (index < text.length - 1) {
    const char = text.charCodeAt(index);
    if (char === BACKSLASH) {
      index += 2;
      continue;
    }
    if (char === DOLLAR && text.charCodeAt(index + 1) === DOLLAR) {
      return index;
    }
    index += 1;
  }
  return -1;
}

/**
 * Lezer/markdown extension teaching the editor's markdown grammar that TeX
 * math is ATOMIC: standalone `$$` blocks parse as `DisplayMath` (multi-line
 * eager leaf block, exactly the FencedCode shape — an unclosed block runs to
 * the end of input, tolerating the mid-typing state, and an opening line
 * whose closing `$$` sits on the same line with only whitespace after it
 * becomes a one-line block; trailing content demotes the line to a
 * paragraph), and `$...$` / `$$...$$` inside paragraphs parse as
 * `InlineMath` (a single `$` closes on the same line, `$$` may span the
 * paragraph's lines; an unclosed delimiter consumes to the line/section
 * end, again the mid-typing state). Neither node has children, so emphasis,
 * inline code, links, quotes and headings — and with them ALL lezer-driven
 * syntax highlighting — simply do not happen inside math, which is the
 * user-facing rule: "$$ and $ content never participates in markdown
 * parsing".
 *
 * This mirrors (but does not replace) `scanDocumentMathPairs`, which keeps
 * driving the app's math business logic — preview bands, block previews,
 * math highlight, range filtering. The same suppressions apply on both
 * channels: the inline parser is registered `before: "Emphasis"`, so
 * `Escape` and `InlineCode` consume `\$` and backtick-quoted `$` before it
 * can; the block parser carries FencedCode's indent guard so a 4-space
 * indented `$$` line stays indented code.
 *
 * The nodes intentionally define NO styleTags: cm-mtok-* decorations own
 * math coloring; this layer only suppresses markdown styling. It lives in
 * this module (rather than cm-editor) so headless tests can configure a
 * parser with it; cm-editor.tsx attaches it via `markdown({ extensions })`.
 * computeLivePreviewStyles keeps parsing with the base grammar on purpose —
 * its own math filtering already suppresses styles inside pairs, and the
 * base tree keeps the setext/heading tests meaningful.
 */
export const cmMathMarkdown: MarkdownConfig = {
  defineNodes: [{ name: "InlineMath" }, { name: "DisplayMath", block: true }],
  parseBlock: [
    {
      name: "DisplayMath",
      before: "FencedCode",
      endLeaf(_cx, line) {
        // A `$$` line interrupts a paragraph (like a fence opening) — but
        // not when it is indented code (the FencedCode guard).
        return (
          line.indent - line.baseIndent < 4 && line.text.slice(line.pos, line.pos + 2) === "$$"
        );
      },
      parse(cx, line) {
        if (line.indent - line.baseIndent >= 4 || line.text.slice(line.pos, line.pos + 2) !== "$$") {
          return false;
        }
        const from = cx.lineStart + line.pos;
        // Same-line close with whitespace-only after it → one-line block.
        // Anything after the closing `$$` demotes the line to a paragraph
        // (the inline parser atomizes the `$$...$$` pairs there instead).
        const rest = line.text.slice(line.pos + 2);
        const closeInRest = findClosingDoubleDollar(rest, 0);
        if (closeInRest >= 0) {
          if (rest.slice(closeInRest + 2).trim() !== "") {
            return false;
          }
          cx.nextLine();
          cx.addElement(cx.elt("DisplayMath", from, cx.prevLineEnd()));
          return true;
        }
        // Multi-line: consume until a line whose `$$` (whitespace-only
        // after it) closes the block, or the input ends (unclosed — same
        // as an unclosed fence). The `line` object is mutated by
        // cx.nextLine() — the FencedCode pattern.
        while (cx.nextLine()) {
          const closePos = findClosingDoubleDollar(line.text, line.pos);
          if (closePos >= 0 && line.text.slice(closePos + 2).trim() === "") {
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt("DisplayMath", from, cx.prevLineEnd()));
        return true;
      }
    }
  ],
  parseInline: [
    {
      name: "InlineMath",
      before: "Emphasis",
      parse(cx, next, pos) {
        if (next !== DOLLAR) {
          return -1;
        }
        const double = cx.char(pos + 1) === DOLLAR;
        const end = cx.end;
        let scan = pos + (double ? 2 : 1);
        while (scan < end) {
          const char = cx.char(scan);
          if (char === BACKSLASH) {
            scan += 2;
            continue;
          }
          if (char === DOLLAR) {
            if (double) {
              if (cx.char(scan + 1) === DOLLAR) {
                return cx.addElement(cx.elt("InlineMath", pos, scan + 2));
              }
              scan += 1;
              continue;
            }
            return cx.addElement(cx.elt("InlineMath", pos, scan + 1));
          }
          if (!double && char === 10) {
            break;
          }
          scan += 1;
        }
        // Unclosed (mid-typing): atomic to the line end (single `$`) or the
        // inline section's end (`$$`), never beyond.
        if (double) {
          return cx.addElement(cx.elt("InlineMath", pos, end));
        }
        let eol = pos + 1;
        while (eol < end && cx.char(eol) !== 10) {
          eol += 1;
        }
        return cx.addElement(cx.elt("InlineMath", pos, eol));
      }
    }
  ]
};

/**
 * Pure document scan → live preview ranges, sorted by `from`.
 *
 * Every block-level range (`blockMath`, `table`, `fence`) is a "below" range:
 * `from`..`to` covers the source lines (which always stay visible/editable)
 * and `to` — the end of the last covered line — is where the preview panel
 * widget is anchored. Inline-math ranges are per-formula: `from`..`to` is the
 * formula's own `$...$` span and the band anchors at `to` (the formula end).
 */
export function computeLivePreviewRanges(docText: string): LivePreviewRange[] {
  const scan = scanLines(docText);
  const { lines, lineStarts, codeLine, fences } = scan;
  const ranges: LivePreviewRange[] = [];
  const pendingInlineMath: LivePreviewInlineMathRange[] = [];
  const imagesByLine = new Map<number, LivePreviewImageItem[]>();
  const mathRanges = buildLivePreviewMathRanges(docText, lineStarts);

  // Block-preview ranges (block math, tables, fences) are collected
  // separately so per-line decorations covered by them (e.g. `$...$` inside
  // table cells — the table preview renders those) can be suppressed.
  const blockRanges: LivePreviewRange[] = [];

  // ALL fenced blocks get a preview: languages with a registered fence
  // renderer render through it, everything else renders as highlighted code
  // via the same markdown pipeline.
  for (const fence of fences) {
    const from = lineStarts[fence.startLine];
    const to = lineStarts[fence.endLine] + lines[fence.endLine].length;
    blockRanges.push({ kind: "fence", from, to, source: docText.slice(from, to), language: fence.language });
  }

  for (const pair of scanDocumentMathPairs(docText)) {
    const startLineIndex = pair.startLine - 1;
    const endLineIndex = pair.endLine - 1;
    if (codeLine[startLineIndex] || codeLine[endLineIndex]) {
      continue;
    }

    const startLineText = lines[startLineIndex];
    // MathPair.startCol is 1-based at the first `$`, so the character at
    // 0-based index `startCol` tells whether this is a `$$` pair.
    const isBlockPair = startLineText[pair.startCol] === "$";

    if (isBlockPair) {
      // Only standalone `$$` blocks (whitespace-only around the delimiters)
      // become preview blocks; `$$` inside a paragraph stays plain.
      const beforeOk = startLineText.slice(0, pair.startCol - 1).trim() === "";
      const afterOk = lines[endLineIndex].slice(pair.endCol).trim() === "";
      if (!beforeOk || !afterOk) {
        continue;
      }
      const from = lineStarts[startLineIndex];
      const to = lineStarts[endLineIndex] + lines[endLineIndex].length;
      blockRanges.push({ kind: "blockMath", from, to, source: docText.slice(from, to) });
      continue;
    }

    // Inline math: same-line `$...$` pairs only (spec excludes multi-line
    // inline math and `$$` pairs). ONE range per formula, anchored at the
    // formula end — the R3 band is an inline (non-block) widget right at
    // that offset; its full-width inline-level box wraps onto its own line
    // box directly under the formula's visual segment, even inside wrapped
    // paragraphs (multiple formulas on one visual line share one band via
    // groupInlineMathByVisualLine).
    if (pair.startLine !== pair.endLine) {
      continue;
    }
    const formulaFrom = lineStarts[startLineIndex] + pair.startCol - 1;
    // MathPair.endCol is the end-exclusive 0-based offset within the line.
    const formulaTo = lineStarts[endLineIndex] + pair.endCol;
    pendingInlineMath.push({
      kind: "inlineMath",
      from: formulaFrom,
      to: formulaTo,
      formulas: [{ from: formulaFrom, to: formulaTo, tex: startLineText.slice(pair.startCol, pair.endCol - 1) }]
    });
  }

  for (let index = 0; index < lines.length; index += 1) {
    if (codeLine[index]) {
      continue;
    }
    const line = lines[index];

    const headingMatch = HEADING_RE.exec(line);
    // ATX headings are markdown, not math: a `#` line inside a multi-line
    // `$$` block is suppressed like every other line-level construct.
    if (headingMatch && !intersectsMultiLineMathRange(mathRanges, lineStarts[index], lineStarts[index] + line.length)) {
      const indent = headingMatch[1].length;
      const hashes = headingMatch[2];
      const separator = headingMatch[3];
      const markerFrom = lineStarts[index] + indent;
      ranges.push({
        kind: "heading",
        from: lineStarts[index],
        to: lineStarts[index] + line.length,
        level: hashes.length,
        markerFrom,
        markerTo: markerFrom + hashes.length + separator.length
      });
    }

    IMAGE_RE.lastIndex = 0;
    let imageMatch: RegExpExecArray | null;
    while ((imageMatch = IMAGE_RE.exec(line)) !== null) {
      const rawSrc = imageMatch[2];
      const src = rawSrc.startsWith("<") && rawSrc.endsWith(">") ? rawSrc.slice(1, -1) : rawSrc;
      const images = imagesByLine.get(index) ?? [];
      images.push({ alt: imageMatch[1], src });
      imagesByLine.set(index, images);
    }

    const table = matchTable(scan, index);
    if (table) {
      const from = lineStarts[index];
      const to = lineStarts[table.endLine] + lines[table.endLine].length;
      blockRanges.push({ kind: "table", from, to, source: docText.slice(from, to) });
      index = table.endLine;
    }
  }

  const coveredByBlock = (lineIndex: number) => {
    const lineStart = lineStarts[lineIndex];
    return blockRanges.some((range) => range.from <= lineStart && lineStart <= range.to);
  };

  for (const inlineMathRange of pendingInlineMath) {
    if (coveredByBlock(lineIndexAt(lineStarts, inlineMathRange.from))) {
      continue;
    }
    ranges.push(inlineMathRange);
  }

  for (const [lineIndex, images] of imagesByLine) {
    if (coveredByBlock(lineIndex)) {
      continue;
    }
    ranges.push({
      kind: "image",
      from: lineStarts[lineIndex],
      to: lineStarts[lineIndex] + lines[lineIndex].length,
      images
    });
  }

  return [...blockRanges, ...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
}

// --- Inline / line source styling (Typora-style live styles) ----------------

export interface LivePreviewStyleSpan {
  from: number;
  to: number;
  className: string;
}

export interface LivePreviewLineStyle {
  /** Line start offset (Decoration.line anchor). */
  from: number;
  className: string;
}

export interface LivePreviewStyleScan {
  spans: LivePreviewStyleSpan[];
  lines: LivePreviewLineStyle[];
}

function lineIndexAt(lineStarts: number[], pos: number): number {
  let low = 0;
  let high = lineStarts.length - 1;
  let result = 0;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (lineStarts[mid] <= pos) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return result;
}

export interface LivePreviewMathRange {
  from: number;
  to: number;
  /** True for `$$...$$` pairs spanning multiple lines. */
  multiLine: boolean;
}

interface UnclosedMathOpener {
  from: number;
  line: number;
  mode: "inline" | "block";
}

/**
 * Finds the trailing UNCLOSED math opener, if any, using the same fence /
 * inline-code / escape / delimiter tracking as scanDocumentMathPairs. While
 * typing `$$` + Enter, the block is not yet a pair — without this the `$$`
 * line is parsed as markdown text and `====` on the next line becomes a
 * setext underline that inflates it (observed in the wild). Currency `$`
 * false positives are accepted (same trade-off as hasUnclosedMathDelimiter
 * in content-core: the user's `$` is overwhelmingly math).
 */
function findUnclosedMathOpener(docText: string, lineStarts: number[]): UnclosedMathOpener | null {
  const lines = docText.split("\n");
  let fenceMarker: string | null = null;
  let mathMode: "inline" | "block" | null = null;
  let opener: UnclosedMathOpener | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const fenceMatch = /^(?<marker>`{3,}|~{3,})/.exec(trimmed);
    if (fenceMatch) {
      const marker = fenceMatch.groups!.marker;
      if (fenceMarker === marker) {
        fenceMarker = null;
        continue;
      }
      if (!fenceMarker && !mathMode) {
        fenceMarker = marker;
        continue;
      }
    }
    if (fenceMarker) {
      continue;
    }

    let inlineCodeLen = 0;
    for (let j = 0; j < line.length; j += 1) {
      const ch = line[j];
      if (ch === "\\") {
        j += 1;
        continue;
      }
      if (!mathMode && ch === "`") {
        let run = 1;
        while (line[j + run] === "`") {
          run += 1;
        }
        if (inlineCodeLen === 0) {
          inlineCodeLen = run;
        } else if (inlineCodeLen === run) {
          inlineCodeLen = 0;
        }
        j += run - 1;
        continue;
      }
      if (inlineCodeLen > 0 || ch !== "$") {
        continue;
      }
      const delimLen = line[j + 1] === "$" ? 2 : 1;
      const mode: "inline" | "block" = delimLen === 2 ? "block" : "inline";
      if (mathMode === mode) {
        mathMode = null;
        opener = null;
      } else if (!mathMode) {
        mathMode = mode;
        opener = { from: lineStarts[i] + j, line: i, mode };
      }
      j += delimLen - 1;
    }
  }

  return mathMode ? opener : null;
}

/**
 * Absolute-offset math ranges for style filtering (see
 * computeLivePreviewStyles). Includes complete pairs AND the unclosed tail:
 * an unclosed `$$` extends from its opener's line start to end of document
 * (treated as multi-line); an unclosed single `$` extends to its logical
 * line end. Pure, unit-tested.
 */
export function buildLivePreviewMathRanges(docText: string, lineStarts: number[]): LivePreviewMathRange[] {
  const ranges = scanDocumentMathPairs(docText).map((pair) => ({
    from: lineStarts[pair.startLine - 1] + pair.startCol - 1,
    to: lineStarts[pair.endLine - 1] + pair.endCol,
    multiLine: pair.startLine !== pair.endLine
  }));

  const unclosed = findUnclosedMathOpener(docText, lineStarts);
  if (unclosed) {
    const lines = docText.split("\n");
    if (unclosed.mode === "block") {
      // Unclosed `$$`: from the opener line's start to end of document.
      ranges.push({ from: lineStarts[unclosed.line], to: docText.length, multiLine: true });
    } else {
      // Unclosed single `$`: from the opener to its logical line end.
      ranges.push({
        from: unclosed.from,
        to: lineStarts[unclosed.line] + lines[unclosed.line].length,
        multiLine: false
      });
    }
  }

  return ranges;
}

/** Span fully inside a math range → suppress (inline style filter). */
export function isInsideMathRange(ranges: LivePreviewMathRange[], from: number, to: number): boolean {
  return ranges.some((range) => range.from <= from && to <= range.to);
}

/** Marker position / line intersecting a multi-line `$$` range → suppress. */
export function intersectsMultiLineMathRange(
  ranges: LivePreviewMathRange[],
  from: number,
  to: number
): boolean {
  return ranges.some((range) => range.multiLine && range.from <= to && range.to >= from);
}

/**
 * Lezer-driven inline/line style scan, pure and Node-testable. Parses with
 * `markdownLanguage.parser` — the exact grammar the editor runs — so nesting,
 * escapes and reference links behave identically to the syntax highlighting.
 * Spans/lines falling on code lines (scanLines above) are dropped as a
 * backstop; the grammar itself already keeps inline constructs out of fenced
 * and indented code blocks.
 *
 * Node names relied on (verified against @codemirror/lang-markdown trees):
 * StrongEmphasis/Emphasis/Strikethrough (+ EmphasisMark/StrikethroughMark
 * delimiters), InlineCode (+ CodeMark, shared with FencedCode — parent
 * checked), Link/Image (+ LinkMark/URL/LinkTitle/LinkLabel), Autolink, bare
 * URL (GFM autolink), QuoteMark, ListMark, TaskMarker, HorizontalRule,
 * SetextHeading1/2 (+ HeaderMark).
 */
export function computeLivePreviewStyles(docText: string): LivePreviewStyleScan {
  const scan = scanLines(docText);
  const { lines, lineStarts, codeLine } = scan;
  const tree = markdownLanguage.parser.parse(docText);
  const spans: LivePreviewStyleSpan[] = [];
  const lineStyles: LivePreviewLineStyle[] = [];
  const seenLineStyles = new Set<string>();

  const onCodeLine = (from: number, to: number): boolean =>
    codeLine[lineIndexAt(lineStarts, from)] || codeLine[lineIndexAt(lineStarts, to)];

  // Math ranges in absolute offsets. User requirement: NOTHING inside a math
  // region participates in markdown parsing — so every style produced here
  // passes through these guards:
  // - inline spans are suppressed when fully INSIDE a math range
  //   (isInsideMathRange); spans CONTAINING math (e.g. `**$x$**`) are kept —
  //   their markdown markers live outside the math region, which is legal.
  // - line-level constructs (quote/list/task markers, setext headings, hr)
  //   are suppressed when their marker position or line INTERSECTS a
  //   MULTI-LINE `$$` range (intersectsMultiLineMathRange): a lone
  //   `-`/`>`/`=`/`---`/`#` line inside a `$$` block is math, not markdown.
  // Setext headings and horizontal rules that touch math are always
  // suppressed (a lone `=` / `---` line inside `$$` is legal setext/hr
  // syntax to the lezer parser, and without this guard an entire math block
  // gets styled as a giant heading — observed in the wild).
  const mathRanges = buildLivePreviewMathRanges(docText, lineStarts);

  const pushSpan = (from: number, to: number, className: string) => {
    if (to > from && !onCodeLine(from, to) && !isInsideMathRange(mathRanges, from, to)) {
      spans.push({ from, to, className });
    }
  };

  const pushLineStyle = (lineIndex: number, className: string) => {
    if (lineIndex < 0 || lineIndex >= lines.length || codeLine[lineIndex]) {
      return;
    }
    const lineFrom = lineStarts[lineIndex];
    if (intersectsMultiLineMathRange(mathRanges, lineFrom, lineFrom + lines[lineIndex].length)) {
      return;
    }
    const key = `${lineFrom}:${className}`;
    if (seenLineStyles.has(key)) {
      return;
    }
    seenLineStyles.add(key);
    lineStyles.push({ from: lineFrom, className });
  };

  tree.iterate({
    enter(node) {
      switch (node.name) {
        case "StrongEmphasis":
          pushSpan(node.from, node.to, "cm-lp-strong");
          break;
        case "Emphasis":
          pushSpan(node.from, node.to, "cm-lp-em");
          break;
        case "Strikethrough":
          pushSpan(node.from, node.to, "cm-lp-strike");
          break;
        case "EmphasisMark":
        case "StrikethroughMark":
          pushSpan(node.from, node.to, "cm-lp-marker");
          break;
        case "InlineCode":
          pushSpan(node.from, node.to, "cm-lp-code");
          break;
        case "CodeMark":
          // CodeMark also delimits fenced code blocks; fade only inline ticks.
          if (node.node.parent?.name === "InlineCode") {
            pushSpan(node.from, node.to, "cm-lp-marker");
          }
          break;
        case "Link":
        case "Image": {
          // Link text (between the first two LinkMark children) gets the link
          // style; the marks (including the image `!`), URL and title fade
          // via their own nodes below. Descend normally so nested inline
          // constructs (InlineCode inside the label, …) still get styled.
          let firstMark: { from: number; to: number } | null = null;
          let secondMark: { from: number; to: number } | null = null;
          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            if (child.name === "LinkMark") {
              if (!firstMark) {
                firstMark = child;
              } else {
                secondMark = child;
                break;
              }
            }
          }
          if (node.name === "Link" && firstMark && secondMark) {
            pushSpan(firstMark.to, secondMark.from, "cm-lp-link");
          }
          break;
        }
        case "Autolink":
          // Whole `<scheme:…>` node; skip descending so the inner URL /
          // LinkMark children are not styled twice.
          pushSpan(node.from, node.to, "cm-lp-url");
          return false;
        case "LinkMark":
        case "URL":
        case "LinkTitle":
        case "LinkLabel":
          // Bare URLs (GFM autolink) are plain URL nodes; inside Link/Image
          // the same nodes cover the destination and the brackets.
          pushSpan(node.from, node.to, "cm-lp-url");
          break;
        case "QuoteMark":
          pushSpan(node.from, node.to, "cm-lp-marker");
          pushLineStyle(lineIndexAt(lineStarts, node.from), "cm-lp-quote");
          break;
        case "ListMark":
          pushSpan(node.from, node.to, "cm-lp-listmark");
          break;
        case "TaskMarker": {
          pushSpan(node.from, node.to, "cm-lp-listmark");
          if (/x/i.test(docText.slice(node.from, node.to))) {
            // Completed task: strike the content to the end of its line.
            const lineIndex = lineIndexAt(lineStarts, node.to);
            pushSpan(node.to, lineStarts[lineIndex] + lines[lineIndex].length, "cm-lp-strike");
          }
          break;
        }
        case "HorizontalRule":
          if (!intersectsMultiLineMathRange(mathRanges, node.from, node.to)) {
            pushLineStyle(lineIndexAt(lineStarts, node.from), "cm-lp-hr");
          }
          break;
        case "SetextHeading1":
        case "SetextHeading2": {
          // Setext headings: style the heading's FINAL text line (the line
          // right before the underline), not node.from's line — a heading
          // whose text continues past a math block (e.g. `$$\nReal\n===`)
          // must still style the real text line outside math, while a `$$`
          // line with an `=`/`---` underline inside math stays suppressed.
          let headerMark: { from: number; to: number } | null = null;
          for (let child = node.node.firstChild; child; child = child.nextSibling) {
            if (child.name === "HeaderMark") {
              headerMark = { from: child.from, to: child.to };
              break;
            }
          }
          if (!headerMark) {
            return false;
          }
          const textLineIndex = lineIndexAt(lineStarts, headerMark.from - 1);
          const textFrom = lineStarts[textLineIndex];
          const textTo = textFrom + lines[textLineIndex].length;
          if (!intersectsMultiLineMathRange(mathRanges, textFrom, textTo)) {
            pushLineStyle(textLineIndex, node.name === "SetextHeading1" ? "cm-lp-h1" : "cm-lp-h2");
          }
          if (!intersectsMultiLineMathRange(mathRanges, headerMark.from, headerMark.to)) {
            pushSpan(headerMark.from, headerMark.to, "cm-lp-marker");
          }
          return false;
        }
      }
      return undefined;
    }
  });

  return { lines: lineStyles, spans };
}

const MANAGED_MEDIA_PREFIX = "@media/";
const MANAGED_MEDIA_BASE = "/media";
const CONTENT_FILES_BASE = "/content-files";

// Mirrors content-core's isExternalResource (protocol, `#`, root-absolute).
const EXTERNAL_SRC_RE = /^(?:[a-z]+:|#|\/)/i;

/**
 * Resolves a markdown image `src` to a servable URL, aligned with the preview
 * pane (`rewriteManagedMediaUrls` / `rewriteRelativeAssetUrls`):
 * `@media/...` → managed media base; external URLs untouched; relative paths
 * resolve against the article directory under `/content-files`. Returns null
 * when a relative src has no article directory — the widget is not rendered.
 */
export function resolveLivePreviewImageSrc(
  src: string,
  articleDirectory: string | null
): string | null {
  const trimmed = src.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith(MANAGED_MEDIA_PREFIX)) {
    return `${MANAGED_MEDIA_BASE}/${trimmed.slice(MANAGED_MEDIA_PREFIX.length)}`.replace(/\/{2,}/g, "/");
  }

  if (EXTERNAL_SRC_RE.test(trimmed)) {
    return trimmed;
  }

  if (articleDirectory === null) {
    return null;
  }

  const directory = articleDirectory.replace(/^\/+|\/+$/g, "");
  return `${CONTENT_FILES_BASE}/${directory ? `${directory}/` : ""}${trimmed}`
    .replace(/\/{2,}/g, "/")
    .replace(":/", "://");
}

// --- Decoration layer -------------------------------------------------------
//
// CM6 hard rule (runtime-enforced): decorations that affect vertical layout —
// Decoration.line, block widgets (widget({block: true})) and block
// replacements (replace({block: true})) — may NOT be provided through a
// ViewPlugin's decorations ("Block decorations may not be specified via
// plugins"). They must come from state: a StateField surfaced through the
// EditorView.decorations facet. Keep it that way — plugin-provided
// decorations are only legal for marks and non-block widgets.

const addFailedRenderHash = StateEffect.define<string>();

/**
 * Forces a decoration rebuild. Dispatched to live views when the live preview
 * context or the layout mode changes (neither produces a CM transaction by
 * itself). Exported for headless tests.
 */
export const refreshLivePreview = StateEffect.define<null>();

/**
 * Fence/table renders are async; when one rejects (even after the null-config
 * retry), its widget reports the content hash here and the preview panel is
 * hidden from then on (the source itself is never touched — there is no
 * replace decoration to collapse).
 *
 * Declared ahead of (higher precedence than) livePreviewDecorationsField so
 * the decorations field may read it from `tr.state` during its own update —
 * state fields initialize in precedence order. Exported so the float overlay
 * (cm-live-preview-float.ts) hides the same failed previews.
 */
export const livePreviewFailedRenderHashesField = StateField.define<ReadonlySet<string>>({
  create: () => new Set<string>(),
  update(value, tr) {
    let next: Set<string> | null = null;
    for (const effect of tr.effects) {
      if (effect.is(addFailedRenderHash) && !value.has(effect.value)) {
        next ??= new Set(value);
        next.add(effect.value);
      }
    }
    return next ?? value;
  }
});

const setLivePreviewBelowKeys = StateEffect.define<ReadonlySet<string>>();

/**
 * Keys of block-preview ranges that must render BELOW the source even in
 * float mode — the per-block fallback when there is no room beside the code
 * (see cm-live-preview-float.ts). Written by the float plugin after
 * measuring (rAF, outside the update cycle); the decorations field rebuilds
 * on the effect. Declared ahead of livePreviewDecorationsField so the
 * builder may read it from `tr.state`.
 */
export const livePreviewBelowKeysField = StateField.define<ReadonlySet<string>>({
  create: () => new Set<string>(),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setLivePreviewBelowKeys)) {
        return effect.value;
      }
    }
    return value;
  }
});

/** Dispatch helper (call outside the CM update cycle). */
export function reportLivePreviewBelowKeys(view: EditorView, keys: ReadonlySet<string>): void {
  view.dispatch({ effects: setLivePreviewBelowKeys.of(keys) });
}

// Whole-document scan cache: Text objects are immutable, so the computed
// scan stays valid until the document changes (which yields a new Text).
interface LivePreviewDocumentScan {
  ranges: LivePreviewRange[];
  styles: LivePreviewStyleScan;
  /** Doc line start offsets (jump-target resolution), cached with the scan. */
  lineStarts: number[];
}

const documentScanCache = new WeakMap<Text, LivePreviewDocumentScan>();

/** Shared by the decorations builder and the float overlay. */
export function getLivePreviewDocumentScan(doc: Text): LivePreviewDocumentScan {
  let scan = documentScanCache.get(doc);
  if (!scan) {
    const text = doc.toString();
    const lineStarts = [0];
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) === 10) {
        lineStarts.push(index + 1);
      }
    }
    scan = { ranges: computeLivePreviewRanges(text), styles: computeLivePreviewStyles(text), lineStarts };
    documentScanCache.set(doc, scan);
  }
  return scan;
}

function contentHash(source: string): string {
  return `${hashText(source)}:${source.length}`;
}

// Mark/line Decoration instances are immutable per class — share them.
const sharedMarkDecorations = new Map<string, Decoration>();
const sharedLineDecorations = new Map<string, Decoration>();

function markDecorationFor(className: string): Decoration {
  let decoration = sharedMarkDecorations.get(className);
  if (!decoration) {
    decoration = Decoration.mark({ class: className });
    sharedMarkDecorations.set(className, decoration);
  }
  return decoration;
}

function lineDecorationFor(className: string): Decoration {
  let decoration = sharedLineDecorations.get(className);
  if (!decoration) {
    decoration = Decoration.line({ class: className });
    sharedLineDecorations.set(className, decoration);
  }
  return decoration;
}

// --- Layout mode (below-source widgets vs floating panels) ------------------
//
// Views report their layout mode from the float plugin
// (cm-live-preview-float.ts); the decorations field includes the aggregate in
// its salt, so a mode switch rebuilds decorations (in float mode the below
// widgets are suppressed — the overlay renders them instead). The workbench
// shows one document editor at a time, so a global aggregate is accurate
// there; a narrow embedded editor coexisting with a wide main view would
// follow the main view's mode (accepted trade-off).
const floatModeViews = new Set<EditorView>();

export function getLivePreviewLayoutMode(): "below" | "float" {
  return floatModeViews.size > 0 ? "float" : "below";
}

export function reportLivePreviewFloatMode(view: EditorView, floatMode: boolean): void {
  const had = floatModeViews.has(view);
  if (floatMode === had) {
    return;
  }
  if (floatMode) {
    floatModeViews.add(view);
  } else {
    floatModeViews.delete(view);
  }
  for (const liveView of livePreviewViews) {
    liveView.dispatch({ effects: refreshLivePreview.of(null) });
  }
}

/**
 * Context salt for widget keys: keeps cached widgets honest when the
 * rendering environment (article directory, block config, renderer set)
 * changes. Deliberately excludes the layout mode so the same widget (and its
 * rendered DOM) is shared between below-source and float rendering.
 */
function computeContextSalt(): string {
  const context = getWorkbenchLivePreviewContext();
  return hashText(
    `${context.articleDirectory ?? ""}∥${JSON.stringify(context.markdownBlockConfig ?? null)}∥${context.fenceRenderers.map((renderer) => renderer.language).sort().join(",")}`
  );
}

/** Exported for the float overlay, which must reproduce the same widget keys. */
export function getLivePreviewWidgetSalt(): string {
  return computeContextSalt();
}

/** Decoration-field snapshot: context salt + layout/reading modes (switches rebuild). */
function computeDecorationSalt(): string {
  return `${computeContextSalt()}∥${getLivePreviewLayoutMode()}∥${getReadingMode()}`;
}

/**
 * Whether a previewable construct is inside the near-cursor area (reading
 * mode, region definition): cursor head within from..to EXTENDED by one char
 * on each side — CM cursor motion skips replaced ranges entirely (the head
 * jumps from to+1 straight to from-1 and vice versa), so the adjacent
 * positions are the only way the cursor ever "enters" a hidden block, and
 * they must count as inside for the expand-on-entry interaction. Write mode
 * → everything is "inside". Shared by the decorations builder and the float
 * overlay.
 */
export function isLivePreviewRangeInZone(state: EditorState, range: LivePreviewRange): boolean {
  if (getReadingMode() === "write") {
    return true;
  }
  return isInCursorRegion(range.from - 1, range.to + 1, state.selection.main.head);
}

// --- Inline math band grouping (visual lines) ---------------------------------

/**
 * Subtracts covering spans from `[from, to)`, returning the uncovered
 * pieces (sorted, non-overlapping). Used to keep the math neutralization
 * mark off regions an OUTER markdown construct legitimately styles (the
 * strong span of `**$x$**` covers the formula — its bold must survive).
 * Pure, unit-tested.
 */
export function subtractCoveringSpans(
  from: number,
  to: number,
  covering: readonly { from: number; to: number }[]
): { from: number; to: number }[] {
  const pieces: { from: number; to: number }[] = [];
  const sorted = [...covering].sort((a, b) => a.from - b.from || a.to - b.to);
  let cursor = from;
  for (const span of sorted) {
    if (span.to <= cursor || span.from >= to) {
      continue;
    }
    if (span.from > cursor) {
      pieces.push({ from: cursor, to: Math.min(span.from, to) });
    }
    cursor = Math.max(cursor, span.to);
    if (cursor >= to) {
      break;
    }
  }
  if (cursor < to) {
    pieces.push({ from: cursor, to });
  }
  return pieces;
}

export interface LivePreviewInlineMathGroup {
  /** Smallest formula start in the group. */
  from: number;
  /** Largest formula end in the group — the band's anchor position. */
  to: number;
  formulas: LivePreviewInlineMathFormula[];
}

/**
 * Groups inline formulas into preview bands: one band per VISUAL line.
 * Formulas are first bucketed by logical line (`lineFor`); within a logical
 * line they stay together UNLESS there is positive evidence for a split —
 * two (nearest) measured formulas whose visual tops differ. Formulas
 * without a measurement (off-viewport, or not yet measured) attach to the
 * current group, so partially-measured lines never fragment. Pure,
 * unit-tested.
 */
export function groupInlineMathByVisualLine(
  formulas: LivePreviewInlineMathFormula[],
  topFor: (from: number) => number | undefined,
  lineFor: (from: number) => number
): LivePreviewInlineMathGroup[] {
  const byLogicalLine = new Map<number, LivePreviewInlineMathFormula[]>();
  for (const formula of formulas) {
    const line = lineFor(formula.from);
    const bucket = byLogicalLine.get(line) ?? [];
    bucket.push(formula);
    byLogicalLine.set(line, bucket);
  }

  const groups: LivePreviewInlineMathGroup[] = [];
  for (const lineFormulas of byLogicalLine.values()) {
    lineFormulas.sort((a, b) => a.from - b.from);
    let current: LivePreviewInlineMathFormula[] = [];
    let lastMeasuredTop: number | undefined;
    for (const formula of lineFormulas) {
      const top = topFor(formula.from);
      if (current.length > 0 && top !== undefined && lastMeasuredTop !== undefined && top !== lastMeasuredTop) {
        groups.push(makeInlineMathGroup(current));
        current = [];
      }
      current.push(formula);
      if (top !== undefined) {
        lastMeasuredTop = top;
      }
    }
    if (current.length > 0) {
      groups.push(makeInlineMathGroup(current));
    }
  }

  groups.sort((a, b) => a.from - b.from || a.to - b.to);
  return groups;
}

function makeInlineMathGroup(formulas: LivePreviewInlineMathFormula[]): LivePreviewInlineMathGroup {
  return {
    from: formulas[0].from,
    to: formulas[formulas.length - 1].to,
    formulas
  };
}

/** Exported for headless tests. */
export const setInlineMathVisualTops = StateEffect.define<ReadonlyMap<number, number>>();

/**
 * Formula start offset → measured visual top (rounded client y), covering
 * the viewport plus a buffer. Written by the measure plugin below after
 * deferring out of the measure phase; the decorations field rebuilds on the
 * effect. Declared ahead of livePreviewDecorationsField so the builder may
 * read it from `tr.state`.
 */
export const livePreviewInlineMathVisualTopsField = StateField.define<ReadonlyMap<number, number>>({
  create: () => new Map(),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setInlineMathVisualTops)) {
        return effect.value;
      }
    }
    return value;
  }
});

/** Extra doc offsets around the viewport that get measured. */
const VISUAL_TOPS_BUFFER_CHARS = 1500;

/**
 * Measures inline formulas' visual tops (coordsAtPos in the measure read
 * phase — layout reads are forbidden inside the update cycle) and reports
 * them into livePreviewInlineMathVisualTopsField via a deferred dispatch
 * (skipped when the value is unchanged, so there is no dispatch loop).
 *
 * Measurement passes are DEBOUNCED (120ms quiet period after the last doc
 * change): transient layouts while typing — where partially-formed formulas
 * already produced bands that shift later formulas down — would otherwise
 * bake a false split into the tops map and lock it in.
 */
const inlineMathVisualMeasurePlugin = ViewPlugin.fromClass(
  class {
    private dispatchTimer: ReturnType<typeof setTimeout> | null = null;
    private measureTimer: ReturnType<typeof setTimeout> | null = null;
    private pending: { tops: ReadonlyMap<number, number> } | null = null;

    constructor(private readonly view: EditorView) {
      this.scheduleMeasure();
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        this.scheduleMeasure();
      }
    }

    destroy() {
      if (this.dispatchTimer) {
        clearTimeout(this.dispatchTimer);
        this.dispatchTimer = null;
      }
      if (this.measureTimer) {
        clearTimeout(this.measureTimer);
        this.measureTimer = null;
      }
    }

    private scheduleMeasure(): void {
      if (this.measureTimer) {
        clearTimeout(this.measureTimer);
      }
      this.measureTimer = setTimeout(() => {
        this.measureTimer = null;
        this.measureNow();
      }, 120);
    }

    private measureNow(): void {
      const view = this.view;
      if (!view.dom.isConnected) {
        return;
      }
      view.requestMeasure({
        read: () => {
          const { state } = view;
          const scan = getLivePreviewDocumentScan(state.doc);
          const viewportFrom = Math.max(0, view.viewport.from - VISUAL_TOPS_BUFFER_CHARS);
          const viewportTo = Math.min(state.doc.length, view.viewport.to + VISUAL_TOPS_BUFFER_CHARS);
          const tops = new Map<number, number>();
          for (const range of scan.ranges) {
            if (range.from > viewportTo) {
              break; // ranges are sorted by `from`
            }
            if (range.to < viewportFrom) {
              continue;
            }
            if (range.kind !== "inlineMath") {
              continue;
            }
            for (const formula of range.formulas) {
              const coords = view.coordsAtPos(formula.from);
              if (!coords) {
                continue;
              }
              tops.set(formula.from, Math.round(coords.top));
            }
          }
          return { tops };
        },
        write: (measured) => {
          this.pending = measured;
          this.deferDispatch();
        }
      });
    }

    private deferDispatch(): void {
      if (this.dispatchTimer) {
        return;
      }
      this.dispatchTimer = setTimeout(() => {
        this.dispatchTimer = null;
        const view = this.view;
        const next = this.pending;
        if (!view.dom.isConnected || next === null) {
          return;
        }
        const mapEquals = (a: ReadonlyMap<number, number>, b: ReadonlyMap<number, number>) =>
          a.size === b.size && [...a].every(([key, value]) => b.get(key) === value);
        const currentTops = view.state.field(livePreviewInlineMathVisualTopsField);
        if (mapEquals(currentTops, next.tops)) {
          return;
        }
        view.dispatch({
          effects: setInlineMathVisualTops.of(next.tops)
        });
      }, 0);
    }
  }
);

export interface LivePreviewBlockWidgetDescriptor {
  key: string;
  widget: WidgetType;
}

// --- Click-to-jump targets ----------------------------------------------------

/**
 * Click-to-jump target for a block-preview range. Pure, unit-tested:
 * - multi-line `$$` → line start of the line below the opening `$$`;
 * - single-line `$$x$$` → right after the opening `$$` (from + 2);
 * - table → line start of the first row;
 * - fence → line start of the line below the opening fence;
 * - image → the range start (`![`).
 */
export function resolveBlockPreviewJumpTarget(
  kind: "blockMath" | "table" | "fence" | "image",
  from: number,
  to: number,
  lineStarts: readonly number[]
): number {
  const lineFor = (pos: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    let result = 0;
    while (low <= high) {
      const mid = (low + high) >>> 1;
      if (lineStarts[mid] <= pos) {
        result = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return result;
  };
  const lastLine = lineStarts.length - 1;
  switch (kind) {
    case "blockMath": {
      const startLine = lineFor(from);
      if (startLine === lineFor(to)) {
        return from + 2;
      }
      return lineStarts[Math.min(startLine + 1, lastLine)];
    }
    case "table":
      return lineStarts[lineFor(from)];
    case "fence":
      return lineStarts[Math.min(lineFor(from) + 1, lastLine)];
    case "image":
      return from;
  }
}

/** Content key of a range for jump-provider matching (null when not hashable). */
function rangeContentKey(range: LivePreviewRange): string | null {
  if (range.kind === "image") {
    return contentHash(range.images.map((image) => `${image.alt}→${image.src}`).join("\n"));
  }
  if ("source" in range) {
    return contentHash(range.source);
  }
  return null;
}

/**
 * Builds the jump provider for a block preview (see attachPreviewJumpHandlers
 * in cm-live-preview-widgets.ts). Resolution order:
 * 1. EXACT: the clicked DOM's document position (below-source mounts) → the
 *    current range anchored there — correct even with duplicated identical
 *    blocks and after edits that shifted every offset.
 * 2. First current range with the same kind + content key (float panels and
 *    other detached mounts, where posAtDOM throws; duplicated blocks share
 *    one float panel anyway).
 * 3. The creation-time target as the last resort.
 */
export function makeBlockPreviewJumpProvider(
  kind: "blockMath" | "table" | "fence" | "image",
  contentKey: string,
  fallbackTarget: number
): PreviewJumpProvider {
  return (view, root) => {
    const scan = getLivePreviewDocumentScan(view.state.doc);
    let anchor: number | null = null;
    try {
      anchor = view.posAtDOM(root, 0);
    } catch {
      anchor = null; // detached mount (float panel): fall through to content match
    }
    if (anchor !== null) {
      const hit = scan.ranges.find((range) => range.kind === kind && range.to === anchor);
      if (hit) {
        return resolveBlockPreviewJumpTarget(kind, hit.from, hit.to, scan.lineStarts);
      }
    }
    const match = scan.ranges.find((range) => range.kind === kind && rangeContentKey(range) === contentKey);
    if (match) {
      return resolveBlockPreviewJumpTarget(kind, match.from, match.to, scan.lineStarts);
    }
    return fallbackTarget;
  };
}

/** Jump provider for one block-preview range (builder + float panel share it). */
export function jumpProviderForRange(range: LivePreviewRange & { kind: "blockMath" | "table" | "fence" | "image" }, lineStarts: readonly number[]): PreviewJumpProvider {
  const fallback = resolveBlockPreviewJumpTarget(range.kind, range.from, range.to, lineStarts);
  return makeBlockPreviewJumpProvider(range.kind, rangeContentKey(range) ?? "", fallback);
}

/**
 * Maps a block-preview range (image row, $$ block, table, fence) to its
 * content-keyed widget. Single source of truth shared by the below-source
 * decorations and the float overlay, so both render identical DOM from the
 * same LRU cache. Returns null when nothing should render (e.g. unresolvable
 * images). Render-failure hiding is the caller's job (check the key against
 * livePreviewFailedRenderHashesField). Inline math is NOT handled here — it
 * is grouped per visual line in buildLivePreviewDecorations.
 *
 * `jumpProvider` (click-to-jump, see makeBlockPreviewJumpProvider) is
 * threaded into the widget; the cached instance keeps the provider from its
 * first creation — fine, since providers resolve against the CURRENT
 * document scan at gesture time.
 */
export function createBlockPreviewWidget(
  range: LivePreviewRange,
  context: WorkbenchLivePreviewContext,
  salt: string,
  jumpProvider: PreviewJumpProvider
): LivePreviewBlockWidgetDescriptor | null {
  switch (range.kind) {
    case "image": {
      const items: LivePreviewImageItem[] = [];
      for (const image of range.images) {
        const src = resolveLivePreviewImageSrc(image.src, context.articleDirectory);
        if (src !== null) {
          items.push({ alt: image.alt, src });
        }
      }
      if (items.length === 0) {
        return null;
      }
      const key = `img:${salt}:${contentHash(items.map((item) => `${item.alt}→${item.src}`).join("\n"))}`;
      return { key, widget: createImageRowWidget(key, items, jumpProvider) };
    }
    case "blockMath": {
      const key = `math:${salt}:${contentHash(range.source)}`;
      return { key, widget: createMathBlockWidget(key, range.source, jumpProvider) };
    }
    case "table":
    case "fence": {
      const key = `${range.kind}:${salt}:${contentHash(range.source)}`;
      return {
        key,
        widget: createRichBlockWidget(key, {
          kind: range.kind,
          source: range.source,
          onRenderFailure: (widgetView) => {
            widgetView.dispatch({ effects: addFailedRenderHash.of(key) });
          },
          jumpProvider
        })
      };
    }
    default:
      return null;
  }
}

/**
 * Maps the cached document scan to a full-document DecorationSet. Computed
 * from state only (no view), so the StateField stays headlessly testable;
 * widget instantiation stays lazy because CM only mounts in-viewport widgets.
 */
function buildLivePreviewDecorations(state: EditorState): DecorationSet {
  const scan = getLivePreviewDocumentScan(state.doc);
  const context = getWorkbenchLivePreviewContext();
  const salt = computeContextSalt();
  const failedHashes = state.field(livePreviewFailedRenderHashesField);
  const belowKeys = state.field(livePreviewBelowKeysField);
  const visualTops = state.field(livePreviewInlineMathVisualTopsField);
  const floatMode = getLivePreviewLayoutMode() === "float";
  const reading = getReadingMode() === "read";

  const decorations: Range<Decoration>[] = [];

  // Inline/line source styles (blockquote bars, emphasis, link, markers…).
  for (const lineStyle of scan.styles.lines) {
    decorations.push(lineDecorationFor(lineStyle.className).range(lineStyle.from));
  }
  for (const span of scan.styles.spans) {
    decorations.push(markDecorationFor(span.className).range(span.from, span.to));
  }

  // Inline math, handled apart from the block loop. In reading mode each
  // out-of-region formula becomes an inline KaTeX replacement in the text
  // flow; an in-region formula keeps its source AND gets a preview band.
  // In write mode every formula joins a band. Either way, bands are grouped
  // per VISUAL line (groupInlineMathByVisualLine + the measured tops field,
  // logical-line fallback) — one band under each formula-bearing visual
  // line, without fragmenting single-line multi-formula paragraphs into
  // per-formula bands.
  const bandFormulas: LivePreviewInlineMathFormula[] = [];
  for (const range of scan.ranges) {
    if (range.kind !== "inlineMath") {
      continue;
    }
    const formula = range.formulas[0];
    if (reading && !isInCursorRegion(formula.from - 1, formula.to + 1, state.selection.main.head)) {
      const replaceKey = `imr:${salt}:${contentHash(formula.tex)}`;
      decorations.push(
        Decoration.replace({
          widget: createInlineMathReplaceWidget(replaceKey, formula.tex, formula.from + 1)
        }).range(range.from, range.to)
      );
      continue;
    }
    // Neutralization mark (see .cm-lp-math in styles.css): the lezer
    // grammar is math-atomic (cmMathMarkdown), so this is only the safety
    // net for transient/divergent states. NOT added when read mode hides
    // the source above — the KaTeX replacement must keep its own fonts.
    // Coverage by OUTER markdown constructs (the strong span of `**$x$**`)
    // is subtracted: their styling is legitimate and must survive.
    for (const piece of subtractCoveringSpans(range.from, range.to, scan.styles.spans)) {
      decorations.push(markDecorationFor("cm-lp-math").range(piece.from, piece.to));
    }
    bandFormulas.push(formula);
  }
  const inlineMathGroups = groupInlineMathByVisualLine(
    bandFormulas,
    (from) => visualTops.get(from),
    (from) => state.doc.lineAt(from).number
  );
  for (const group of inlineMathGroups) {
    const key = `im:${salt}:${contentHash(group.formulas.map((formula) => formula.tex).join("\n"))}`;
    // R3: INLINE (non-block) widget anchored at the group's last formula
    // end. The band's DOM is an inline-level full-width box
    // (display: inline-block; width: 100% — see .cm-lp-inline-math-row), so
    // it never fits the current line box's remaining space and wraps onto
    // its own line box directly under the formula's visual segment,
    // pushing the following text down (`ab$c$de` → `ab$c$` / band / `de`).
    // CM measures its height as ordinary inline content — there is no
    // block-widget height accounting — and vertical cursor motion takes
    // the native multi-segment path. Do NOT re-add `block: true`: as a
    // mid-line block widget CM's height map hid the fragment's first row
    // under a phantom line height, which made ArrowUp/Down skip a row
    // until the next full reload (see cm-live-preview-widgets.ts).
    //
    // side: -1 (cursor association): the anchor offset doubles as both the
    // band's position and the first text position of the row after the
    // band. With the default side the caret prefers the widget's UPSTREAM
    // side at that offset, so vertical motion with the goal column at the
    // line's left edge skipped the text row right after the band in one
    // press (observed at 880px). side: -1 makes the caret land on the
    // downstream (after-band) side instead, and every visual row stays
    // reachable step by step. Visual placement is identical either way.
    decorations.push(
      Decoration.widget({
        widget: createInlineMathRowWidget(
          key,
          group.formulas.map((formula) => ({ from: formula.from, tex: formula.tex }))
        ),
        side: -1
      }).range(group.to)
    );
  }

  for (const range of scan.ranges) {
    if (range.kind === "heading") {
      decorations.push(Decoration.line({ class: `cm-lp-h${range.level}` }).range(range.from));
      decorations.push(Decoration.mark({ class: "cm-lp-marker" }).range(range.markerFrom, range.markerTo));
      continue;
    }
    if (range.kind === "inlineMath") {
      continue; // handled above
    }

    const descriptor = createBlockPreviewWidget(range, context, salt, jumpProviderForRange(range, scan.lineStarts));
    if (!descriptor || failedHashes.has(descriptor.key)) {
      continue;
    }

    // Reading mode, outside the cursor area: the source is hidden and the
    // preview takes its place. Keyboard cursor can still move into a replaced
    // range; region mode expands it on entry and re-hides on leave
    // (selection-driven rebuild).
    if (reading && !isLivePreviewRangeInZone(state, range)) {
      decorations.push(
        Decoration.replace({ widget: descriptor.widget, block: true }).range(range.from, range.to)
      );
      continue;
    }

    // Math neutralization mark — same safety net as for inline math (see
    // above). No coverage subtraction needed here: an outer inline
    // construct cannot wrap a block-level range. Skipped when the source
    // is hidden (replaced) for the same reason.
    if (range.kind === "blockMath") {
      decorations.push(markDecorationFor("cm-lp-math").range(range.from, range.to));
    }

    // Inside the cursor area (or write mode): source stays visible, preview
    // floats (when wide enough) or sits below.
    if (floatMode && !belowKeys.has(descriptor.key)) {
      continue;
    }
    decorations.push(
      Decoration.widget({ widget: descriptor.widget, side: 1, block: true }).range(range.to)
    );
  }

  return Decoration.set(decorations, true);
}

interface LivePreviewDecorationState {
  decorations: DecorationSet;
  /** Decoration salt snapshot (context + layout mode) these were built with. */
  salt: string;
}

/**
 * All live preview decorations, rebuilt from the WeakMap-cached document scan
 * whenever the document, the failed-render set, the live preview context or
 * the layout mode changes. Selection changes intentionally do NOT trigger a
 * rebuild — nothing here collapses; source always stays visible. Surfaced
 * through the `EditorView.decorations` facet — per the CM6 rule above, these
 * block-level decorations must not be provided by a ViewPlugin. Exported for
 * headless tests.
 */
export const livePreviewDecorationsField = StateField.define<LivePreviewDecorationState>({
  create(state) {
    return { decorations: buildLivePreviewDecorations(state), salt: computeDecorationSalt() };
  },
  update(value, tr) {
    const salt = computeDecorationSalt();
    const forced = tr.effects.some(
      (effect) =>
        effect.is(addFailedRenderHash) ||
        effect.is(refreshLivePreview) ||
        effect.is(setLivePreviewBelowKeys) ||
        effect.is(setInlineMathVisualTops) ||
        effect.is(readingModeRefresh)
    );
    // tr.selection: reading mode expands/collapses constructs as the cursor
    // moves (rebuilds are cheap — they map the WeakMap-cached document scan).
    if (!tr.docChanged && !tr.selection && !forced && salt === value.salt) {
      return value;
    }
    return { decorations: buildLivePreviewDecorations(tr.state), salt };
  }
});

// Live views, tracked so a live preview context replacement (which produces
// no CM transaction on its own) can push a refresh into every view.
const livePreviewViews = new Set<EditorView>();

onWorkbenchLivePreviewContextChange(() => {
  for (const view of livePreviewViews) {
    view.dispatch({ effects: refreshLivePreview.of(null) });
  }
});

// Registration-only plugin: it provides no decorations (that would be
// illegal for block decorations — see the rule above) and exists purely to
// keep livePreviewViews accurate.
const livePreviewViewTracker = ViewPlugin.fromClass(
  class {
    constructor(private readonly view: EditorView) {
      livePreviewViews.add(view);
    }

    destroy() {
      livePreviewViews.delete(this.view);
    }
  }
);

/**
 * Core live-preview extension.
 */
export const cmLivePreview: Extension = [
  livePreviewFailedRenderHashesField,
  livePreviewBelowKeysField,
  livePreviewInlineMathVisualTopsField,
  livePreviewDecorationsField,
  EditorView.decorations.compute([livePreviewDecorationsField], (state) =>
    state.field(livePreviewDecorationsField).decorations
  ),
  livePreviewViewTracker,
  cmReadingModeSupport,
  inlineMathVisualMeasurePlugin,
  getCmLivePreviewFloatExtension()
];
