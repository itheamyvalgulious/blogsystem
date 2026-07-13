import * as katex from "katex";
import {
  Dimensions,
  Point,
  QUIVER_CONSTANTS,
  QuiverArrowGeometry,
  QuiverLabel,
  QuiverShape,
  createQuiverArrowStyleFromOptions
} from "./quiver-geometry.js";
import { parseFenceParams } from "./fence-params.js";
import { parseTikzcd } from "./tikzcd-parser.js";
import { convertTikzLengthToPercent } from "./quiver-data.js";

export type { CommutativeFenceParams } from "./fence-params.js";
export { parseFenceParams } from "./fence-params.js";
export type {
  ParseDiagnostic,
  TikzcdParseResult
} from "./tikzcd-parser.js";
export { parseTikzcd } from "./tikzcd-parser.js";
export {
  convertTikzLengthToPercent,
  defaultEdgeOptions,
  toCommutativeDocument
} from "./quiver-data.js";
export type {
  ParserColour,
  ParserEdge,
  ParserEdgeOptions,
  ParserPosition,
  ParserVertex
} from "./quiver-data.js";

export const COMMUTATIVE_FENCE_LANGUAGE = "commutative";
export const COMMUTATIVE_VERSION = 1;

export type CommutativeColour = [number, number, number] | [number, number, number, number];

export interface CommutativeVertexCell {
  kind: "vertex";
  label: string;
  labelColour?: CommutativeColour;
  x: number;
  y: number;
}

export interface CommutativeStyleTail {
  name?: string;
  side?: "top" | "bottom";
}

export interface CommutativeStyleBody {
  name?: string;
}

export interface CommutativeStyleHead {
  name?: string;
  side?: "top" | "bottom";
}

export interface CommutativeEdgeStyle {
  body?: CommutativeStyleBody;
  head?: CommutativeStyleHead;
  name?: "adjunction" | "arrow" | "corner" | "corner-inverse";
  tail?: CommutativeStyleTail;
}

export interface CommutativeShorten {
  source?: number;
  target?: number;
}

export interface CommutativeEdgeAlignment {
  source?: boolean;
  target?: boolean;
}

export interface CommutativeEdgeOptions {
  angle?: number;
  colour?: CommutativeColour;
  curve?: number;
  edge_alignment?: CommutativeEdgeAlignment;
  label_position?: number;
  level?: number;
  offset?: number;
  radius?: number;
  shape?: "arc" | "bezier";
  shorten?: CommutativeShorten;
  /**
   * tikzcd `shorten </>` is given in pt and needs the rendered arc length +
   * edge angle to convert to a percentage, so the raw pt values are carried
   * here for the renderer to convert. Absent on base64/quiver documents,
   * where `shorten` already holds a 0..100 percentage.
   */
  shortenPt?: { source: number; target: number };
  style?: CommutativeEdgeStyle;
}

export interface CommutativeEdgeCell {
  alignment?: 0 | 1 | 2 | 3;
  kind: "edge";
  label: string;
  labelColour?: CommutativeColour;
  options?: CommutativeEdgeOptions;
  source: number;
  target: number;
}

export type CommutativeCell = CommutativeVertexCell | CommutativeEdgeCell;

export interface CommutativeDocument {
  cells: CommutativeCell[];
  version: number;
}

export interface CommutativeRenderOptions {
  className?: string;
  fitToWidth?: boolean;
  /** CSS width applied to the wrapping figure (e.g. '100%', '480px', 'auto'). */
  width?: string;
  /** Multiplicative scale applied via CSS transform; 1 means no scaling. */
  scale?: number;
  /** Horizontal alignment of the figure within its container. */
  align?: "left" | "center" | "right";
}

export interface CommutativeRenderResult {
  height: number;
  html: string;
  width: number;
}

export interface CommutativeParseError {
  code:
    | "invalid-json"
    | "invalid-root"
    | "invalid-version"
    | "invalid-vertex"
    | "invalid-edge";
  message: string;
}

export class CommutativeError extends Error {
  readonly code: CommutativeParseError["code"];

  constructor(code: CommutativeParseError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

interface RenderNode {
  centreX: number;
  centreY: number;
  colour?: CommutativeColour;
  height: number;
  html: string;
  id: number;
  isPoint: boolean;
  radius: number;
  width: number;
}

type Base64RawCell = unknown[];
type Base64RawDocument = [number, number, ...Base64RawCell[]];

const GRID_X = 128;
const GRID_Y = 128;
const PADDING_X = 48;
const PADDING_Y = 44;
const NODE_MIN_WIDTH = GRID_X / 2;
const NODE_MIN_HEIGHT = GRID_Y / 2;
const NODE_RADIUS = GRID_X / 8;
const CONTENT_PADDING = QUIVER_CONSTANTS.CONTENT_PADDING;
const EDGE_LABEL_GAP = 18;
const STROKE = QUIVER_CONSTANTS.STROKE_WIDTH;
const FONT_SIZE = 18;
const LABEL_FONT_SIZE = 16;
const LABEL_BOX_HEIGHT = 42;
const LABEL_BOX_WIDTH = 220;
const POINT_NODE_RADIUS = 4.75;
const DEFAULT_LABEL_ALIGNMENT: NonNullable<CommutativeEdgeCell["alignment"]> = 0;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function normalizeColour(value: unknown): CommutativeColour | undefined {
  if (!Array.isArray(value) || value.length < 3 || value.length > 4) {
    return undefined;
  }

  const numbers = value.map((item) => Number(item));
  if (!numbers.every((item) => Number.isFinite(item))) {
    return undefined;
  }

  const [h, s, l, a] = numbers;
  if (h < 0 || h > 360 || s < 0 || s > 100 || l < 0 || l > 100) {
    return undefined;
  }

  if (numbers.length === 4) {
    if (a < 0 || a > 1) {
      return undefined;
    }
    return [h, s, l, a];
  }

  return [h, s, l];
}

function isDefaultBlackColour(colour: CommutativeColour | undefined) {
  if (!colour) {
    return false;
  }
  const [h, s, l, a] = colour;
  return h === 0 && s === 0 && l === 0 && (a === undefined || a === 1);
}

function normalizeThemeAwareColour(value: unknown) {
  const colour = normalizeColour(value);
  return isDefaultBlackColour(colour) ? undefined : colour;
}

function colourToCss(colour: CommutativeColour | undefined, fallback = "currentColor") {
  if (!colour) {
    return fallback;
  }

  const [h, s, l, a] = colour;
  if (typeof a === "number") {
    return `hsla(${h}, ${s}%, ${l}%, ${a})`;
  }

  return `hsl(${h}, ${s}%, ${l}%)`;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function assertObject(value: unknown, message: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CommutativeError("invalid-root", message);
  }
}

function assertBase64Document(value: unknown): asserts value is Base64RawDocument {
  if (!Array.isArray(value) || value.length < 2) {
    throw new CommutativeError("invalid-root", "Commutative JSON must be an array document.");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneValue(item)])
    ) as T;
  }
  return value;
}

function deepAssignRecord(target: Record<string, unknown>, source: Record<string, unknown> | undefined) {
  if (!source) {
    return;
  }

  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value)) {
      const current = isPlainObject(target[key]) ? (target[key] as Record<string, unknown>) : {};
      target[key] = current;
      deepAssignRecord(current, value);
    } else {
      target[key] = cloneValue(value);
    }
  }
}

function deepEqualValue(left: unknown, right: unknown): boolean {
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqualValue(item, right[index]));
  }
  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqualValue(left[key], right[key]))
    );
  }
  return left === right;
}

function createDefaultEdgeOptions(level: number) {
  return {
    angle: 0,
    colour: [0, 0, 0, 1] as CommutativeColour,
    curve: 0,
    edge_alignment: { source: true, target: true },
    label_position: 50,
    level,
    offset: 0,
    radius: 3,
    shape: "bezier",
    shorten: { source: 0, target: 0 },
    style: {
      body: { name: "cell" },
      head: { name: "arrowhead" },
      name: "arrow",
      tail: { name: "none" }
    }
  };
}

function computeRecordDelta(value: Record<string, unknown>, defaults: Record<string, unknown>) {
  const delta: Record<string, unknown> = {};

  for (const [key, current] of Object.entries(value)) {
    const defaultValue = defaults[key];
    if (isPlainObject(current) && isPlainObject(defaultValue)) {
      const nested = computeRecordDelta(current, defaultValue);
      if (Object.keys(nested).length > 0) {
        delta[key] = nested;
      }
      continue;
    }

    if (!deepEqualValue(current, defaultValue)) {
      delta[key] = cloneValue(current);
    }
  }

  return delta;
}

function computeQuiverEdgeOptionsDelta(edge: CommutativeEdgeCell) {
  const level = Math.max(1, Math.trunc(edge.options?.level ?? 1));
  const defaults = createDefaultEdgeOptions(level);
  const effective = cloneValue(defaults) as Record<string, unknown>;
  deepAssignRecord(effective, (edge.options ?? {}) as Record<string, unknown>);
  const delta = computeRecordDelta(effective, defaults as Record<string, unknown>);

  delete delta.shape;
  switch (effective.shape) {
    case "bezier":
      delete delta.radius;
      delete delta.angle;
      break;
    case "arc":
      delete delta.curve;
      break;
    default:
      break;
  }

  return delta;
}

function parseVertex(raw: unknown[]): CommutativeVertexCell {
  if (raw.length < 2 || raw.length > 4) {
    throw new CommutativeError("invalid-vertex", "Commutative vertex has an invalid shape.");
  }

  const [x, y, label = "", labelColour] = raw;
  if (!isInteger(x) || !isInteger(y)) {
    throw new CommutativeError("invalid-vertex", "Commutative vertex coordinates must be integers.");
  }
  if (typeof label !== "string") {
    throw new CommutativeError("invalid-vertex", "Commutative vertex label must be a string.");
  }

  const colour = normalizeThemeAwareColour(labelColour);
  if (labelColour !== undefined && !colour) {
    const normalized = normalizeColour(labelColour);
    if (!normalized) {
      throw new CommutativeError("invalid-vertex", "Commutative vertex label colour is invalid.");
    }
  }

  return {
    kind: "vertex",
    label,
    labelColour: colour,
    x,
    y
  };
}

function parseEdge(raw: unknown[]): CommutativeEdgeCell {
  if (raw.length < 2 || raw.length > 6) {
    throw new CommutativeError("invalid-edge", "Commutative edge has an invalid shape.");
  }

  const [source, target, label = "", alignment = DEFAULT_LABEL_ALIGNMENT, options = {}, labelColour] = raw;
  if (!isInteger(source) || source < 0 || !isInteger(target) || target < 0) {
    throw new CommutativeError("invalid-edge", "Commutative edge indices must be non-negative integers.");
  }
  if (typeof label !== "string") {
    throw new CommutativeError("invalid-edge", "Commutative edge label must be a string.");
  }
  if (![0, 1, 2, 3].includes(Number(alignment))) {
    throw new CommutativeError("invalid-edge", "Commutative edge alignment is invalid.");
  }
  assertObject(options, "Commutative edge options must be an object.");

  const normalizedOptions: CommutativeEdgeOptions = {};
  if (options.shape === "arc" || options.shape === "bezier") {
    normalizedOptions.shape = options.shape;
  }
  for (const key of ["angle", "curve", "label_position", "level", "offset", "radius"] as const) {
    const value = options[key];
    if (value !== undefined) {
      if (!isFiniteNumber(value)) {
        throw new CommutativeError("invalid-edge", `Commutative edge option "${key}" must be numeric.`);
      }
      normalizedOptions[key] = value;
    }
  }
  if (options.shorten !== undefined) {
    assertObject(options.shorten, "Commutative edge shorten must be an object.");
    normalizedOptions.shorten = {};
    for (const key of ["source", "target"] as const) {
      const value = options.shorten[key];
      if (value !== undefined) {
        if (!isFiniteNumber(value)) {
          throw new CommutativeError("invalid-edge", `Commutative edge shorten "${key}" must be numeric.`);
        }
        normalizedOptions.shorten[key] = value;
      }
    }
  }
  if (options.edge_alignment !== undefined) {
    assertObject(options.edge_alignment, "Commutative edge alignment options must be an object.");
    normalizedOptions.edge_alignment = {};
    for (const key of ["source", "target"] as const) {
      const value = options.edge_alignment[key];
      if (value !== undefined) {
        if (typeof value !== "boolean") {
          throw new CommutativeError("invalid-edge", `Commutative edge alignment "${key}" must be boolean.`);
        }
        normalizedOptions.edge_alignment[key] = value;
      }
    }
  }
  if (options.style !== undefined) {
    assertObject(options.style, "Commutative edge style must be an object.");
    normalizedOptions.style = {};
    if (
      options.style.name !== undefined &&
      options.style.name !== "adjunction" &&
      options.style.name !== "arrow" &&
      options.style.name !== "corner" &&
      options.style.name !== "corner-inverse"
    ) {
      throw new CommutativeError("invalid-edge", "Commutative edge style name is invalid.");
    }
    if (typeof options.style.name === "string") {
      normalizedOptions.style.name = options.style.name as CommutativeEdgeStyle["name"];
    }
    for (const part of ["body", "head", "tail"] as const) {
      if (options.style[part] !== undefined) {
        assertObject(options.style[part], `Commutative edge style "${part}" must be an object.`);
        normalizedOptions.style[part] = {};
        if (typeof options.style[part].name === "string") {
          normalizedOptions.style[part].name = options.style[part].name;
        }
        if (
          part !== "body" &&
          (options.style[part].side === "top" || options.style[part].side === "bottom")
        ) {
          normalizedOptions.style[part].side = options.style[part].side;
        }
      }
    }
  }

  const colour = normalizeThemeAwareColour(options.colour);
  if (options.colour !== undefined && !colour) {
    const normalizedColour = normalizeColour(options.colour);
    if (!normalizedColour) {
      throw new CommutativeError("invalid-edge", "Commutative edge colour is invalid.");
    }
  }
  if (colour) {
    normalizedOptions.colour = colour;
  }

  const normalizedLabelColour = normalizeThemeAwareColour(labelColour);
  if (labelColour !== undefined && !normalizedLabelColour) {
    const normalizedColour = normalizeColour(labelColour);
    if (!normalizedColour) {
      throw new CommutativeError("invalid-edge", "Commutative edge label colour is invalid.");
    }
  }

  return {
    alignment: alignment as 0 | 1 | 2 | 3,
    kind: "edge",
    label,
    labelColour: normalizedLabelColour,
    options: normalizedOptions,
    source,
    target
  };
}

export function createEmptyCommutativeDocument(): CommutativeDocument {
  return {
    cells: [],
    version: COMMUTATIVE_VERSION
  };
}

export function commutativeDocumentFromBase64Raw(value: unknown): CommutativeDocument {
  assertBase64Document(value);
  const [version, vertexCount, ...cells] = value;
  if (!isInteger(version) || version !== 0) {
    throw new CommutativeError("invalid-version", `Unsupported commutative source version "${String(version)}".`);
  }
  if (!isInteger(vertexCount) || vertexCount < 0 || vertexCount > cells.length) {
    throw new CommutativeError("invalid-root", "Commutative vertex count is invalid.");
  }

  const normalizedCells: CommutativeCell[] = [];
  for (let index = 0; index < cells.length; index += 1) {
    const rawCell = cells[index];
    if (!Array.isArray(rawCell)) {
      throw new CommutativeError("invalid-root", "Commutative cell entries must be arrays.");
    }
    normalizedCells.push(index < vertexCount ? parseVertex(rawCell) : parseEdge(rawCell));
  }

  return {
    cells: normalizedCells,
    version: COMMUTATIVE_VERSION
  };
}

export function commutativeDocumentToBase64Raw(document: CommutativeDocument): Base64RawDocument {
  const vertices = document.cells.filter((cell): cell is CommutativeVertexCell => cell.kind === "vertex");
  const edges = document.cells.filter((cell): cell is CommutativeEdgeCell => cell.kind === "edge");
  const cells: Base64RawCell[] = [];

  for (const vertex of vertices) {
    const raw: Base64RawCell = [vertex.x, vertex.y];
    if (vertex.label) {
      raw.push(vertex.label);
    }
    if (vertex.label && vertex.labelColour) {
      raw.push(vertex.labelColour);
    }
    cells.push(raw);
  }

  for (const edge of edges) {
    const raw: Base64RawCell = [edge.source, edge.target];
    const end: Base64RawCell = [];
    const optionsDelta = computeQuiverEdgeOptionsDelta(edge);

    if (edge.label && edge.labelColour) {
      end.push(edge.labelColour);
    }

    if (Object.keys(optionsDelta).length > 0) {
      end.push(optionsDelta);
    }

    const alignment = edge.alignment ?? DEFAULT_LABEL_ALIGNMENT;
    if (end.length > 0 || (alignment !== DEFAULT_LABEL_ALIGNMENT && edge.label !== "")) {
      end.push(alignment);
    }

    if (end.length > 0 || edge.label !== "") {
      end.push(edge.label);
    }

    raw.push(...end.reverse());
    cells.push(raw);
  }

  return [0, vertices.length, ...cells];
}

export function parseCommutative(raw: string): CommutativeDocument {
  const trimmedRaw = raw.trim();
  if (!trimmedRaw) {
    throw new CommutativeError("invalid-json", "Empty commutative source.");
  }

  if (!trimmedRaw.startsWith("{") && !trimmedRaw.startsWith("[")) {
    return decodeCommutativeBase64(trimmedRaw);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmedRaw);
  } catch (error) {
    throw new CommutativeError("invalid-json", (error as Error).message);
  }

  if (Array.isArray(parsed)) {
    return commutativeDocumentFromBase64Raw(parsed);
  }

  assertObject(parsed, "Commutative JSON root must be an object or an array.");
  if (!Array.isArray(parsed.cells)) {
    throw new CommutativeError("invalid-root", "Commutative object must contain a cells array.");
  }
  const version = Number(parsed.version ?? COMMUTATIVE_VERSION);
  if (!Number.isFinite(version) || version !== COMMUTATIVE_VERSION) {
    throw new CommutativeError("invalid-version", `Unsupported commutative document version "${String(parsed.version)}".`);
  }

  const cells = parsed.cells.map((cell) => {
    assertObject(cell, "Commutative cells must be objects.");
    if (cell.kind === "vertex") {
      if (!isFiniteNumber(cell.x) || !isFiniteNumber(cell.y) || typeof cell.label !== "string") {
        throw new CommutativeError("invalid-vertex", "Commutative vertex is invalid.");
      }
      const labelColour = normalizeThemeAwareColour(cell.labelColour);
      return {
        kind: "vertex" as const,
        label: cell.label,
        labelColour,
        x: cell.x,
        y: cell.y
      };
    }
    if (cell.kind === "edge") {
      return parseEdge([
        cell.source,
        cell.target,
        cell.label ?? "",
        cell.alignment ?? DEFAULT_LABEL_ALIGNMENT,
        cell.options ?? {},
        cell.labelColour
      ]);
    }
    throw new CommutativeError("invalid-root", "Commutative cell kind is invalid.");
  });

  return {
    cells,
    version: COMMUTATIVE_VERSION
  };
}

export function serializeCommutative(document: CommutativeDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function encodeBase64Utf8(value: string) {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(value);

  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64Utf8(value: string) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(value, "base64").toString("utf8");
  }

  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

export function encodeCommutativeBase64(document: CommutativeDocument): string {
  const raw = JSON.stringify(commutativeDocumentToBase64Raw(document));
  return encodeBase64Utf8(raw);
}

export function decodeCommutativeBase64(value: string): CommutativeDocument {
  try {
    return commutativeDocumentFromBase64Raw(JSON.parse(decodeBase64Utf8(value)));
  } catch {
    throw new CommutativeError("invalid-json", "Invalid commutative base64 payload.");
  }
}

function renderMath(label: string) {
  try {
    return katex.renderToString(label || "\\,", {
      displayMode: false,
      output: "html",
      strict: "ignore",
      throwOnError: false
    });
  } catch {
    return `<span class="cg-label-text">${escapeHtml(label)}</span>`;
  }
}

function normalizeMathToken(label: string) {
  return label.replace(/\s+/g, "");
}

function isPointNodeLabel(label: string) {
  const normalized = normalizeMathToken(label);
  return normalized === "\\bullet" || normalized === "\\bull" || normalized === "bullet" || normalized === "•";
}

function estimateTextLength(label: string) {
  return label
    .replace(/\\[A-Za-z]+/g, "x")
    .replace(/[{}[\]^_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function measureLabel(label: string) {
  if (isPointNodeLabel(label)) {
    const diameter = POINT_NODE_RADIUS * 2;
    return { height: diameter, radius: POINT_NODE_RADIUS, width: diameter };
  }

  const stripped = estimateTextLength(label);
  const lines = Math.max(1, label.split("\\\\").length);
  const width = Math.max(
    NODE_MIN_WIDTH,
    stripped.length * FONT_SIZE * 0.58 + CONTENT_PADDING * 2
  );
  const height = Math.max(
    NODE_MIN_HEIGHT,
    lines * (FONT_SIZE + 4) + CONTENT_PADDING * 2
  );
  return { height, radius: NODE_RADIUS, width };
}

function vertexBounds(node: RenderNode) {
  return {
    bottom: node.centreY + node.height / 2,
    left: node.centreX - node.width / 2,
    right: node.centreX + node.width / 2,
    top: node.centreY - node.height / 2
  };
}

function vertexCenter(node: RenderNode) {
  return {
    x: node.centreX,
    y: node.centreY
  };
}

function normalizeVector(dx: number, dy: number) {
  const length = Math.hypot(dx, dy) || 1;
  return {
    length,
    ux: dx / length,
    uy: dy / length
  };
}

function intersectRectBoundary(node: RenderNode, towardsX: number, towardsY: number) {
  const center = vertexCenter(node);
  const dx = towardsX - center.x;
  const dy = towardsY - center.y;
  if (node.isPoint) {
    const { ux, uy } = normalizeVector(dx, dy);
    return {
      x: center.x + ux * node.radius,
      y: center.y + uy * node.radius
    };
  }
  const { ux, uy } = normalizeVector(dx, dy);
  const halfWidth = node.width / 2;
  const halfHeight = node.height / 2;
  const scaleX = Math.abs(ux) < 1e-6 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(ux);
  const scaleY = Math.abs(uy) < 1e-6 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(uy);
  const distance = Math.min(scaleX, scaleY);

  return {
    x: center.x + ux * distance,
    y: center.y + uy * distance
  };
}

function bezierControlPoints(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  options: CommutativeEdgeOptions | undefined
) {
  const dx = endX - startX;
  const dy = endY - startY;
  const { length } = normalizeVector(dx, dy);
  const normalX = length > 0 ? -dy / length : 0;
  const normalY = length > 0 ? dx / length : 0;
  const curve = (options?.curve ?? 0) * 18;
  const offset = (options?.offset ?? 0) * 8;
  const displacement = curve + offset;

  return {
    c1x: startX + dx / 3 + normalX * displacement,
    c1y: startY + dy / 3 + normalY * displacement,
    c2x: startX + (dx * 2) / 3 + normalX * displacement,
    c2y: startY + (dy * 2) / 3 + normalY * displacement,
    normalX,
    normalY
  };
}

function bezierPoint(
  startX: number,
  startY: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  endX: number,
  endY: number,
  t: number
) {
  const mt = 1 - t;
  return {
    x:
      mt * mt * mt * startX +
      3 * mt * mt * t * c1x +
      3 * mt * t * t * c2x +
      t * t * t * endX,
    y:
      mt * mt * mt * startY +
      3 * mt * mt * t * c1y +
      3 * mt * t * t * c2y +
      t * t * t * endY
  };
}

function bezierTangent(
  startX: number,
  startY: number,
  c1x: number,
  c1y: number,
  c2x: number,
  c2y: number,
  endX: number,
  endY: number,
  t: number
) {
  const mt = 1 - t;
  return {
    x:
      3 * mt * mt * (c1x - startX) +
      6 * mt * t * (c2x - c1x) +
      3 * t * t * (endX - c2x),
    y:
      3 * mt * mt * (c1y - startY) +
      6 * mt * t * (c2y - c1y) +
      3 * t * t * (endY - c2y)
  };
}

function adjustPoint(point: { x: number; y: number }, tangent: { x: number; y: number }, amount: number) {
  const { ux, uy } = normalizeVector(tangent.x, tangent.y);
  return {
    x: point.x + ux * amount,
    y: point.y + uy * amount
  };
}

function loopGeometry(node: RenderNode, options: CommutativeEdgeOptions | undefined) {
  const radius = Math.max(28, Math.abs(options?.radius ?? 3) * 12);
  const angleDeg = options?.angle ?? -90;
  const center = vertexCenter(node);
  const angleRad = (angleDeg * Math.PI) / 180;
  const loopCenter = {
    x: center.x + Math.cos(angleRad) * radius * 1.4,
    y: center.y + Math.sin(angleRad) * radius * 1.4
  };
  const startAngle = angleRad + Math.PI * 0.85;
  const endAngle = angleRad - Math.PI * 0.85;
  const start = {
    x: loopCenter.x + Math.cos(startAngle) * radius,
    y: loopCenter.y + Math.sin(startAngle) * radius
  };
  const end = {
    x: loopCenter.x + Math.cos(endAngle) * radius,
    y: loopCenter.y + Math.sin(endAngle) * radius
  };
  const labelPoint = {
    x: loopCenter.x + Math.cos(angleRad) * (radius + 22),
    y: loopCenter.y + Math.sin(angleRad) * (radius + 22)
  };

  return {
    end,
    labelPoint,
    path: `M ${start.x} ${start.y} A ${radius} ${radius} 0 1 1 ${end.x} ${end.y}`,
    start
  };
}

function renderLabel(
  point: { x: number; y: number },
  label: string,
  colour: string,
  className = "cg-edge-label"
) {
  if (!label) {
    return "";
  }

  return `<foreignObject x="${point.x - LABEL_BOX_WIDTH / 2}" y="${point.y - LABEL_BOX_HEIGHT / 2}" width="${LABEL_BOX_WIDTH}" height="${LABEL_BOX_HEIGHT}">
  <div xmlns="http://www.w3.org/1999/xhtml" class="${className}" style="background:transparent;color:${colour}">${renderMath(label)}</div>
</foreignObject>`;
}

function labelPosition(
  startX: number,
  startY: number,
  endX: number,
  endY: number,
  alignment: NonNullable<CommutativeEdgeCell["alignment"]>,
  normalX: number,
  normalY: number
) {
  const midX = (startX + endX) / 2;
  const midY = (startY + endY) / 2;

  switch (alignment) {
    case 0:
      return { x: midX - normalX * EDGE_LABEL_GAP, y: midY - normalY * EDGE_LABEL_GAP };
    case 2:
      return { x: midX + normalX * EDGE_LABEL_GAP, y: midY + normalY * EDGE_LABEL_GAP };
    case 3:
      return { x: midX, y: midY };
    default:
      return { x: midX, y: midY - EDGE_LABEL_GAP };
  }
}

function renderBodyDecorations(
  bodyName: string | undefined,
  point: { x: number; y: number },
  tangent: { x: number; y: number },
  colour: string,
  level = 1
) {
  const normalizedLevel = Math.max(1, Math.trunc(level));
  const edgeWidth =
    normalizedLevel * QUIVER_CONSTANTS.STROKE_WIDTH +
    (normalizedLevel - 1) * QUIVER_CONSTANTS.LINE_SPACING;
  const headHeight =
    edgeWidth + (QUIVER_CONSTANTS.LINE_SPACING + QUIVER_CONSTANTS.STROKE_WIDTH) * 2;
  const { ux, uy } = normalizeVector(tangent.x, tangent.y);
  const normalX = -uy;
  const normalY = ux;

  switch (bodyName) {
    case "barred": {
      const p1 = { x: point.x - normalX * 8, y: point.y - normalY * 8 };
      const p2 = { x: point.x + normalX * 8, y: point.y + normalY * 8 };
      return `<path class="cg-edge-decoration cg-edge-decoration--barred" d="M ${p1.x} ${p1.y} L ${p2.x} ${p2.y}" stroke="${colour}" stroke-width="${STROKE}" />`;
    }
    case "double barred": {
      const offset = { x: ux * 4, y: uy * 4 };
      const leftA = { x: point.x - offset.x - normalX * 8, y: point.y - offset.y - normalY * 8 };
      const leftB = { x: point.x - offset.x + normalX * 8, y: point.y - offset.y + normalY * 8 };
      const rightA = { x: point.x + offset.x - normalX * 8, y: point.y + offset.y - normalY * 8 };
      const rightB = { x: point.x + offset.x + normalX * 8, y: point.y + offset.y + normalY * 8 };
      return `<path class="cg-edge-decoration cg-edge-decoration--double-barred" d="M ${leftA.x} ${leftA.y} L ${leftB.x} ${leftB.y} M ${rightA.x} ${rightA.y} L ${rightB.x} ${rightB.y}" stroke="${colour}" stroke-width="${STROKE}" />`;
    }
    case "bullet solid":
      return `<circle class="cg-edge-decoration cg-edge-decoration--bullet-solid" cx="${point.x}" cy="${point.y}" r="${headHeight / 2}" fill="${colour}" />`;
    case "bullet hollow":
      return `<circle class="cg-edge-decoration cg-edge-decoration--bullet-hollow" cx="${point.x}" cy="${point.y}" r="${headHeight / 2}" fill="none" stroke="${colour}" stroke-width="${STROKE}" />`;
    default:
      return "";
  }
}

function createNodeShape(node: RenderNode) {
  const origin = new Point(node.centreX, node.centreY);
  if (node.isPoint) {
    return new QuiverShape.Endpoint(origin);
  }

  return new QuiverShape.RoundedRect(origin, new Dimensions(node.width, node.height), node.radius);
}

function transformPointWithMatrix(
  point: { x: number; y: number },
  matrix: { a: number; b: number; c: number; d: number; e: number; f: number }
) {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f
  };
}

function createSvgMatrix(
  sourceOrigin: Point,
  offset: Point,
  angle: number,
  shift: Point
) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rotatedOffset = {
    x: cos * offset.x - sin * offset.y,
    y: sin * offset.x + cos * offset.y
  };

  return {
    a: cos,
    b: sin,
    c: -sin,
    d: cos,
    e: sourceOrigin.x + shift.x - rotatedOffset.x,
    f: sourceOrigin.y + shift.y - rotatedOffset.y
  };
}

function labelPointForAlignment(
  point: { x: number; y: number },
  tangentAngle: number,
  alignment: NonNullable<CommutativeEdgeCell["alignment"]>
) {
  if (alignment === 1 || alignment === 3) {
    return point;
  }

  const normal = {
    x: -Math.sin(tangentAngle),
    y: Math.cos(tangentAngle)
  };
  const direction = alignment === 2 ? 1 : -1;
  return {
    x: point.x + normal.x * EDGE_LABEL_GAP * direction,
    y: point.y + normal.y * EDGE_LABEL_GAP * direction
  };
}

function resolveEdgeShortenPercent(
  options: CommutativeEdgeOptions | undefined,
  angle: number,
  arcLength: number
): { source: number; target: number } {
  const rawShorten = options?.shortenPt;
  if (rawShorten && arcLength > 0 && Number.isFinite(angle)) {
    // tikzcd `shorten </>` is in pt; convert to a 0..100 percentage of the arc
    // using the same multiplier quiver applies in QuiverImportExport.tikz_cd.
    const convert = (length: number) => convertTikzLengthToPercent(length, arcLength, angle);
    let source = convert(rawShorten.source);
    let target = convert(rawShorten.target);
    if (source + target >= 100) {
      // Upstream resets both when they would consume the whole arc.
      source = 0;
      target = 0;
    }
    return { source, target };
  }
  // Base64/quiver path (or a degenerate arc): `shorten` already holds a 0..100
  // percentage. Use it directly so that path is unchanged.
  return {
    source: options?.shorten?.source ?? 0,
    target: options?.shorten?.target ?? 0
  };
}

function renderQuiverArrowEdge(
  edge: CommutativeEdgeCell,
  source: RenderNode,
  target: RenderNode,
  colour: string,
  labelColour: string
) {
  const sourceShape = createNodeShape(source);
  const targetShape = createNodeShape(target);
  const edgeOptions = {
    ...edge.options,
    colour,
    shape: source.id === target.id ? "arc" : edge.options?.shape ?? "bezier"
  };
  const style = createQuiverArrowStyleFromOptions(edgeOptions);
  const geometry = new QuiverArrowGeometry(sourceShape, targetShape, style, new QuiverLabel());

  let start;
  let end;
  try {
    [start, end] = geometry.find_endpoints();
  } catch {
    return "";
  }

  const sourceOrigin = geometry.origin().source;
  const angle = geometry.angle();
  const localCurve = geometry.curve(new Point(0, 0), 0);
  const t_after_length = localCurve.t_after_length(true);
  const stroke_width =
    style.level * QUIVER_CONSTANTS.STROKE_WIDTH +
    (style.level - 1) * QUIVER_CONSTANTS.LINE_SPACING;
  const edge_width =
    style.body_style === QUIVER_CONSTANTS.ARROW_BODY_STYLE.SQUIGGLY
      ? style.level * QUIVER_CONSTANTS.SQUIGGLY_TRIANGLE_HEIGHT * 2 +
        QUIVER_CONSTANTS.STROKE_WIDTH +
        (style.level - 1) * QUIVER_CONSTANTS.LINE_SPACING
      : stroke_width;
  const head_width =
    QUIVER_CONSTANTS.LINE_SPACING + QUIVER_CONSTANTS.STROKE_WIDTH + (style.level - 1) * 2;
  const head_height = edge_width + (QUIVER_CONSTANTS.LINE_SPACING + QUIVER_CONSTANTS.STROKE_WIDTH) * 2;
  const padding =
    QUIVER_CONSTANTS.BACKGROUND_PADDING +
    Math.max(head_height, QUIVER_CONSTANTS.STROKE_WIDTH) / 2;
  const length = geometry.length();
  const width = localCurve.width;
  const height = 2 * Math.abs(localCurve.height);
  const offset = new Point(padding + (width - length) / 2, padding + height / 2);
  const shift = new Point(0, style.shift).rotate(angle);
  const firstHead = (style.heads as readonly string[]).at(0);
  const firstTail = (style.tails as readonly string[]).at(0);
  const shorten = {
    end: typeof firstHead === "string" && firstHead.startsWith("hook") ? head_width : 0,
    start: typeof firstTail === "string" && firstTail.startsWith("hook") ? head_width : 0
  };

  const visibleArcLength = localCurve.arc_length(end.t) - localCurve.arc_length(start.t);
  const shortenPercent = resolveEdgeShortenPercent(edge.options, angle, visibleArcLength);
  style.shorten = {
    head: (visibleArcLength * shortenPercent.target) / 100,
    tail: (visibleArcLength * shortenPercent.source) / 100
  };

  const adjust_dash_padding = (
    heads: readonly string[],
    endpoint: { t: number },
    is_start: boolean
  ) => {
    if (heads.length > 0 && heads[0] === "mono") {
      const head_angle = localCurve.tangent(
        t_after_length(localCurve.arc_length(endpoint.t) + head_width * (is_start ? 1 : -1))
      );
      const endpoint_angle = localCurve.tangent(endpoint.t);
      const diff_angle = endpoint_angle - head_angle;
      return Math.abs((edge_width * Math.sin(diff_angle)) / 2);
    }
    return 0;
  };

  const dash_padding = {
    end: adjust_dash_padding(style.heads, end, false),
    start: adjust_dash_padding(style.tails, start, true)
  };

  const constants = {
    curve: localCurve,
    dash_padding,
    edge_width,
    end,
    head_height,
    head_width,
    height,
    length,
    offset,
    shorten,
    start,
    stroke_width,
    t_after_length
  };

  const tailHeads = geometry.redraw_heads(constants, [...style.tails], start, true);
  const headHeads = geometry.redraw_heads(constants, [...style.heads], end, false);
  const edgePath = geometry.edge_path({
    ...constants,
    total_width_of_heads: headHeads.total_width,
    total_width_of_tails: tailHeads.total_width
  });

  const matrix = createSvgMatrix(sourceOrigin, offset, angle, shift);
  const matrixValue = `matrix(${matrix.a} ${matrix.b} ${matrix.c} ${matrix.d} ${matrix.e} ${matrix.f})`;
  const bodyName = edge.options?.style?.body?.name;
  const labelAlignment = edge.alignment ?? DEFAULT_LABEL_ALIGNMENT;
  const labelClass = labelAlignment === 3 ? "cg-edge-label is-over" : "cg-edge-label";
  const labelT = start.t + (end.t - start.t) * style.label_position;
  const localLabelPoint = localCurve.point(labelT).add(offset);
  const globalLabelPoint = labelPointForAlignment(
    transformPointWithMatrix(localLabelPoint, matrix),
    localCurve.tangent(labelT) + angle,
    labelAlignment
  );
  const localMidPoint = localCurve.point(labelT).add(offset);
  const localTangentAngle = localCurve.tangent(labelT);
  const localTangent = {
    x: Math.cos(localTangentAngle),
    y: Math.sin(localTangentAngle)
  };
  const localDecoration =
    bodyName === "barred" || bodyName === "double barred" || bodyName === "bullet solid" || bodyName === "bullet hollow"
      ? renderBodyDecorations(bodyName, localMidPoint, localTangent, colour, edge.options?.level ?? 1)
      : "";
  const dashAttribute = edgePath.dash_array ? ` stroke-dasharray="${edgePath.dash_array}"` : "";

  return `<g class="cg-edge">
    <g transform="${matrixValue}">
      <path class="cg-edge-path" d="${String(edgePath.path)}" stroke="${colour}" stroke-width="${stroke_width}" fill="none" stroke-linecap="round"${dashAttribute} />
      ${tailHeads.total_width > 0 || style.tails.length > 0
        ? `<path class="cg-edge-tail" d="${String(tailHeads.path)}" stroke="${colour}" stroke-width="${QUIVER_CONSTANTS.STROKE_WIDTH}" fill="none" stroke-linecap="round" />`
        : ""}
      ${headHeads.total_width > 0 || style.heads.length > 0
        ? `<path class="cg-edge-head" d="${String(headHeads.path)}" stroke="${colour}" stroke-width="${QUIVER_CONSTANTS.STROKE_WIDTH}" fill="none" stroke-linecap="round" />`
        : ""}
      ${localDecoration}
    </g>
    ${renderLabel(globalLabelPoint, edge.label, labelColour, labelClass)}
  </g>`;
}

function edgeClassForBody(bodyName: string | undefined) {
  switch (bodyName) {
    case "dashed":
      return "cg-edge-path cg-edge-path--dashed";
    case "dotted":
      return "cg-edge-path cg-edge-path--dotted";
    case "squiggly":
      return "cg-edge-path cg-edge-path--squiggly";
    default:
      return "cg-edge-path";
  }
}

function renderCornerEdge(
  edge: CommutativeEdgeCell,
  source: RenderNode,
  target: RenderNode,
  colour: string,
  labelColour: string
) {
  return renderQuiverArrowEdge(edge, source, target, colour, labelColour);
}

function renderAdjunctionEdge(
  edge: CommutativeEdgeCell,
  source: RenderNode,
  target: RenderNode,
  colour: string,
  labelColour: string
) {
  const sourceCenter = vertexCenter(source);
  const targetCenter = vertexCenter(target);
  const start = intersectRectBoundary(source, targetCenter.x, targetCenter.y);
  const end = intersectRectBoundary(target, sourceCenter.x, sourceCenter.y);
  const controls = bezierControlPoints(start.x, start.y, end.x, end.y, edge.options);
  const path = `M ${start.x} ${start.y} C ${controls.c1x} ${controls.c1y}, ${controls.c2x} ${controls.c2y}, ${end.x} ${end.y}`;
  const mid = bezierPoint(start.x, start.y, controls.c1x, controls.c1y, controls.c2x, controls.c2y, end.x, end.y, 0.5);
  const tangent = bezierTangent(start.x, start.y, controls.c1x, controls.c1y, controls.c2x, controls.c2y, end.x, end.y, 0.5);
  const { ux, uy } = normalizeVector(tangent.x, tangent.y);
  const normalX = -uy;
  const normalY = ux;
  const labelPoint = labelPosition(start.x, start.y, end.x, end.y, edge.alignment ?? DEFAULT_LABEL_ALIGNMENT, normalX, normalY);
  const barStart = {
    x: mid.x - ux * (QUIVER_CONSTANTS.ADJUNCTION_LINE_LENGTH / 2),
    y: mid.y - uy * (QUIVER_CONSTANTS.ADJUNCTION_LINE_LENGTH / 2)
  };
  const barEnd = {
    x: mid.x + ux * (QUIVER_CONSTANTS.ADJUNCTION_LINE_LENGTH / 2),
    y: mid.y + uy * (QUIVER_CONSTANTS.ADJUNCTION_LINE_LENGTH / 2)
  };
  const stemStart = {
    x: barEnd.x - normalX * (QUIVER_CONSTANTS.ADJUNCTION_LINE_LENGTH / 2),
    y: barEnd.y - normalY * (QUIVER_CONSTANTS.ADJUNCTION_LINE_LENGTH / 2)
  };
  const stemEnd = {
    x: barEnd.x + normalX * (QUIVER_CONSTANTS.ADJUNCTION_LINE_LENGTH / 2),
    y: barEnd.y + normalY * (QUIVER_CONSTANTS.ADJUNCTION_LINE_LENGTH / 2)
  };

  return `<g class="cg-edge cg-edge--adjunction">
    <path class="cg-edge-path" d="${path}" stroke="${colour}" stroke-width="${STROKE}" fill="none" stroke-linecap="round" />
    <path d="M ${barStart.x} ${barStart.y} L ${barEnd.x} ${barEnd.y} M ${stemStart.x} ${stemStart.y} L ${stemEnd.x} ${stemEnd.y}" stroke="${colour}" stroke-width="${STROKE}" fill="none" stroke-linecap="round" />
    ${renderLabel(labelPoint, edge.label, labelColour)}
  </g>`;
}

function renderLoopEdge(
  edge: CommutativeEdgeCell,
  node: RenderNode,
  colour: string,
  labelColour: string
) {
  return renderQuiverArrowEdge(edge, node, node, colour, labelColour);
}

function renderStandardEdge(
  edge: CommutativeEdgeCell,
  source: RenderNode,
  target: RenderNode,
  colour: string,
  labelColour: string
) {
  return renderQuiverArrowEdge(edge, source, target, colour, labelColour);
}

function renderEdge(edge: CommutativeEdgeCell, nodes: RenderNode[]) {
  const source = nodes[edge.source];
  const target = nodes[edge.target];
  if (!source || !target) {
    return "";
  }

  const styleName = edge.options?.style?.name ?? "arrow";
  const colour = colourToCss(edge.options?.colour, "currentColor");
  const labelColour = colourToCss(edge.labelColour ?? edge.options?.colour, colour);

  if (styleName === "corner" || styleName === "corner-inverse") {
    return renderCornerEdge(edge, source, target, colour, labelColour);
  }

  if (styleName === "adjunction") {
    return renderAdjunctionEdge(edge, source, target, colour, labelColour);
  }

  return renderQuiverArrowEdge(edge, source, target, colour, labelColour);
}

export function renderCommutativeStaticHtml(
  document: CommutativeDocument,
  options: CommutativeRenderOptions = {}
): CommutativeRenderResult {
  const vertices = document.cells.filter((cell): cell is CommutativeVertexCell => cell.kind === "vertex");
  const edges = document.cells.filter((cell): cell is CommutativeEdgeCell => cell.kind === "edge");

  const nodes = vertices.map((vertex, index) => {
    const size = measureLabel(vertex.label);
    return {
      centreX: PADDING_X + vertex.x * GRID_X,
      centreY: PADDING_Y + vertex.y * GRID_Y,
      colour: vertex.labelColour,
      height: size.height,
      html: renderMath(vertex.label),
      id: index,
      isPoint: isPointNodeLabel(vertex.label),
      radius: size.radius,
      width: size.width
    } satisfies RenderNode;
  });

  const width = Math.max(
    320,
    nodes.reduce((max, node) => {
      const bounds = vertexBounds(node);
      return Math.max(max, bounds.right + PADDING_X);
    }, 0)
  );
  const height = Math.max(
    220,
    nodes.reduce((max, node) => {
      const bounds = vertexBounds(node);
      return Math.max(max, bounds.bottom + PADDING_Y);
    }, 0)
  );

  const edgeMarkup = edges.map((edge) => renderEdge(edge, nodes)).join("");
  const nodeMarkup = nodes
    .map(
      (node) =>
        node.isPoint
          ? `<circle class="cg-node-point" cx="${node.centreX}" cy="${node.centreY}" r="${node.radius}" fill="${colourToCss(node.colour, "currentColor")}" />`
          : `<foreignObject x="${node.centreX - node.width / 2}" y="${node.centreY - node.height / 2}" width="${node.width}" height="${node.height}">
  <div xmlns="http://www.w3.org/1999/xhtml" class="cg-node" style="background:transparent;color:${colourToCss(node.colour)}">${node.html}</div>
</foreignObject>`
    )
    .join("");

  const className = ["commutative", options.className].filter(Boolean).join(" ");
  const preserveAspectRatio = options.fitToWidth === false ? "xMidYMid meet" : "xMinYMin meet";
  const figureStyles = buildFigureStyle(options);
  const figureStyleAttr = figureStyles ? ` style="${figureStyles}"` : "";
  const svg = `<svg class="cg-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" preserveAspectRatio="${preserveAspectRatio}" role="img" aria-label="Commutative diagram">
  <g class="cg-layer cg-layer--edges">${edgeMarkup}</g>
  <g class="cg-layer cg-layer--nodes">${nodeMarkup}</g>
</svg>`;

  return {
    height,
    html: `<figure class="${className}" data-commutative${figureStyleAttr}>${svg}</figure>`,
    width
  };
}

/**
 * Render an error placeholder figure with the same `commutative` class as a
 * successful render plus a `commutative--error` modifier. Used by the fence
 * renderer when parsing fails so authors get a visible signal instead of a
 * crashed page.
 */
export function renderCommutativeErrorHtml(message: string): string {
  return `<figure class="commutative commutative--error" data-commutative-error><pre>${escapeHtml(message)}</pre></figure>`;
}

/**
 * Normalize a tikz-cd fence body to the repo's on-disk format: only the body
 * between `\begin{tikzcd}` and `\end{tikzcd}`.
 */
export function stripTikzcdWrappers(text: string): string {
  let result = text;
  result = result.replace(/^%[^\n]*\n?/, "");
  result = result.replace(/^\\\[\s*\n?/, "");
  result = result.replace(/\n?\\\]\s*$/, "");
  result = result.replace(/^\\begin\{tikzcd\}(\[[^\]]*\])?\s*\n?/, "");
  result = result.replace(/\n?\\end\{tikzcd\}\s*$/, "");
  return result.trim();
}

function buildFigureStyle(options: CommutativeRenderOptions): string {
  const declarations: string[] = [];
  if (typeof options.width === "string" && options.width.trim() !== "") {
    declarations.push(`width:${options.width.trim()}`);
  }
  if (typeof options.scale === "number" && Number.isFinite(options.scale) && options.scale !== 1) {
    declarations.push(`transform:scale(${options.scale})`);
    // Anchor the scale at the alignment edge so right/left aligned figures
    // don't drift sideways when scaled.
    const origin =
      options.align === "left" ? "left center" : options.align === "right" ? "right center" : "center";
    declarations.push(`transform-origin:${origin}`);
  }
  if (options.align === "left") {
    declarations.push("margin-left:0", "margin-right:auto", "justify-content:flex-start");
  } else if (options.align === "right") {
    declarations.push("margin-left:auto", "margin-right:0", "justify-content:flex-end");
  }
  return declarations.join(";");
}

/**
 * Top-level fence renderer used by both site builds and admin previews.
 * Accepts the *body* (tikzcd LaTeX between the fences) and the markdown
 * `infoString` (everything on the opening fence after `commutative`). On parse
 * failure returns an inline `commutative--error` figure so authors get a
 * visible signal but the surrounding page still renders.
 */
export function renderCommutativeFence(body: string, infoString: string | undefined): {
  html: string;
  cssText: string;
} {
  const params = parseFenceParams(infoString);
  const result = parseTikzcd(stripTikzcdWrappers(body));
  if (!result.ok) {
    const errorMsg = (result as { ok: false; error: { message: string } }).error.message;
    return {
      cssText: commutativeCssText,
      html: renderCommutativeErrorHtml(`commutative parse error: ${errorMsg}`)
    };
  }
  const rendered = renderCommutativeStaticHtml(result.document, {
    width: params.width || undefined,
    scale: params.scale,
    align: params.align
  });
  return { cssText: commutativeCssText, html: rendered.html };
}

export const commutativeCssText = `
.commutative {
  margin: 1.2rem 0;
  display: flex;
  justify-content: center;
}

.commutative .cg-svg {
  display: block;
  max-width: 100%;
  height: auto;
  color: inherit;
  overflow: visible;
}

.commutative .cg-node {
  display: flex;
  align-items: center;
  justify-content: center;
  min-width: ${NODE_MIN_WIDTH}px;
  min-height: ${NODE_MIN_HEIGHT}px;
  box-sizing: border-box;
  padding: ${CONTENT_PADDING}px;
  text-align: center;
  line-height: 1.3;
  font-size: ${FONT_SIZE}px;
  background: transparent;
  color: inherit;
}

.commutative .cg-node-point {
  color: inherit;
  vector-effect: non-scaling-stroke;
}

.commutative .cg-edge-label {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: ${LABEL_BOX_HEIGHT}px;
  box-sizing: border-box;
  padding: 0 8px;
  text-align: center;
  line-height: 1.2;
  font-size: ${LABEL_FONT_SIZE}px;
  background: transparent;
  color: inherit;
}

.commutative .cg-edge-label.is-over {
  background: transparent;
}

.commutative .cg-edge-path--dashed {
  stroke-dasharray: 10 8;
}

.commutative .cg-edge-path--dotted {
  stroke-dasharray: 2 7;
}

.commutative .cg-edge-path--squiggly {
  stroke-dasharray: 14 9;
}

.commutative .cg-label-text {
  font-family: "Times New Roman", serif;
}

.commutative--error {
  display: block;
  margin: 1.2rem 0;
  padding: 12px 16px;
  border-radius: 8px;
  border: 1px dashed rgba(220, 38, 38, 0.5);
  background: rgba(220, 38, 38, 0.05);
  color: rgb(120, 25, 25);
  font: 500 13px/1.4 "Cascadia Code", "Fira Code", monospace;
}

.commutative--error pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
`;
