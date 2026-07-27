import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { EditorState } from "@codemirror/state";
import type { EditorView, ViewUpdate } from "@codemirror/view";
import { markdownLanguage } from "@codemirror/lang-markdown";
import type { MarkdownParser } from "@lezer/markdown";

import { setWorkbenchLivePreviewContext } from "./cm-context";
import {
  computeLivePreviewFloatFit,
  FLOAT_MODE_MIN_WIDTH,
  reconcileFloatWidth,
  resolveLivePreviewFloatLayout,
  resolveLivePreviewLayoutMode
} from "./cm-live-preview-float";
import { computeInlineMathFormulaLayout, InlineMathRowWidget, isPreviewJumpClick } from "./cm-live-preview-widgets";
import { getReadingMode, isInCursorRegion, setReadingMode } from "./cm-reading-mode";
import {
  buildLivePreviewMathRanges,
  cmLivePreview,
  cmMathMarkdown,
  computeLivePreviewRanges,
  computeLivePreviewStyles,
  findVisualRowWrapEnd,
  groupInlineMathByVisualLine,
  isInsideMathRange,
  intersectsMultiLineMathRange,
  livePreviewDecorationsField,
  refreshLivePreview,
  reportLivePreviewFloatMode,
  resolveBlockPreviewJumpTarget,
  resolveLivePreviewImageSrc,
  setInlineMathVisualTops,
  setInlineMathWrapEnds,
  shouldScheduleInlineMathMeasure,
  subtractCoveringSpans,
  type LivePreviewBlockMathRange,
  type LivePreviewFenceRange,
  type LivePreviewHeadingRange,
  type LivePreviewImageRange,
  type LivePreviewInlineMathRange,
  type LivePreviewTableRange
} from "./cm-live-preview";

function headings(ranges: ReturnType<typeof computeLivePreviewRanges>) {
  return ranges.filter((range): range is LivePreviewHeadingRange => range.kind === "heading");
}

function inlineMath(ranges: ReturnType<typeof computeLivePreviewRanges>) {
  return ranges.filter((range): range is LivePreviewInlineMathRange => range.kind === "inlineMath");
}

function blockMath(ranges: ReturnType<typeof computeLivePreviewRanges>) {
  return ranges.filter((range): range is LivePreviewBlockMathRange => range.kind === "blockMath");
}

function images(ranges: ReturnType<typeof computeLivePreviewRanges>) {
  return ranges.filter((range): range is LivePreviewImageRange => range.kind === "image");
}

function tables(ranges: ReturnType<typeof computeLivePreviewRanges>) {
  return ranges.filter((range): range is LivePreviewTableRange => range.kind === "table");
}

function fences(ranges: ReturnType<typeof computeLivePreviewRanges>) {
  return ranges.filter((range): range is LivePreviewFenceRange => range.kind === "fence");
}

/**
 * Below-type ranges cover whole source lines: `from` starts a line and `to`
 * (the preview widget anchor) is the end of the last covered line.
 */
function assertBelowAnchor(text: string, range: { from: number; to: number }) {
  assert.ok(range.from === 0 || text[range.from - 1] === "\n");
  assert.ok(range.to === text.length || text[range.to] === "\n");
}

test("computeLivePreviewRanges grades ATX headings and marks the marker", () => {
  const ranges = computeLivePreviewRanges("# a\n## b\n### c\n#### d\n##### e\n###### f\n");
  const result = headings(ranges);

  assert.equal(result.length, 6);
  assert.deepEqual(
    result.map((range) => range.level),
    [1, 2, 3, 4, 5, 6]
  );

  // "# a" starts at 0; marker covers the hash + the separating space.
  assert.equal(result[0].from, 0);
  assert.equal(result[0].to, 3);
  assert.equal(result[0].markerFrom, 0);
  assert.equal(result[0].markerTo, 2);

  // "## b" starts at 4.
  assert.equal(result[1].from, 4);
  assert.equal(result[1].markerFrom, 4);
  assert.equal(result[1].markerTo, 7);
});

test("computeLivePreviewRanges emits one inline-math range per formula, anchored at the formula end", () => {
  const text = "Euler $e^{i\\pi}+1=0$ and $x_1$ done";
  const rows = inlineMath(computeLivePreviewRanges(text));

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((range) => [range.from, range.to]),
    [
      [6, 20],
      [25, 30]
    ]
  );
  // Per-formula ranges: the band anchors at `to` (the formula end), so CM
  // places it under the formula's own visual line.
  assert.deepEqual(rows[0].formulas, [{ from: 6, to: 20, tex: "e^{i\\pi}+1=0" }]);
  assert.deepEqual(rows[1].formulas, [{ from: 25, to: 30, tex: "x_1" }]);
});

test("computeLivePreviewRanges skips multi-line inline math and inline $$ pairs", () => {
  assert.equal(inlineMath(computeLivePreviewRanges("$a\nb$\n")).length, 0);
  // `$$` pairs inside a paragraph get no live preview at all.
  const ranges = computeLivePreviewRanges("text $$x$$ more\n");
  assert.equal(inlineMath(ranges).length, 0);
  assert.equal(blockMath(ranges).length, 0);
});

test("computeLivePreviewRanges handles single-line and multi-line $$ blocks as below ranges", () => {
  const singleText = "$$x$$\n";
  const single = blockMath(computeLivePreviewRanges(singleText));
  assert.equal(single.length, 1);
  assert.equal(single[0].from, 0);
  assert.equal(single[0].to, 5);
  assert.equal(single[0].source, "$$x$$");
  assertBelowAnchor(singleText, single[0]);

  const text = "$$\n\\int_0^1 x\n$$\n";
  const multi = blockMath(computeLivePreviewRanges(text));
  assert.equal(multi.length, 1);
  assert.equal(multi[0].from, 0);
  assert.equal(multi[0].to, text.length - 1);
  assert.equal(multi[0].source, "$$\n\\int_0^1 x\n$$");
  assertBelowAnchor(text, multi[0]);
});

test("computeLivePreviewRanges collects images with raw src", () => {
  const ranges = computeLivePreviewRanges("![diagram](img/d.png)\n\n![m](@media/a/b.png)\n");
  const rows = images(ranges);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].images, [{ alt: "diagram", src: "img/d.png" }]);
  assert.equal(rows[0].from, 0);
  assert.equal(rows[0].to, 21);
  assert.deepEqual(rows[1].images, [{ alt: "m", src: "@media/a/b.png" }]);
});

test("computeLivePreviewRanges accepts valid GFM tables and rejects bad delimiters", () => {
  const text = "| a | b |\n|---|---|\n| 1 | 2 |\n";
  const result = tables(computeLivePreviewRanges(text));
  assert.equal(result.length, 1);
  assert.equal(result[0].from, 0);
  assert.equal(result[0].to, text.length - 1);
  assert.equal(result[0].source, text.trimEnd());
  assertBelowAnchor(text, result[0]);

  // Invalid delimiter cells → no table.
  assert.equal(tables(computeLivePreviewRanges("| a | b |\n|---|===|\n")).length, 0);
  // Delimiter cell count must match the header.
  assert.equal(tables(computeLivePreviewRanges("| a | b |\n|---|---|---|\n")).length, 0);
  // No delimiter row at all → no table.
  assert.equal(tables(computeLivePreviewRanges("| a | b |\n| 1 | 2 |\n")).length, 0);
});

test("computeLivePreviewRanges suppresses inline math inside table cells", () => {
  const text = "| a |\n|---|\n| $x$ |\n";
  const ranges = computeLivePreviewRanges(text);
  assert.equal(tables(ranges).length, 1);
  assert.equal(inlineMath(ranges).length, 0);
});

test("computeLivePreviewRanges skips headings/math/images/tables inside code blocks", () => {
  const text = [
    "```",
    "# not a heading",
    "$not math$",
    "$$",
    "not a math block",
    "$$",
    "![not](an-image.png)",
    "| a |",
    "|---|",
    "```",
    "# heading",
    ""
  ].join("\n");
  const ranges = computeLivePreviewRanges(text);

  assert.equal(headings(ranges).length, 1);
  assert.equal(headings(ranges)[0].level, 1);
  assert.equal(inlineMath(ranges).length, 0);
  assert.equal(blockMath(ranges).length, 0);
  assert.equal(images(ranges).length, 0);
  assert.equal(tables(ranges).length, 0);
  // The fence itself still gets its own (code) preview block.
  assert.equal(fences(ranges).length, 1);
});

test("computeLivePreviewRanges treats 4-space-indented chunks as code", () => {
  const text = "paragraph\n\n    # not a heading\n    $not math$\n";
  const ranges = computeLivePreviewRanges(text);
  assert.equal(headings(ranges).length, 0);
  assert.equal(inlineMath(ranges).length, 0);
});

test("computeLivePreviewRanges reports renderer-backed and plain fences as below ranges", () => {
  const text = "```commutative\nA \\arrow[r] & B\n```\n";
  const result = fences(computeLivePreviewRanges(text));

  assert.equal(result.length, 1);
  assert.equal(result[0].language, "commutative");
  assert.equal(result[0].from, 0);
  assert.equal(result[0].to, text.length - 1);
  assert.equal(result[0].source, "```commutative\nA \\arrow[r] & B\n```");
  assertBelowAnchor(text, result[0]);

  // Plain fences (no language) also get a preview block (highlighted code).
  const plainText = "```\nplain\n```\n";
  const plain = fences(computeLivePreviewRanges(plainText));
  assert.equal(plain.length, 1);
  assert.equal(plain[0].language, "");
  assertBelowAnchor(plainText, plain[0]);
});

test("resolveLivePreviewImageSrc rewrites @media to the managed media base", () => {
  assert.equal(resolveLivePreviewImageSrc("@media/a/b.png", null), "/media/a/b.png");
});

test("resolveLivePreviewImageSrc resolves relative paths against the article directory", () => {
  assert.equal(resolveLivePreviewImageSrc("img/x.png", "posts/a"), "/content-files/posts/a/img/x.png");
  assert.equal(resolveLivePreviewImageSrc("x.png", ""), "/content-files/x.png");
});

test("resolveLivePreviewImageSrc returns null for relative src without a directory", () => {
  assert.equal(resolveLivePreviewImageSrc("img/x.png", null), null);
});

test("resolveLivePreviewImageSrc leaves external and root-absolute URLs untouched", () => {
  assert.equal(resolveLivePreviewImageSrc("https://cdn.example.com/x.png", "posts/a"), "https://cdn.example.com/x.png");
  assert.equal(resolveLivePreviewImageSrc("//cdn.example.com/x.png", "posts/a"), "//cdn.example.com/x.png");
  assert.equal(resolveLivePreviewImageSrc("/abs/x.png", "posts/a"), "/abs/x.png");
});

// --- StateField decoration layer (headless: EditorState needs no DOM) -------

interface BlockWidgetSpec {
  from: number;
  to: number;
  side: number;
}

function livePreviewDecorationCount(state: EditorState): number {
  return state.field(livePreviewDecorationsField).decorations.size;
}

function blockWidgetSpecs(state: EditorState): BlockWidgetSpec[] {
  const specs: BlockWidgetSpec[] = [];
  state
    .field(livePreviewDecorationsField)
    .decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.block === true && decoration.spec.widget) {
        specs.push({ from, to, side: decoration.spec.side });
      }
    });
  return specs;
}

/** Inline-math bands: inline (non-block) point decorations of InlineMathRowWidget. */
function inlineMathBandSpecs(state: EditorState): BlockWidgetSpec[] {
  const specs: BlockWidgetSpec[] = [];
  state
    .field(livePreviewDecorationsField)
    .decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.widget instanceof InlineMathRowWidget) {
        specs.push({ from, to, side: decoration.spec.side });
      }
    });
  return specs;
}

test("livePreviewDecorationsField builds decorations from state alone", () => {
  const state = EditorState.create({
    doc: "# Title\ntext $x$ end\n",
    extensions: [cmLivePreview]
  });

  // Heading line decoration + heading marker mark + inline-math replace
  // widget (read mode, cursor outside the formula zone → source hidden, so
  // no neutralization mark either).
  assert.equal(livePreviewDecorationCount(state), 3);
});

test("livePreviewDecorationsField anchors the $$ preview as a block widget below the source", () => {
  const state = EditorState.create({
    doc: "$$x$$\ntext\n",
    extensions: [cmLivePreview]
  });

  // Two decorations: a block widget (side 1) at the end of the last `$$`
  // source line + the math neutralization mark over the source — the
  // source lines themselves carry no other decoration.
  assert.equal(livePreviewDecorationCount(state), 2);
  assert.deepEqual(blockWidgetSpecs(state), [{ from: 5, to: 5, side: 1 }]);
});

test("livePreviewDecorationsField never collapses decorations when the selection enters", () => {
  let state = EditorState.create({
    doc: "$$x$$\ntext\n",
    // Default cursor at 0 already sits inside the $$ block.
    extensions: [cmLivePreview]
  });
  assert.equal(livePreviewDecorationCount(state), 2);

  state = state.update({ selection: { anchor: 2 } }).state;
  assert.equal(livePreviewDecorationCount(state), 2);

  // Head outside the zone (to+2) → read mode hides the block: replace
  // only, no neutralization mark.
  state = state.update({ selection: { anchor: 8 } }).state;
  assert.equal(livePreviewDecorationCount(state), 1);
});

test("livePreviewDecorationsField recomputes ranges after document edits", () => {
  // Write mode: this test is about edit-driven recompute, not reading behavior.
  setReadingMode("write");
  try {
    let state = EditorState.create({
      doc: "$$x$$\ntext\n",
      extensions: [cmLivePreview]
    });
    assert.deepEqual(blockWidgetSpecs(state), [{ from: 5, to: 5, side: 1 }]);

    state = state.update({ changes: { from: 0, insert: "$$y$$\n" } }).state;
    assert.deepEqual(blockWidgetSpecs(state), [
      { from: 5, to: 5, side: 1 },
      { from: 11, to: 11, side: 1 }
    ]);

    // Deleting the second block's closing delimiter removes its preview.
    state = state.update({ changes: { from: 10, to: 11 } }).state;
    assert.deepEqual(blockWidgetSpecs(state), [{ from: 5, to: 5, side: 1 }]);
  } finally {
    setReadingMode("read");
  }
});

test("livePreviewDecorationsField gives plain code fences a below preview widget", () => {
  const state = EditorState.create({
    doc: "```js\nconst a = 1;\n```\n",
    extensions: [cmLivePreview]
  });

  assert.equal(livePreviewDecorationCount(state), 1);
  assert.deepEqual(blockWidgetSpecs(state), [{ from: 22, to: 22, side: 1 }]);
});

test("livePreviewDecorationsField rebuilds on refreshLivePreview after a context change", () => {
  let state = EditorState.create({
    doc: "![a](img/x.png)\n",
    extensions: [cmLivePreview]
  });

  // Without an article directory the relative image is not resolvable → no
  // image preview widget (the inline style spans on the marks/url are
  // unrelated and stay out of this count).
  assert.equal(blockWidgetSpecs(state).length, 0);

  setWorkbenchLivePreviewContext({
    articleDirectory: "posts/a",
    fenceRenderers: [],
    markdownBlockConfig: null
  });
  try {
    state = state.update({ effects: refreshLivePreview.of(null) }).state;
    assert.equal(blockWidgetSpecs(state).length, 1);
  } finally {
    setWorkbenchLivePreviewContext({
      articleDirectory: null,
      fenceRenderers: [],
      markdownBlockConfig: null
    });
  }
});

// --- Inline/line source styles (computeLivePreviewStyles) -------------------

function spansWithClass(text: string, className: string) {
  return computeLivePreviewStyles(text).spans.filter((span) => span.className === className);
}

function spanOffsets(text: string, className: string) {
  return spansWithClass(text, className).map((span) => [span.from, span.to]);
}

test("computeLivePreviewStyles styles strong emphasis and fades its delimiters", () => {
  const text = "a **bold** b";
  assert.deepEqual(spanOffsets(text, "cm-lp-strong"), [[2, 10]]);
  assert.deepEqual(spanOffsets(text, "cm-lp-marker"), [
    [2, 4],
    [8, 10]
  ]);

  const underscore = "a __bold__ b";
  assert.deepEqual(spanOffsets(underscore, "cm-lp-strong"), [[2, 10]]);
});

test("computeLivePreviewStyles styles emphasis and fades its delimiters", () => {
  assert.deepEqual(spanOffsets("a *it* b", "cm-lp-em"), [[2, 6]]);
  assert.deepEqual(spanOffsets("a _it_ b", "cm-lp-em"), [[2, 6]]);
  assert.deepEqual(spanOffsets("a *it* b", "cm-lp-marker"), [
    [2, 3],
    [5, 6]
  ]);
});

test("computeLivePreviewStyles styles strikethrough and fades its delimiters", () => {
  const text = "a ~~gone~~ b";
  assert.deepEqual(spanOffsets(text, "cm-lp-strike"), [[2, 10]]);
  assert.deepEqual(spanOffsets(text, "cm-lp-marker"), [
    [2, 4],
    [8, 10]
  ]);
});

test("computeLivePreviewStyles styles inline code and fades backticks", () => {
  const text = "a `x=1` b";
  assert.deepEqual(spanOffsets(text, "cm-lp-code"), [[2, 7]]);
  assert.deepEqual(spanOffsets(text, "cm-lp-marker"), [
    [2, 3],
    [6, 7]
  ]);
});

test("computeLivePreviewStyles styles link text and fades url and brackets", () => {
  const text = "[text](https://x.y)";
  assert.deepEqual(spanOffsets(text, "cm-lp-link"), [[1, 5]]);
  const urlSpans = spanOffsets(text, "cm-lp-url");
  assert.ok(urlSpans.some(([from, to]) => from === 7 && to === 18)); // URL node
  // All four bracket marks fade.
  for (const expected of [[0, 1], [5, 6], [6, 7], [18, 19]]) {
    assert.ok(
      urlSpans.some(([from, to]) => from === expected[0] && to === expected[1]),
      `missing url span ${expected}`
    );
  }
});

test("computeLivePreviewStyles fades the image marker and destination", () => {
  const text = "![alt](img.png)";
  assert.equal(spansWithClass(text, "cm-lp-link").length, 0);
  const urlSpans = spanOffsets(text, "cm-lp-url");
  assert.ok(urlSpans.some(([from, to]) => from === 0 && to === 2)); // `![`
  assert.ok(urlSpans.some(([from, to]) => from === 7 && to === 14)); // img.png
});

test("computeLivePreviewStyles fades autolinks and bare URLs", () => {
  assert.deepEqual(spanOffsets("<http://a.b>", "cm-lp-url"), [[0, 12]]);
  assert.deepEqual(spanOffsets("see https://x.y/z now", "cm-lp-url"), [[4, 17]]);
});

test("computeLivePreviewStyles marks quote lines and fades the quote marker", () => {
  const text = "> q1\nplain\n";
  const scan = computeLivePreviewStyles(text);
  assert.deepEqual(scan.lines, [{ from: 0, className: "cm-lp-quote" }]);
  assert.deepEqual(spanOffsets(text, "cm-lp-marker"), [[0, 1]]);
});

test("computeLivePreviewStyles accents list and task markers", () => {
  const text = "- item\n1. num\n- [x] done text\n";
  const listMarks = spanOffsets(text, "cm-lp-listmark");
  assert.ok(listMarks.some(([from, to]) => from === 0 && to === 1)); // `-`
  assert.ok(listMarks.some(([from, to]) => from === 7 && to === 9)); // `1.`
  assert.ok(listMarks.some(([from, to]) => from === 16 && to === 19)); // `[x]`
  // Completed task content is struck to the end of its line (line 2 starts at
  // 14 and is 15 chars long).
  const strike = spanOffsets(text, "cm-lp-strike");
  assert.ok(strike.some(([from, to]) => from === 19 && to === 29));
});

test("computeLivePreviewStyles styles horizontal rules and setext headings", () => {
  const hr = computeLivePreviewStyles("---\ntext\n");
  assert.deepEqual(hr.lines, [{ from: 0, className: "cm-lp-hr" }]);

  const setext = computeLivePreviewStyles("Title\n===\n");
  assert.deepEqual(setext.lines, [{ from: 0, className: "cm-lp-h1" }]);
  assert.deepEqual(spanOffsets("Title\n===\n", "cm-lp-marker"), [[6, 9]]);
});

test("computeLivePreviewStyles skips code block content", () => {
  const text = "```\n**not bold**\n> not a quote\n- not a list\n`not inline`\n```\n";
  const scan = computeLivePreviewStyles(text);
  assert.deepEqual(scan.lines, []);
  assert.equal(scan.spans.length, 0);
});

test("computeLivePreviewStyles does not parse escaped delimiters", () => {
  assert.equal(spansWithClass("\\*x\\*", "cm-lp-em").length, 0);
  assert.equal(spansWithClass("\\*\\*x\\*\\*", "cm-lp-strong").length, 0);
});

test("livePreviewDecorationsField includes inline source style decorations", () => {
  const state = EditorState.create({
    doc: "a **b** c\n> q\n",
    extensions: [cmLivePreview]
  });

  const found: Array<{ from: number; to: number; className: string }> = [];
  state
    .field(livePreviewDecorationsField)
    .decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (typeof decoration.spec.class === "string") {
        found.push({ from, to, className: decoration.spec.class });
      }
    });

  assert.ok(found.some((entry) => entry.className === "cm-lp-strong" && entry.from === 2 && entry.to === 7));
  assert.ok(found.some((entry) => entry.className === "cm-lp-marker" && entry.from === 2 && entry.to === 4));
  assert.ok(found.some((entry) => entry.className === "cm-lp-quote" && entry.from === 10));
});

// --- Floating overlay (cm-live-preview-float.ts) ----------------------------

test("resolveLivePreviewLayoutMode switches at the width threshold", () => {
  assert.equal(resolveLivePreviewLayoutMode(FLOAT_MODE_MIN_WIDTH - 1), "below");
  assert.equal(resolveLivePreviewLayoutMode(FLOAT_MODE_MIN_WIDTH), "float");
  assert.equal(resolveLivePreviewLayoutMode(1400), "float");
});

test("computeLivePreviewFloatFit fits the content's natural width or falls back below", () => {
  // Narrow content floats at exactly its natural width (no cap, no scrollbar).
  assert.deepEqual(computeLivePreviewFloatFit([100, 140, 120], 1000, 200), {
    mode: "float",
    left: 156,
    width: 200
  });

  // Wide content floats at natural width when it fits whole (beyond the old
  // 480 hard cap — the cap is the available width itself).
  assert.deepEqual(computeLivePreviewFloatFit([140], 1000, 700), { mode: "float", left: 156, width: 700 });

  // Boundary: naturalW == available exactly → still floats.
  assert.deepEqual(computeLivePreviewFloatFit([140], 452, 280), { mode: "float", left: 156, width: 280 });

  // 1px too wide → the block falls back to the full-width below preview.
  assert.deepEqual(computeLivePreviewFloatFit([140], 452, 281), { mode: "below", left: 0, width: 0 });

  // The code right edge alone decides when the slot is too narrow,
  // regardless of content width.
  assert.deepEqual(computeLivePreviewFloatFit([140], 300, 10), { mode: "below", left: 0, width: 0 });

  // naturalW unknown (first frame / async pending): provisional float at
  // min(480, available) — corrected once the content is measured.
  assert.deepEqual(computeLivePreviewFloatFit([140], 1000), { mode: "float", left: 156, width: 480 });
  assert.deepEqual(computeLivePreviewFloatFit([140], 500), { mode: "float", left: 156, width: 328 });
});

test("resolveLivePreviewFloatLayout pushes overlapping panels down", () => {
  const placements = resolveLivePreviewFloatLayout([
    { id: "a", top: 100, height: 50 },
    { id: "b", top: 120, height: 40 },
    { id: "c", top: 300, height: 30 }
  ]);

  // b overlaps a (a ends at 150) → pushed to 150 + 8; c keeps its anchor.
  assert.deepEqual(placements, [
    { id: "a", top: 100 },
    { id: "b", top: 158 },
    { id: "c", top: 300 }
  ]);
});

test("computeInlineMathFormulaLayout aligns boxes to their ideal x without overlap", () => {
  // No contention → ideal lefts kept.
  assert.deepEqual(
    computeInlineMathFormulaLayout([
      { idealLeft: 40, width: 50 },
      { idealLeft: 200, width: 60 }
    ]),
    [40, 200]
  );

  // Second box's ideal spot collides → pushed past the previous right edge + 16px gap.
  assert.deepEqual(
    computeInlineMathFormulaLayout([
      { idealLeft: 40, width: 100 },
      { idealLeft: 60, width: 30 }
    ]),
    [40, 156]
  );

  // Negative idealLeft is preserved (boxes extend left of the anchor span to
  // their own formula's source x — the anchor sits at the last formula's end).
  assert.deepEqual(computeInlineMathFormulaLayout([{ idealLeft: -10, width: 20 }]), [-10]);
});

test("inline math bands stay below the source in float mode", () => {
  // Write mode: this test is about float suppression, not reading behavior.
  setReadingMode("write");
  const standInView = {} as unknown as EditorView;
  try {
    let state = EditorState.create({
      doc: "a $x$ b\n\n$$y$$\n",
      extensions: [cmLivePreview]
    });
    // Bands only render once the wrap end is measured (宁缺毋错).
    state = state.update({ effects: setInlineMathWrapEnds.of(new Map([[2, 7]])) }).state;

    // Below mode: one inline-math band (inline, not counted by
    // blockWidgetSpecs) plus the $$ block widget.
    assert.equal(inlineMathBandSpecs(state).length, 1);
    assert.equal(blockWidgetSpecs(state).length, 1);

    reportLivePreviewFloatMode(standInView, true);
    state = state.update({ effects: refreshLivePreview.of(null) }).state;
    // Float mode: the $$ below-widget is suppressed (no block widgets left);
    // the inline-math band always stays below (unmeasured → line end, 7).
    assert.deepEqual(blockWidgetSpecs(state), []);
    assert.deepEqual(inlineMathBandSpecs(state), [{ from: 7, to: 7, side: -1 }]);
  } finally {
    reportLivePreviewFloatMode(standInView, false);
    setReadingMode("read");
  }
});

test("layout mode joins the decoration salt: float mode suppresses below widgets", () => {
  // reportLivePreviewFloatMode only tracks the view in a set and dispatches
  // refreshes to registered live views (none headless) — a stand-in suffices.
  const standInView = {} as unknown as EditorView;
  let state = EditorState.create({
    doc: "$$x$$\ntext\n",
    extensions: [cmLivePreview]
  });
  assert.equal(blockWidgetSpecs(state).length, 1);

  reportLivePreviewFloatMode(standInView, true);
  try {
    state = state.update({ effects: refreshLivePreview.of(null) }).state;
    assert.equal(blockWidgetSpecs(state).length, 0);

    reportLivePreviewFloatMode(standInView, false);
    state = state.update({ effects: refreshLivePreview.of(null) }).state;
    assert.equal(blockWidgetSpecs(state).length, 1);
  } finally {
    reportLivePreviewFloatMode(standInView, false);
  }
});

// --- Reading mode (cm-reading-mode.ts) ---------------------------------------

test("isInCursorRegion includes boundaries", () => {
  assert.equal(isInCursorRegion(10, 20, 10), true);
  assert.equal(isInCursorRegion(10, 20, 20), true);
  assert.equal(isInCursorRegion(10, 20, 15), true);
  assert.equal(isInCursorRegion(10, 20, 9), false);
  assert.equal(isInCursorRegion(10, 20, 21), false);
});

test("reading mode defaults and persists to localStorage when available", () => {
  assert.equal(getReadingMode(), "read");

  const store = new Map<string, string>();
  const globalWithWindow = globalThis as { window?: unknown };
  const originalWindow = globalWithWindow.window;
  globalWithWindow.window = {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value)
    }
  };
  try {
    setReadingMode("write");
    assert.equal(getReadingMode(), "write");
    assert.equal(store.get("workbench.readingMode"), "write");
  } finally {
    setReadingMode("read");
    globalWithWindow.window = originalWindow;
  }
});

interface ReplaceSpec {
  from: number;
  to: number;
  block: boolean;
}

function replaceWidgetSpecs(state: EditorState): ReplaceSpec[] {
  const specs: ReplaceSpec[] = [];
  state
    .field(livePreviewDecorationsField)
    .decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.widget && from !== to) {
        specs.push({ from, to, block: decoration.spec.block === true });
      }
    });
  return specs;
}

test("reading mode replaces constructs outside the cursor region, expands inside", () => {
  setReadingMode("read");
  try {
    // Block math ranges: [0,5] and [11,17]; cursor starts inside the first.
    let state = EditorState.create({
      doc: "$$x$$\ntext\n$$y$$\n",
      selection: { anchor: 2 },
      extensions: [cmLivePreview]
    });

    // Outside block [11,16] is block-replaced; inside block [0,5] keeps
    // source + below preview widget.
    assert.deepEqual(replaceWidgetSpecs(state), [{ from: 11, to: 16, block: true }]);
    const pointWidgets = (s: EditorState) => blockWidgetSpecs(s).filter((spec) => spec.from === spec.to);
    assert.deepEqual(pointWidgets(state), [{ from: 5, to: 5, side: 1 }]);

    // Cursor into the second block → it expands (replace moves to the first).
    state = state.update({ selection: { anchor: 13 } }).state;
    assert.deepEqual(replaceWidgetSpecs(state), [{ from: 0, to: 5, block: true }]);
    assert.deepEqual(pointWidgets(state), [{ from: 16, to: 16, side: 1 }]);
  } finally {
    setReadingMode("read");
  }
});

test("reading mode inline-replaces formulas outside the cursor region", () => {
  setReadingMode("read");
  try {
    // Formula span [2,5]; cursor outside → inline (non-block) replacement.
    let state = EditorState.create({
      doc: "a $x$ b\n",
      selection: { anchor: 0 },
      extensions: [cmLivePreview]
    });
    assert.deepEqual(replaceWidgetSpecs(state), [{ from: 2, to: 5, block: false }]);
    assert.equal(blockWidgetSpecs(state).length, 0);

    // Cursor into the formula → source stays; the band appears once the
    // wrap end is measured (宁缺毋错 — nothing before that).
    state = state.update({ selection: { anchor: 3 } }).state;
    assert.equal(replaceWidgetSpecs(state).length, 0);
    assert.equal(inlineMathBandSpecs(state).length, 0);
    state = state.update({ effects: setInlineMathWrapEnds.of(new Map([[2, 7]])) }).state;
    assert.deepEqual(inlineMathBandSpecs(state), [{ from: 7, to: 7, side: -1 }]);
  } finally {
    setReadingMode("read");
  }
});

test("write mode never replaces source", () => {
  setReadingMode("write");
  try {
    const state = EditorState.create({
      doc: "$$x$$\ntext\n$$y$$\n",
      selection: { anchor: 2 },
      extensions: [cmLivePreview]
    });
    assert.equal(replaceWidgetSpecs(state).length, 0);
    assert.equal(blockWidgetSpecs(state).length, 2);
  } finally {
    setReadingMode("read");
  }
});

test("reading mode expands at the adjacent positions CM cursor motion actually reaches", () => {
  // CM vertical cursor motion skips replaced ranges: the head jumps between
  // from−1 and to+1. Those adjacent positions must count as inside.
  setReadingMode("read");
  try {
    // Block [5,10] on the second line; trailing line gives valid to+1/to+2.
    let state = EditorState.create({ doc: "text\n$$x$$\nmore\n", selection: { anchor: 0 }, extensions: [cmLivePreview] });
    assert.deepEqual(replaceWidgetSpecs(state), [{ from: 5, to: 10, block: true }]);

    // head at to+1 (11, start of the trailing line) → inside → expanded.
    state = state.update({ selection: { anchor: 11 } }).state;
    assert.equal(replaceWidgetSpecs(state).length, 0);

    // head two past the end (12) → outside → hidden again.
    state = state.update({ selection: { anchor: 12 } }).state;
    assert.deepEqual(replaceWidgetSpecs(state), [{ from: 5, to: 10, block: true }]);

    // head at from−1 (4, end of the previous line) → inside → expanded.
    state = state.update({ selection: { anchor: 4 } }).state;
    assert.equal(replaceWidgetSpecs(state).length, 0);

    // head at from−2 (3) → outside → hidden.
    state = state.update({ selection: { anchor: 3 } }).state;
    assert.deepEqual(replaceWidgetSpecs(state), [{ from: 5, to: 10, block: true }]);
  } finally {
    setReadingMode("read");
  }
});

// --- Visual-line grouping of inline math bands --------------------------------

test("groupInlineMathByVisualLine groups formulas by measured visual top", () => {
  const formulas = [
    { from: 10, to: 15, tex: "a" },
    { from: 30, to: 35, tex: "b" },
    { from: 60, to: 65, tex: "c" }
  ];
  const tops = new Map([
    [10, 100],
    [30, 100],
    [60, 140]
  ]);
  const groups = groupInlineMathByVisualLine(formulas, (from) => tops.get(from), () => 0);

  // Same visual top (a+b) → one group anchored at the last formula end.
  assert.deepEqual(
    groups.map((group) => [group.from, group.to]),
    [
      [10, 35],
      [60, 65]
    ]
  );
  assert.deepEqual(
    groups[0].formulas.map((formula) => formula.tex),
    ["a", "b"]
  );
});

test("groupInlineMathByVisualLine falls back to logical lines without measurements", () => {
  const formulas = [
    { from: 10, to: 15, tex: "a" },
    { from: 30, to: 35, tex: "b" }
  ];

  const split = groupInlineMathByVisualLine(formulas, () => undefined, (from) => (from < 20 ? 1 : 2));
  assert.deepEqual(
    split.map((group) => [group.from, group.to]),
    [
      [10, 15],
      [30, 35]
    ]
  );

  const merged = groupInlineMathByVisualLine(formulas, () => undefined, () => 1);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].to, 35);
});

test("same-line formulas share one band anchored at the last formula's wrap end", () => {
  setReadingMode("write");
  try {
    // Formulas at [2,5] and [10,13]; without measured tops the logical-line
    // fallback groups them into a single band, anchored at the LAST
    // formula's measured wrap end (17).
    let state = EditorState.create({
      doc: "a $x$ and $y$ end\n",
      extensions: [cmLivePreview]
    });
    state = state.update({ effects: setInlineMathWrapEnds.of(new Map([[10, 17]])) }).state;
    assert.deepEqual(inlineMathBandSpecs(state), [{ from: 17, to: 17, side: -1 }]);
  } finally {
    setReadingMode("read");
  }
});

test("measured visual tops regroup a same-line formula pair into separate bands", () => {
  setReadingMode("write");
  try {
    let state = EditorState.create({
      doc: "a $x$ and $y$ end\n",
      extensions: [cmLivePreview]
    });
    // Nothing banded before measurement (宁缺毋错).
    assert.equal(inlineMathBandSpecs(state).length, 0);

    // The two formulas land on different visual lines (wrapped paragraph):
    // one band each, anchored at its row's measured wrap end.
    state = state.update({
      effects: [
        setInlineMathVisualTops.of(
          new Map([
            [2, 100],
            [10, 160]
          ])
        ),
        setInlineMathWrapEnds.of(
          new Map([
            [2, 8],
            [10, 17]
          ])
        )
      ]
    }).state;
    assert.deepEqual(inlineMathBandSpecs(state), [
      { from: 8, to: 8, side: -1 },
      { from: 17, to: 17, side: -1 }
    ]);
  } finally {
    setReadingMode("read");
  }
});

test("groupInlineMathByVisualLine attaches unmeasured formulas instead of fragmenting", () => {
  const formulas = [
    { from: 10, to: 15, tex: "a" },
    { from: 20, to: 25, tex: "b" },
    { from: 30, to: 35, tex: "c" }
  ];

  // Only a and c are measured (same logical line), with different tops →
  // split before c; the unmeasured b stays attached to a.
  const tops = new Map([
    [10, 100],
    [30, 160]
  ]);
  assert.deepEqual(
    groupInlineMathByVisualLine(formulas, (from) => tops.get(from), () => 0).map((group) => [
      group.from,
      group.to
    ]),
    [
      [10, 25],
      [30, 35]
    ]
  );

  // Only a is measured → nothing has split evidence → one group.
  const onlyA = groupInlineMathByVisualLine(formulas, (from) => (from === 10 ? 100 : undefined), () => 0);
  assert.equal(onlyA.length, 1);
  assert.equal(onlyA[0].to, 35);
});

// --- Setext/hr suppression inside math ---------------------------------------

test("computeLivePreviewStyles suppresses setext headings inside $$ blocks", () => {
  // A lone `=` line inside a math block would otherwise turn the whole block
  // into an h1-styled "heading" (observed in the wild).
  const scan = computeLivePreviewStyles("$$\n\\frac{a}{b}\nx + y\n=\n$$\n");
  assert.deepEqual(scan.lines, []);
  assert.equal(spansWithClass("$$\n\\frac{a}{b}\nx + y\n=\n$$\n", "cm-lp-marker").length, 0);

  // A real setext heading outside math still gets styled.
  const real = computeLivePreviewStyles("Title\n===\n");
  assert.deepEqual(real.lines, [{ from: 0, className: "cm-lp-h1" }]);
});

test("computeLivePreviewStyles suppresses hr and setext h2 inside $$ blocks", () => {
  const inside = computeLivePreviewStyles("$$\n---\n$$\n");
  assert.deepEqual(inside.lines, []);

  // `---` outside math is still a horizontal rule.
  const outside = computeLivePreviewStyles("---\ntext\n");
  assert.deepEqual(outside.lines, [{ from: 0, className: "cm-lp-hr" }]);
});

// --- Band decoration form (inline widget, natural wrap-end anchor) -----------

test("inline math band is an inline (non-block) widget that waits for the wrap end", () => {
  setReadingMode("write");
  try {
    // 宁缺毋错: unmeasured rows render NO band (never a fallback position).
    let state = EditorState.create({ doc: "a $x$ more\n", extensions: [cmLivePreview] });
    assert.equal(inlineMathBandSpecs(state).length, 0);
    // Once measured (short line → wrap end = line end, 10), the band
    // appears there as an inline widget.
    state = state.update({ effects: setInlineMathWrapEnds.of(new Map([[2, 10]])) }).state;
    assert.deepEqual(inlineMathBandSpecs(state), [{ from: 10, to: 10, side: -1 }]);
    // The band must NOT be a block widget — mid-line block widgets are what
    // desynced CM's height map (see InlineMathRowWidget).
    assert.equal(blockWidgetSpecs(state).length, 0);
  } finally {
    setReadingMode("read");
  }
});

test("inline math band anchor follows the measured wrap end", () => {
  setReadingMode("write");
  try {
    // Same line with a measured wrap end at 5 (the row wraps right after
    // the formula): the band moves from the line end to the wrap end.
    let state = EditorState.create({ doc: "a $x$ more\n", extensions: [cmLivePreview] });
    state = state.update({ effects: setInlineMathWrapEnds.of(new Map([[2, 5]])) }).state;
    assert.deepEqual(inlineMathBandSpecs(state), [{ from: 5, to: 5, side: -1 }]);
  } finally {
    setReadingMode("read");
  }
});

test("findVisualRowWrapEnd: binary search for the first lower-row position", () => {
  // Row layout: positions 0..39 on top 100, 40.. on top 121 → wrap end 40.
  const topFor = (pos: number) => (pos < 40 ? 100 : 121);
  assert.equal(findVisualRowWrapEnd(0, 80, 100, topFor), 40);

  // No wrap (everything at 100) → `to`.
  assert.equal(findVisualRowWrapEnd(0, 80, 100, () => 100), 80);

  // Tolerance: a 1.5px dip does not count as a wrap.
  assert.equal(findVisualRowWrapEnd(0, 80, 100, (pos) => (pos < 40 ? 100 : 101.5)), 80);
  // …but 3px does (tolerance 2).
  assert.equal(findVisualRowWrapEnd(0, 80, 100, (pos) => (pos < 40 ? 100 : 103)), 40);

  // Unmeasurable (null) positions skew right but never break the search.
  assert.equal(
    findVisualRowWrapEnd(0, 80, 100, (pos) => (pos === 40 ? null : pos < 40 ? 100 : 121)),
    41
  );

  // Domain starts mid-line: a wrap BEFORE `from` is invisible.
  assert.equal(findVisualRowWrapEnd(40, 80, 121, topFor), 80);
});

test("resolveInlineMathBandAnchor fallback is gone: no band without a measured wrap end", () => {
  setReadingMode("write");
  try {
    // 宁缺毋错 — the builder must NOT emit a band while the wrap end is
    // unknown (first frame, off-viewport, or pre-measure after an edit).
    const state = EditorState.create({
      doc: "a $x$ and $y$ end\n",
      extensions: [cmLivePreview]
    });
    assert.equal(inlineMathBandSpecs(state).length, 0);
  } finally {
    setReadingMode("read");
  }
});

test("shouldScheduleInlineMathMeasure covers selection-only and decoration updates", () => {
  const base = EditorState.create({ doc: "a $x$ b\n", extensions: [cmLivePreview] });
  // Selection-only transaction (read-mode expand/collapse path) → measure.
  const selectionTr = base.update({ selection: { anchor: 3 } });
  assert.equal(shouldScheduleInlineMathMeasure(selectionTr as unknown as ViewUpdate), true);
  // Doc change → measure.
  const docTr = base.update({ changes: { from: 0, insert: "z" } });
  assert.equal(shouldScheduleInlineMathMeasure(docTr as unknown as ViewUpdate), true);
  // Forced decoration rebuild (wrap-end writeback) → measure.
  const effectTr = base.update({ effects: setInlineMathWrapEnds.of(new Map([[2, 7]])) });
  assert.equal(shouldScheduleInlineMathMeasure(effectTr as unknown as ViewUpdate), true);
  // No-op transaction → no measure.
  const noopTr = base.update({});
  assert.equal(shouldScheduleInlineMathMeasure(noopTr as unknown as ViewUpdate), false);
});

test("first entry anchors at the measured wrap end; cycles are identical", () => {
  setReadingMode("read");
  try {
    const doc = "a $x$ and $y$ end\n";
    const wrapEnds = new Map([[10, 17]]);
    // Out of region → replaced, no band.
    let state = EditorState.create({ doc, selection: { anchor: 0 }, extensions: [cmLivePreview] });
    assert.equal(inlineMathBandSpecs(state).length, 0);
    // First entry with the wrap end already measured → band straight at it.
    const enter = (s: EditorState) =>
      s.update({ selection: { anchor: 11 }, effects: setInlineMathWrapEnds.of(wrapEnds) }).state;
    const cycle1 = enter(state);
    assert.deepEqual(inlineMathBandSpecs(cycle1), [{ from: 17, to: 17, side: -1 }]);
    // Exit → replaced again; re-enter → pixel-identical spec (cycle consistency).
    state = cycle1.update({ selection: { anchor: 0 } }).state;
    assert.equal(inlineMathBandSpecs(state).length, 0);
    const cycle2 = enter(state);
    assert.deepEqual(inlineMathBandSpecs(cycle2), inlineMathBandSpecs(cycle1));
    const cycle3 = enter(cycle2.update({ selection: { anchor: 0 } }).state);
    assert.deepEqual(inlineMathBandSpecs(cycle3), inlineMathBandSpecs(cycle1));
  } finally {
    setReadingMode("read");
  }
});

// --- Math-region markdown filtering (task: full matrix) -----------------------

test("computeLivePreviewStyles suppresses inline styles contained in math", () => {
  // emphasis/code/link fully inside `$...$` → nothing.
  assert.equal(spansWithClass("$*em*$", "cm-lp-em").length, 0);
  assert.equal(spansWithClass("$`c`$", "cm-lp-code").length, 0);
  assert.equal(spansWithClass("$[t](u)$", "cm-lp-link").length, 0);
  assert.equal(spansWithClass("$[t](u)$", "cm-lp-url").length, 0);
  assert.equal(spansWithClass("$**b**$", "cm-lp-strong").length, 0);
  assert.equal(spansWithClass("$~~s~~$", "cm-lp-strike").length, 0);

  // Outside math they style normally.
  assert.equal(spansWithClass("*em*", "cm-lp-em").length, 1);
  assert.equal(spansWithClass("`c`", "cm-lp-code").length, 1);
  assert.equal(spansWithClass("[t](u)", "cm-lp-link").length, 1);
});

test("computeLivePreviewStyles keeps markdown spans that contain math", () => {
  // `**$x$**`: the strong markers live OUTSIDE the math region — legal, kept.
  const strong = spansWithClass("**$x$**", "cm-lp-strong");
  assert.equal(strong.length, 1);
  // "**$x$**" is 7 chars: ** $ x $ **
  assert.deepEqual([strong[0].from, strong[0].to], [0, 7]);

  const code = spansWithClass("`$x$`", "cm-lp-code");
  assert.equal(code.length, 1);
});

test("computeLivePreviewStyles suppresses line-level constructs inside $$ blocks", () => {
  const text = [
    "$$",
    "> not a quote",
    "- not a list",
    "1. not ordered",
    "# not a heading",
    "===",
    "---",
    "- [ ] not a task",
    "$$"
  ].join("\n");
  const scan = computeLivePreviewStyles(text);

  assert.deepEqual(scan.lines, []);
  assert.equal(spansWithClass(text, "cm-lp-listmark").length, 0);
  assert.equal(spansWithClass(text, "cm-lp-marker").length, 0);
  assert.equal(spansWithClass(text, "cm-lp-strike").length, 0);
});

test("computeLivePreviewRanges suppresses ATX headings inside $$ blocks", () => {
  const text = "$$\n# not a heading\n$$\n# real heading\n";
  const result = headings(computeLivePreviewRanges(text));
  assert.equal(result.length, 1);
  assert.equal(result[0].level, 1);
  // The real heading is on line 4 (offset 22).
  assert.equal(result[0].from, 22);
});

test("math range helpers: contains vs intersects multi-line", () => {
  // "ab $x$ cd"(0-9) / "$$"(10-12) / "y"(13-14) / "$$"(15-17)
  const lineStarts = [0, 10, 13, 15];
  const ranges = buildLivePreviewMathRanges("ab $x$ cd\n$$\ny\n$$", lineStarts);

  assert.equal(isInsideMathRange(ranges, 4, 6), true); // inside $x$
  assert.equal(isInsideMathRange(ranges, 0, 3), false); // outside
  assert.equal(intersectsMultiLineMathRange(ranges, 10, 11), true); // $$ opening line
  assert.equal(intersectsMultiLineMathRange(ranges, 4, 6), false); // single-line math doesn't count
});

// --- Unclosed-math ranges (task: cover unclosed math) -------------------------

test("unclosed $$ suppresses setext heading on its own line and following === lines", () => {
  // `$$` unclosed, `====` next line: the `$$` line must NOT become a heading.
  const scan = computeLivePreviewStyles("$$\n====\n");
  assert.deepEqual(scan.lines, []);
  assert.equal(spansWithClass("$$\n====\n", "cm-lp-marker").length, 0);

  const scan2 = computeLivePreviewStyles("$$\n内容\n===\n");
  assert.deepEqual(scan2.lines, []);
});

test("closing the block later restores normal setext handling outside math", () => {
  // After `$$\n==\n$$\n`, a REAL setext heading outside math still styles.
  const scan = computeLivePreviewStyles("$$\n==\n$$\nReal Title\n===\n");
  assert.deepEqual(scan.lines, [{ from: 9, className: "cm-lp-h1" }]);
});

test("unclosed single $ suppresses inline styles to its line end", () => {
  // `$abc**def**`: the `**` after the unclosed `$` must not be strong.
  assert.equal(spansWithClass("$abc**def**", "cm-lp-strong").length, 0);
  // Outside math, `**def**` styles normally.
  assert.equal(spansWithClass("**def**", "cm-lp-strong").length, 1);
});

test("buildLivePreviewMathRanges appends unclosed tails", () => {
  const blockText = "$$\nx\n";
  const blockStarts = [0, 3, 5];
  const blockRanges = buildLivePreviewMathRanges(blockText, blockStarts);
  assert.ok(blockRanges.some((range) => range.multiLine && range.from === 0 && range.to === blockText.length));

  const inlineText = "a $bc";
  const inlineStarts = [0];
  const inlineRanges = buildLivePreviewMathRanges(inlineText, inlineStarts);
  assert.ok(inlineRanges.some((range) => !range.multiLine && range.from === 2 && range.to === inlineText.length));
});

// --- Rollback: no custom vertical-cursor commands ------------------------------

test("no band-aware cursor keymap is registered (rollback to CM default)", () => {
  // The custom DOM-driven cursor keymap was rolled back after it made cursor
  // behavior worse; vertical motion is entirely CM's cursorLineUp/Down.
  const source = readFileSync(fileURLToPath(new URL("./cm-live-preview.ts", import.meta.url)), "utf8");
  assert.equal(source.includes("cmBandAwareCursorKeymap"), false);
  assert.equal(source.includes("bandAwareVerticalMove"), false);
});

// --- Math-atomic lezer grammar (cmMathMarkdown) ------------------------------

const mathAwareParser = (markdownLanguage.parser as MarkdownParser).configure(cmMathMarkdown);

function nodeNames(docText: string): string[] {
  const names: string[] = [];
  const cursor = mathAwareParser.parse(docText).cursor();
  do {
    names.push(cursor.type.name);
  } while (cursor.next());
  return names;
}

test("cmMathMarkdown: inline `$...$` is atomic — no emphasis inside, code outside survives", () => {
  const names = nodeNames("$a * b * c$ and `x` outside\n");
  assert.ok(names.includes("InlineMath"));
  assert.ok(names.includes("InlineCode"));
  assert.equal(names.includes("Emphasis"), false);
});

test("cmMathMarkdown: `**x**` inside a $$ block is not strong, outside is", () => {
  const inside = nodeNames("$$\n**x**\n$$\n");
  assert.ok(inside.includes("DisplayMath"));
  assert.equal(inside.includes("StrongEmphasis"), false);

  assert.ok(nodeNames("**x**\n").includes("StrongEmphasis"));
});

test("cmMathMarkdown: heading/quote/list/setext markers inside $$ stay unparsed", () => {
  const names = nodeNames("$$\n# h\n> q\n- i\n==\n$$\n");
  assert.ok(names.includes("DisplayMath"));
  for (const banned of ["ATXHeading1", "Blockquote", "BulletList", "SetextHeading1"]) {
    assert.equal(names.includes(banned), false, banned);
  }
});

test("cmMathMarkdown: bold outside math survives wrapping a formula", () => {
  const names = nodeNames("**$x$**\n");
  assert.ok(names.includes("InlineMath"));
  assert.ok(names.includes("StrongEmphasis"));
});

test("cmMathMarkdown: one-line $$x$$ is a block only without trailing content", () => {
  assert.ok(nodeNames("$$x$$\n").includes("DisplayMath"));

  const trailing = nodeNames("$$x$$ tail\n");
  assert.equal(trailing.includes("DisplayMath"), false);
  assert.ok(trailing.includes("InlineMath")); // atomized inside the paragraph
});

test("cmMathMarkdown: $$ block interrupts a paragraph and closes", () => {
  const names = nodeNames("text\n$$\nx\n$$\nafter\n");
  assert.ok(names.includes("DisplayMath"));
  assert.equal(names.includes("StrongEmphasis"), false);
});

test("cmMathMarkdown: unclosed math is atomic to the block/line end (mid-typing)", () => {
  // Unclosed $$ block runs to end of input.
  assert.ok(nodeNames("$$\nx + y\n").includes("DisplayMath"));

  // Unclosed inline $ runs to its line end only — the next line still gets
  // markdown styling (the two lines form ONE paragraph's inline section).
  const names = nodeNames("a $bc **de**\nnext **fg**\n");
  assert.ok(names.includes("InlineMath"));
  assert.equal(
    names.filter((name) => name === "StrongEmphasis").length,
    1,
    "only the second line's `**fg**` is strong"
  );
});

test("cmMathMarkdown: escaped \\$ and backtick-quoted $ never open math", () => {
  const names = nodeNames("a \\$5 and `$x$` b\n");
  assert.equal(names.includes("InlineMath"), false);
  assert.ok(names.includes("InlineCode"));
});

// --- Math neutralization marks (cm-lp-math) -----------------------------------

function mathMarkSpecs(state: EditorState): { from: number; to: number }[] {
  const specs: { from: number; to: number }[] = [];
  state
    .field(livePreviewDecorationsField)
    .decorations.between(0, state.doc.length, (from, to, decoration) => {
      if (decoration.spec.class === "cm-lp-math") {
        specs.push({ from, to });
      }
    });
  return specs;
}

test("math neutralization marks cover inline and block math source in write mode", () => {
  setReadingMode("write");
  try {
    const state = EditorState.create({
      doc: "a $x$ b\n\n$$y$$\n",
      extensions: [cmLivePreview]
    });
    assert.deepEqual(mathMarkSpecs(state), [
      { from: 2, to: 5 },
      { from: 9, to: 14 }
    ]);
  } finally {
    setReadingMode("read");
  }
});

test("math neutralization marks skip read-mode replaced ranges (KaTeX keeps its fonts)", () => {
  setReadingMode("read");
  try {
    let state = EditorState.create({
      doc: "a $x$ b\n",
      selection: { anchor: 0 },
      extensions: [cmLivePreview]
    });
    // Head at 0 is outside the formula zone → replaced → no mark.
    assert.deepEqual(mathMarkSpecs(state), []);

    state = state.update({ selection: { anchor: 3 } }).state;
    assert.deepEqual(mathMarkSpecs(state), [{ from: 2, to: 5 }]);
  } finally {
    setReadingMode("read");
  }
});

test("math neutralization mark on $$ blocks follows read-mode visibility", () => {
  setReadingMode("read");
  try {
    let state = EditorState.create({
      doc: "$$x$$\ntext\n",
      selection: { anchor: 2 },
      extensions: [cmLivePreview]
    });
    assert.deepEqual(mathMarkSpecs(state), [{ from: 0, to: 5 }]);

    // Head outside the zone → block hidden → no mark.
    state = state.update({ selection: { anchor: 8 } }).state;
    assert.deepEqual(mathMarkSpecs(state), []);
  } finally {
    setReadingMode("read");
  }
});

test("subtractCoveringSpans: full/partial/no coverage", () => {
  // Full coverage → nothing left.
  assert.deepEqual(subtractCoveringSpans(2, 5, [{ from: 0, to: 7 }]), []);
  // No coverage → the whole range.
  assert.deepEqual(subtractCoveringSpans(2, 5, []), [{ from: 2, to: 5 }]);
  // Partial coverage splits the range.
  assert.deepEqual(subtractCoveringSpans(0, 10, [{ from: 3, to: 5 }]), [
    { from: 0, to: 3 },
    { from: 5, to: 10 }
  ]);
  // Out-of-range spans are ignored; adjacent coverage merges into the cursor.
  assert.deepEqual(
    subtractCoveringSpans(0, 10, [
      { from: 20, to: 30 },
      { from: 1, to: 2 },
      { from: 2, to: 4 }
    ]),
    [
      { from: 0, to: 1 },
      { from: 4, to: 10 }
    ]
  );
});

test("math neutralization mark yields to outer markdown constructs (**$x$**)", () => {
  setReadingMode("write");
  try {
    // The strong span covers the whole formula → no mark at all, bold survives.
    const wrapped = EditorState.create({ doc: "**$x$**\n", extensions: [cmLivePreview] });
    assert.deepEqual(mathMarkSpecs(wrapped), []);

    // Second formula outside the strong span still gets its mark.
    const mixed = EditorState.create({ doc: "**$x$** tail $y$\n", extensions: [cmLivePreview] });
    assert.deepEqual(mathMarkSpecs(mixed), [{ from: 13, to: 16 }]);
  } finally {
    setReadingMode("read");
  }
});

// --- Click-to-jump on previews -----------------------------------------------

test("resolveBlockPreviewJumpTarget: per construct", () => {
  const lineStarts = [0, 5, 10, 20, 30];

  // Multi-line $$ (from line 0 to line 2) → line start below the opening $$.
  assert.equal(resolveBlockPreviewJumpTarget("blockMath", 0, 15, lineStarts), 5);
  // Single-line $$x$$ → right after the opening $$ (from + 2).
  assert.equal(resolveBlockPreviewJumpTarget("blockMath", 10, 14, lineStarts), 12);
  // Table → line start of the first row.
  assert.equal(resolveBlockPreviewJumpTarget("table", 12, 25, lineStarts), 10);
  // Fence → line start below the opening fence (clamped at the last line).
  assert.equal(resolveBlockPreviewJumpTarget("fence", 20, 28, lineStarts), 30);
  assert.equal(resolveBlockPreviewJumpTarget("fence", 30, 30, lineStarts), 30);
  // Image → the range start (`![`).
  assert.equal(resolveBlockPreviewJumpTarget("image", 21, 28, lineStarts), 21);
});

test("isPreviewJumpClick: 4px drag threshold (squared comparison)", () => {
  assert.equal(isPreviewJumpClick(0, 0), true);
  assert.equal(isPreviewJumpClick(3, 0), true);
  assert.equal(isPreviewJumpClick(-3, 2), true); // √13 < 4
  assert.equal(isPreviewJumpClick(4, 0), false);
  assert.equal(isPreviewJumpClick(0, -4), false);
  assert.equal(isPreviewJumpClick(2, 4), false); // √20 > 4
  assert.equal(isPreviewJumpClick(10, 10), false);
});

test("inline math band widget exposes per-box jump bases (formula.from)", () => {
  setReadingMode("write");
  try {
    let state = EditorState.create({ doc: "a $x$ and $y$\n", extensions: [cmLivePreview] });
    state = state.update({ effects: setInlineMathWrapEnds.of(new Map([[10, 14]])) }).state;
    const widgets: InlineMathRowWidget[] = [];
    state
      .field(livePreviewDecorationsField)
      .decorations.between(0, state.doc.length, (_from, _to, decoration) => {
        if (decoration.spec.widget instanceof InlineMathRowWidget) {
          widgets.push(decoration.spec.widget);
        }
      });
    assert.equal(widgets.length, 1);
    // Box i jumps to formulas[i].from + 1 (right after the opening `$`).
    assert.deepEqual(widgets[0].formulas.map((formula) => formula.from), [2, 10]);
  } finally {
    setReadingMode("read");
  }
});

test("read-mode inline replace widget carries formula from+1 as jump target", () => {
  setReadingMode("read");
  try {
    const state = EditorState.create({
      doc: "a $x$ b\n",
      selection: { anchor: 0 },
      extensions: [cmLivePreview]
    });
    const targets: (number | null)[] = [];
    state
      .field(livePreviewDecorationsField)
      .decorations.between(0, state.doc.length, (from, to, decoration) => {
        if (from !== to && decoration.spec.widget) {
          targets.push((decoration.spec.widget as { jumpTarget?: number | null }).jumpTarget ?? null);
        }
      });
    // Formula [2,5] → jump target 3 (right after the opening `$`).
    assert.deepEqual(targets, [3]);
  } finally {
    setReadingMode("read");
  }
});

test("reconcileFloatWidth: grow / keep / below, idempotent and never shrinks", () => {
  // Content wider than the panel but still fitting → grow to the scrollWidth.
  assert.deepEqual(reconcileFloatWidth(155, 164, 600), { kind: "grow", width: 164 });
  // Equal → keep (no scrollbar, nothing to do).
  assert.deepEqual(reconcileFloatWidth(164, 164, 600), { kind: "keep", width: 164 });
  // Content narrower than the panel → keep (NEVER shrink — that is what
  // makes the pass idempotent and jitter-free).
  assert.deepEqual(reconcileFloatWidth(200, 164, 600), { kind: "keep", width: 200 });
  // Exactly at the available limit → still fits, grow allowed.
  assert.deepEqual(reconcileFloatWidth(100, 600, 600), { kind: "grow", width: 600 });
  // 1px over available → the block flips below.
  assert.deepEqual(reconcileFloatWidth(100, 601, 600), { kind: "below" });
  // Idempotency: reconciling a grown width again keeps it.
  const grown = reconcileFloatWidth(155, 164, 600);
  assert.equal(grown.kind, "grow");
  if (grown.kind === "grow") {
    assert.deepEqual(reconcileFloatWidth(grown.width, 164, 600), { kind: "keep", width: 164 });
  }
  // Zero-content edge (panel without measurable content) keeps its width.
  assert.deepEqual(reconcileFloatWidth(155, 0, 600), { kind: "keep", width: 155 });
});
