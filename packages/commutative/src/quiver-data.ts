/**
 * Pure data types used by the TS port of `apps/admin/public/quiver/parser.mjs`.
 *
 * `parser.mjs` was DOM- and class-aware: it reached into `ui.quiver`, allocated
 * `Edge` and `Vertex` instances bound to the live UI, and produced diagnostics
 * containing `DOM.Code` nodes. None of that is portable to Node or to a
 * markdown-render-time call site, so the TS port works exclusively with the
 * plain records below and the adapter `toCommutativeDocument()` projects them
 * onto the existing `CommutativeDocument`.
 */

import type {
  CommutativeColour,
  CommutativeDocument,
  CommutativeEdgeCell,
  CommutativeEdgeOptions,
  CommutativeVertexCell
} from "./index.js";

export type ParserColour = readonly [number, number, number, number];

export interface ParserPosition {
  x: number;
  y: number;
}

export type ParserEndpoint = ParserPosition | string;

export interface ParserVertex {
  kind: "vertex";
  position: ParserPosition;
  label: string;
  labelColour: ParserColour;
}

/**
 * Mirror of `Edge.default_options(...)` in `apps/admin/public/quiver/ui.mjs`.
 * Plain literal so the parser can operate without pulling the UI runtime in.
 */
export interface ParserEdgeOptions {
  label_alignment: "left" | "right" | "centre" | "over";
  label_position: number;
  offset: number;
  curve: number;
  radius: number;
  angle: number;
  shorten: { source: number; target: number };
  level: number;
  shape: "bezier" | "arc";
  colour: ParserColour;
  edge_alignment: { source: boolean; target: boolean };
  style: {
    name: "arrow" | "adjunction" | "corner" | "corner-inverse";
    tail: { name: string; side?: "top" | "bottom" };
    body: { name: string };
    head: { name: string; side?: "top" | "bottom" };
  };
}

export interface ParserEdge {
  kind: "edge";
  source: ParserEndpoint | null;
  target: ParserEndpoint | null | undefined;
  label: string;
  label_colour: ParserColour;
  options: ParserEdgeOptions;
  shorten: { source: number; target: number };
  between: { source: number | null; target: number | null };
  reverse: boolean;
  loop: boolean;
  loop_tail_angle: number;
  loop_head_angle: number;
  phantom: boolean;
  range: { start: number; length: number };
}

export interface ParseDiagnostic {
  level: "error" | "warning";
  message: string;
  range?: { start: number; length: number };
}

export const PARSER_DEFAULTS = {
  CURVE_HEIGHT: 24,
  MAXIMUM_CELL_LEVEL: 4,
  TIKZ_HORIZONTAL_MULTIPLIER: 1 / 4,
  TIKZ_VERTICAL_MULTIPLIER: 1 / 6
} as const;

export function defaultEdgeOptions(): ParserEdgeOptions {
  return {
    label_alignment: "left",
    label_position: 50,
    offset: 0,
    curve: 0,
    radius: 3,
    angle: 0,
    shorten: { source: 0, target: 0 },
    level: 1,
    shape: "bezier",
    colour: [0, 0, 0, 1],
    edge_alignment: { source: true, target: true },
    style: {
      name: "arrow",
      tail: { name: "none" },
      body: { name: "cell" },
      head: { name: "arrowhead" }
    }
  };
}

/**
 * Convert a tikzcd pt `shorten` value to a 0..100 percentage of the arc, using
 * the multiplier from `QuiverImportExport.tikz_cd` (parser.mjs:245-261). The
 * renderer has the arc length and edge angle at render time; this is the pure
 * conversion those values feed into. Mirrors upstream `convert_length`.
 */
export function convertTikzLengthToPercent(
  length: number,
  arcLength: number,
  angle: number
): number {
  const h = PARSER_DEFAULTS.TIKZ_HORIZONTAL_MULTIPLIER;
  const v = PARSER_DEFAULTS.TIKZ_VERTICAL_MULTIPLIER;
  const denominator = Math.sqrt(h * h * Math.sin(angle) ** 2 + v * v * Math.cos(angle) ** 2);
  const multiplier = denominator === 0 ? 0 : (h * v) / denominator;
  if (multiplier === 0 || arcLength <= 0) {
    return 0;
  }
  const ROUND_TO = 5;
  const pct = Math.round((length / (arcLength * multiplier) * 100) / ROUND_TO) * ROUND_TO;
  return Math.max(0, Math.min(100, pct));
}

function endpointKey(endpoint: ParserEndpoint): string {
  if (typeof endpoint === "string") {
    return endpoint;
  }
  return `${endpoint.x} ${endpoint.y}`;
}

/**
 * Map parser_edge.label_alignment → `CommutativeEdgeCell.alignment`.
 * Matches the values quiver writes when serialising to base64.
 */
function alignmentToCommutative(value: ParserEdgeOptions["label_alignment"]): 0 | 1 | 2 | 3 {
  switch (value) {
    case "left":
      return 0;
    case "centre":
      return 1;
    case "right":
      return 2;
    case "over":
      return 3;
    default:
      return 0;
  }
}

function isDefaultBlack(colour: ParserColour | undefined) {
  if (!colour) {
    return false;
  }
  const [r, g, b, a] = colour;
  return r === 0 && g === 0 && b === 0 && a === 1;
}

function colourToCommutative(colour: ParserColour | undefined): CommutativeColour | undefined {
  if (!colour || isDefaultBlack(colour)) {
    return undefined;
  }
  // `CommutativeColour` is HSL[A]; quiver's parser emits RGB[A] via `Colour.from_rgba`. We
  // convert RGB→HSL here so downstream rendering keeps using the established colour space.
  const [r, g, b, a] = colour;
  return rgbToHsl(r, g, b, a);
}

function rgbToHsl(r: number, g: number, b: number, a: number): CommutativeColour {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = (gn - bn) / d + (gn < bn ? 6 : 0);
        break;
      case gn:
        h = (bn - rn) / d + 2;
        break;
      default:
        h = (rn - gn) / d + 4;
        break;
    }
    h /= 6;
  }
  const H = Math.round(h * 360);
  const S = Math.round(s * 100);
  const L = Math.round(l * 100);
  if (a === 1 || a === undefined) {
    return [H, S, L];
  }
  return [H, S, L, a];
}

/**
 * Convert ParserEdgeOptions into the slim `CommutativeEdgeOptions` shape, with
 * the heuristics the existing index.ts renderer expects.
 */
function buildCommutativeEdgeOptions(
  options: ParserEdgeOptions,
  shortenInput: { source: number; target: number },
  between: { source: number | null; target: number | null }
): CommutativeEdgeOptions {
  // tikzcd offers two ways to shorten an arrow: `between={a}{b}` places the
  // endpoints at fractions a..b of the arc (0..1), and `shorten </>` trims a
  // given number of pt off each end. `between` is pure arithmetic → percentages
  // here; `shorten` is in pt and needs the rendered arc length + edge angle, so
  // the raw pt values ride along on `shortenPt` for the renderer to convert.
  let shorten: { source: number; target: number };
  let shortenPt: { source: number; target: number } | undefined;
  if (between.source !== null && between.target !== null) {
    shorten = {
      source: between.source * 100,
      target: 100 - between.target * 100
    };
    if (shorten.source + shorten.target >= 100) {
      shorten = { source: 0, target: 0 };
    }
    shortenPt = undefined;
  } else {
    shorten = { source: 0, target: 0 };
    shortenPt = { source: shortenInput.source, target: shortenInput.target };
  }

  const out: CommutativeEdgeOptions = {
    angle: options.angle,
    colour: colourToCommutative(options.colour),
    curve: options.curve,
    edge_alignment: { ...options.edge_alignment },
    label_position: options.label_position,
    level: options.level,
    offset: options.offset,
    radius: options.radius,
    shape: options.shape,
    shorten,
    shortenPt,
    style: {
      body: { name: options.style.body.name },
      head: { name: options.style.head.name, side: options.style.head.side },
      name: options.style.name,
      tail: { name: options.style.tail.name, side: options.style.tail.side }
    }
  };
  return out;
}

export interface ToCommutativeInput {
  vertices: Map<string, ParserVertex>;
  edges: ParserEdge[];
}

/**
 * Project the parser's intermediate representation onto the existing
 * `CommutativeDocument`. The cell ordering is: all vertices first (in iteration
 * order, matching how quiver serialises base64), then edges. Endpoint
 * resolution uses the vertex map keyed by `"x y"` and named cells.
 */
export function toCommutativeDocument(input: ToCommutativeInput): CommutativeDocument {
  const vertexCells: CommutativeVertexCell[] = [];
  const indexByKey = new Map<string, number>();
  let index = 0;
  for (const [key, vertex] of input.vertices) {
    indexByKey.set(key, index);
    vertexCells.push({
      kind: "vertex",
      label: vertex.label,
      labelColour: colourToCommutative(vertex.labelColour),
      x: vertex.position.x,
      y: vertex.position.y
    });
    index += 1;
  }

  const edgeCells: CommutativeEdgeCell[] = [];
  for (const edge of input.edges) {
    const sourceKey =
      edge.source !== null && edge.source !== undefined ? endpointKey(edge.source) : null;
    const targetKey =
      edge.target !== null && edge.target !== undefined ? endpointKey(edge.target) : null;
    if (sourceKey === null || targetKey === null) {
      continue;
    }
    if (!indexByKey.has(sourceKey)) {
      // Implicit empty-label vertex (parser.mjs:168-170 behaviour).
      indexByKey.set(sourceKey, vertexCells.length);
      const pos = parseCoordinateKey(sourceKey, edge);
      vertexCells.push({
        kind: "vertex",
        label: "",
        labelColour: undefined,
        x: pos.x,
        y: pos.y
      });
    }
    if (!indexByKey.has(targetKey)) {
      indexByKey.set(targetKey, vertexCells.length);
      const pos = parseCoordinateKey(targetKey, edge);
      vertexCells.push({
        kind: "vertex",
        label: "",
        labelColour: undefined,
        x: pos.x,
        y: pos.y
      });
    }
    const sourceIdx = indexByKey.get(sourceKey)!;
    const targetIdx = indexByKey.get(targetKey)!;
    const realSource = edge.reverse ? targetIdx : sourceIdx;
    const realTarget = edge.reverse ? sourceIdx : targetIdx;
    edgeCells.push({
      alignment: alignmentToCommutative(edge.options.label_alignment),
      kind: "edge",
      label: edge.label,
      labelColour: colourToCommutative(edge.label_colour),
      options: buildCommutativeEdgeOptions(edge.options, edge.shorten, edge.between),
      source: realSource,
      target: realTarget
    });
  }

  return {
    cells: [...vertexCells, ...edgeCells],
    version: 1
  };
}

function parseCoordinateKey(key: string, edge: ParserEdge): ParserPosition {
  const match = key.match(/^(-?\d+) (-?\d+)$/);
  if (match) {
    return { x: Number(match[1]), y: Number(match[2]) };
  }
  // Named vertex without explicit coords — fall back to the edge's source position.
  if (edge.source && typeof edge.source !== "string") {
    return { x: edge.source.x, y: edge.source.y };
  }
  return { x: 0, y: 0 };
}

export { endpointKey as _endpointKeyForTests };
