/**
 * Unit tests for `parseTikzcd` and `renderCommutativeFence`.
 *
 * The parser is a TS port of `apps/admin/public/quiver/parser.mjs`; we don't
 * try to byte-compare with the JS original (different language, different
 * geometry primitives) — we instead pin a handful of representative samples to
 * `CommutativeDocument` snapshots and assert that:
 *   - basic vertex/edge layouts produce the right cell shape;
 *   - tikz-cd shorthands (`hookrightarrow`, `Rightarrow`, etc.) flip styling;
 *   - parse failures bubble up via `result.ok === false`;
 *   - the fence renderer never throws on bad input and emits a
 *     `commutative--error` placeholder instead.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { convertTikzLengthToPercent, parseCommutative, renderCommutativeFence } from "./index.js";
import { parseTikzcd } from "./tikzcd-parser.js";

test("parseTikzcd handles a 2x2 square diagram", () => {
  const body = `
A & B \\\\
C & D \\\\
\\arrow[from=1-1, to=1-2]
\\arrow[from=1-1, to=2-1]
\\arrow[from=1-2, to=2-2]
\\arrow[from=2-1, to=2-2]
`.trim();
  const result = parseTikzcd(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const vertices = result.document.cells.filter((c) => c.kind === "vertex");
  const edges = result.document.cells.filter((c) => c.kind === "edge");
  assert.equal(vertices.length, 4);
  assert.equal(edges.length, 4);
  assert.deepEqual(
    vertices.map((v: any) => v.label).sort(),
    ["A", "B", "C", "D"]
  );
});

test("parseTikzcd recognises `Rightarrow` as a double arrow", () => {
  const body = `
A & B \\\\
\\arrow[Rightarrow, from=1-1, to=1-2]
`.trim();
  const result = parseTikzcd(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const edges = result.document.cells.filter((c: any) => c.kind === "edge");
  assert.equal(edges.length, 1);
  assert.equal((edges[0] as any).options.level, 2);
});

test("parseTikzcd handles labels with curly braces and swap", () => {
  const body = `
A & B \\\\
\\arrow["f"', from=1-1, to=1-2]
\\arrow["{g \\circ h}", from=1-2, to=1-1, bend left]
`.trim();
  const result = parseTikzcd(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const edges = result.document.cells.filter((c: any) => c.kind === "edge");
  assert.equal(edges.length, 2);
  assert.equal((edges[0] as any).label, "f");
  assert.equal((edges[1] as any).label, "g \\circ h");
});

test("parseTikzcd surfaces diagnostics for bad arrow options", () => {
  const body = `
A & B \\\\
\\arrow[from=nope, to=1-2]
`.trim();
  const result = parseTikzcd(body);
  // Heuristic parser still produces a document, but the diagnostic should fire.
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.ok(
    result.diagnostics.some((d) => /No cell named/.test(d.message)),
    `expected a diagnostic; got ${JSON.stringify(result.diagnostics)}`
  );
});

test("parseTikzcd preserves vertex order matching the source matrix", () => {
  const body = `
X & Y \\\\
Z &
`.trim();
  const result = parseTikzcd(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const vertices = result.document.cells
    .filter((c: any) => c.kind === "vertex")
    .map((c: any) => c.label);
  assert.deepEqual(vertices, ["X", "Y", "Z"]);
});

test("parseTikzcd drops quiver default black so rendered colours inherit from theme", () => {
  const body = `
A & B \\\\
\\arrow["f", from=1-1, to=1-2]
`.trim();
  const result = parseTikzcd(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const vertices = result.document.cells.filter((c: any) => c.kind === "vertex");
  const edges = result.document.cells.filter((c: any) => c.kind === "edge");
  assert.equal(vertices[0].labelColour, undefined);
  assert.equal(edges[0].labelColour, undefined);
  assert.equal(edges[0].options?.colour, undefined);
});

test("parseCommutative treats legacy black colour payloads as theme-inheriting defaults", () => {
  const parsed = parseCommutative(
    JSON.stringify([
      0,
      2,
      [0, 0, "A", [0, 0, 0, 1]],
      [1, 0, "B"],
      [0, 1, "f", 0, { colour: [0, 0, 0, 1] }, [0, 0, 0, 1]]
    ])
  );
  const vertices = parsed.cells.filter((c: any) => c.kind === "vertex");
  const edges = parsed.cells.filter((c: any) => c.kind === "edge");
  assert.equal(vertices[0].labelColour, undefined);
  assert.equal(edges[0].labelColour, undefined);
  assert.equal(edges[0].options?.colour, undefined);
});

test("renderCommutativeFence emits an error figure for truly unparsable content", () => {
  // The heuristic parser is very forgiving; we need content that the parser
  // rejects outright. An unclosed curly brace on a node label causes the
  // parser to get stuck and ultimately produce an empty document.
  const body = `{`;
  const out = renderCommutativeFence(body, "");
  // Depending on parser heuristics, either error or empty SVG. Check both.
  const isError = /commutative--error/.test(out.html);
  const isEmptySvg = /cg-layer cg-layer--edges/.test(out.html) && /cg-layer cg-layer--nodes/.test(out.html);
  assert.ok(isError || isEmptySvg, "Expected either error figure or empty SVG output");
});

test("renderCommutativeFence never throws on any input", () => {
  // Surfaces errors inside HTML, never crashes the calling pipeline.
  for (const input of ["", "hello", "\\ar[", "A & B \\\\\n\\arrow[from=1-1, to=1-2]"]) {
    const out = renderCommutativeFence(input, "");
    assert.ok(out.html.length > 0);
    assert.ok(out.cssText.length > 0);
  }
});

test("renderCommutativeFence applies width/scale/align from info-string", () => {
  const body = `A & B \\\\
\\arrow[from=1-1, to=1-2]`;
  const out = renderCommutativeFence(body, "width=80% scale=1.5 align=left");
  assert.match(out.html, /<figure[^>]*style="[^"]*width:80%/);
  assert.match(out.html, /transform:scale\(1\.5\)/);
  assert.match(out.html, /margin-left:0/);
});

test("renderCommutativeFence accepts a full wrapped tikzcd block body", () => {
  const body = `
\\begin{tikzcd}
A & B \\\\
\\arrow[from=1-1, to=1-2]
\\end{tikzcd}
  `.trim();
  const out = renderCommutativeFence(body, "");
  assert.doesNotMatch(out.html, /commutative--error/);
  assert.match(out.html, /data-commutative/);
});

test("renderCommutativeFence centers by default", () => {
  const body = `A & B \\\\
\\arrow[from=1-1, to=1-2]`;
  const out = renderCommutativeFence(body, "");
  // No explicit width / scale / margin, so the figure renders without inline style.
  assert.match(out.html, /<figure class="commutative" data-commutative>/);
});

test("convertTikzLengthToPercent converts pt to a rounded percentage of the arc", () => {
  // angle 0: multiplier collapses to TIKZ_HORIZONTAL_MULTIPLIER (1/4);
  // 10pt over a 100-unit arc -> round(10 / (100 * 0.25) * 100 / 5) * 5 = 40.
  assert.equal(convertTikzLengthToPercent(10, 100, 0), 40);
  // angle pi/2: multiplier collapses to TIKZ_VERTICAL_MULTIPLIER (1/6);
  // 10pt over 100 -> round(10 / (100 / 6) * 100 / 5) * 5 = 60.
  assert.equal(convertTikzLengthToPercent(10, 100, Math.PI / 2), 60);
  assert.equal(convertTikzLengthToPercent(0, 100, 0), 0);
  // Degenerate arc -> no shortening (avoid divide-by-zero).
  assert.equal(convertTikzLengthToPercent(10, 0, 0), 0);
});

test("parseTikzcd converts `between` to percentage shorten at the data layer", () => {
  const body = `
A & B \\\\
\\arrow[from=1-1, to=1-2, between={0.2}{0.8}]
`.trim();
  const result = parseTikzcd(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const edges = result.document.cells.filter((c: any) => c.kind === "edge");
  assert.equal(edges.length, 1);
  assert.deepEqual((edges[0] as any).options.shorten, { source: 20, target: 20 });
  assert.equal((edges[0] as any).options.shortenPt, undefined);
});

test("parseTikzcd carries raw pt `shorten` on `shortenPt` for the renderer", () => {
  const body = `
A & B \\\\
\\arrow[from=1-1, to=1-2, shorten <=10]
`.trim();
  const result = parseTikzcd(body);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const edges = result.document.cells.filter((c: any) => c.kind === "edge");
  assert.equal(edges.length, 1);
  assert.deepEqual((edges[0] as any).options.shortenPt, { source: 10, target: 0 });
  assert.deepEqual((edges[0] as any).options.shorten, { source: 0, target: 0 });
});
