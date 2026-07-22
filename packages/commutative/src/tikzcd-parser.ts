/**
 * TypeScript port of `apps/admin/public/quiver/parser.mjs`.
 *
 * Original is a recursive-descent parser for tikz-cd diagrams that targets the
 * subset quiver itself emits, plus a handful of common hand-written variations.
 * This port preserves the original control flow and heuristics 1:1, but:
 *   - replaces DOM/UI dependencies with the plain records in `quiver-data.ts`,
 *   - drops the post-render `delay()` block (it depended on `arrow.curve()` /
 *     `find_endpoints()` which only exist after a real DOM render — we instead
 *     surface the raw shorten / between values on `ParserEdge` so the renderer
 *     can convert them later if it wants),
 *   - replaces `DOM.Code(x)` diagnostic nodes with backticked strings.
 *
 * Public surface: `parseTikzcd(body)` — input is the *body* of a tikzcd block
 * (the part between `\begin{tikzcd}` and `\end{tikzcd}`); the helper wraps it
 * in the begin/end pair before running the original entry-point, mirroring the
 * agreement in goal.md §2.2.2.
 */

import { toCommutativeDocument } from "./quiver-data.js";
import type {
  ParseDiagnostic,
  ParserColour,
  ParserEdge,
  ParserEdgeOptions,
  ParserPosition,
  ParserVertex
} from "./quiver-data.js";
import { PARSER_DEFAULTS, defaultEdgeOptions } from "./quiver-data.js";
import type { CommutativeDocument } from "./index.js";

export type TikzcdParseResult =
  | { ok: true; document: CommutativeDocument; diagnostics: ParseDiagnostic[] }
  | {
      ok: false;
      error: { message: string; line?: number; column?: number };
      diagnostics: ParseDiagnostic[];
    };

class ParseError {
  constructor(public message: string, public range: Range) {}
}
class ParseWarning {
  constructor(public message: string, public range: Range) {}
}

class Range {
  constructor(public start: number, public length: number) {}
  get end() {
    return this.start + this.length;
  }
  static fromTo(start: number, end: number) {
    return new Range(start, end - start);
  }
}

function clamp(min: number, x: number, max: number) {
  return Math.min(max, Math.max(min, x));
}
function mod(x: number, y: number) {
  return ((x % y) + y) % y;
}

function makeColour(r: number, g: number, b: number, a = 1): ParserColour {
  return [r, g, b, a];
}

const COLOUR_BLACK: ParserColour = [0, 0, 0, 1];

interface State {
  source: string;
  /** Remaining unread source. */
  code: string;
  diagnostics: ParseDiagnostic[];
  cells: Map<string, ParserVertex | ParserEdge>;
  /** Order-preserving vertex storage so toCommutativeDocument keeps insertion order. */
  vertexOrder: Map<string, ParserVertex>;
  edges: ParserEdge[];
  x: number;
  y: number;
  col_delim: string;
}

function makeState(code: string): State {
  return {
    source: code,
    code,
    diagnostics: [],
    cells: new Map(),
    vertexOrder: new Map(),
    edges: [],
    x: 0,
    y: 0,
    col_delim: "&"
  };
}

function position(state: State) {
  return state.source.length - state.code.length;
}
function rangeFrom(state: State, start: number) {
  return Range.fromTo(start, position(state));
}
function rangeHere(state: State) {
  return rangeFrom(state, position(state));
}

function logDiagnostic(state: State, diag: ParseError | ParseWarning, level: "error" | "warning") {
  state.diagnostics.push({
    level,
    message: diag.message,
    range: { start: diag.range.start, length: diag.range.length }
  });
}

/**
 * Run `f`. If it throws a parse Error/Warning, log it and call `onError` so the
 * caller can recover (the convention from parser.mjs:catch_and_log).
 */
function catchAndLog(state: State, f: () => void, onError: (e: ParseError | ParseWarning) => void = () => {}) {
  try {
    f();
  } catch (error) {
    if (error instanceof ParseError) {
      onError(error);
      logDiagnostic(state, error, "error");
    } else if (error instanceof ParseWarning) {
      onError(error);
      logDiagnostic(state, error, "warning");
    } else {
      throw error;
    }
  }
}

function makeError(state: State, message: string | Array<string>, range: Range = rangeHere(state)) {
  return new ParseError(stringifyMessage(message), range);
}
function makeWarning(state: State, message: string | Array<string>, range: Range = rangeHere(state)) {
  return new ParseWarning(stringifyMessage(message), range);
}

/** parser.mjs builds messages as arrays of strings + DOM.Code nodes. We collapse them to plain strings. */
function stringifyMessage(message: string | Array<string>): string {
  if (typeof message === "string") return message;
  return message.join("");
}

function eat(state: State, pattern: string | RegExp, expected = false): string | null {
  if (typeof pattern === "string") {
    if (state.code.startsWith(pattern)) {
      state.code = state.code.slice(pattern.length);
      return pattern;
    }
  } else {
    const match = state.code.match(pattern);
    if (match !== null && match.index === 0) {
      state.code = state.code.slice(match[0].length);
      return match[0];
    }
  }
  if (expected) {
    throw makeError(state, ["Expected `", String(pattern), "`."]);
  }
  return null;
}

function check(state: State, pattern: string | RegExp): boolean {
  if (typeof pattern === "string") {
    return state.code.startsWith(pattern);
  }
  const match = state.code.match(pattern);
  return match !== null && match.index === 0;
}

function eatWhitespace(state: State): string | null {
  const match = state.code.match(/^\s+/);
  if (match !== null) {
    state.code = state.code.slice(match[0].length);
    return match[0];
  }
  return null;
}

function eatWhitespaceAndComments(state: State): void {
  while (eatWhitespace(state) || parseComment(state) !== null);
}

function parseComment(state: State): string | null {
  if (/^%/.test(state.code)) {
    const match = state.code.match(/^%(.*)/)!;
    state.code = state.code.slice(match[0].length);
    return match[1] ?? "";
  }
  return null;
}

function parseNat(state: State, expected = false): number | null {
  if (/^[0-9+]/.test(state.code)) {
    const match = state.code.match(/^[0-9]+/);
    if (match) {
      state.code = state.code.slice(match[0].length);
      return parseInt(match[0], 10);
    }
  }
  if (expected) {
    throw makeError(state, "Expected natural number.");
  }
  return null;
}

function parseInteger(state: State, expected = false): number | null {
  const negative = eat(state, "-") !== null;
  const nat = parseNat(state);
  if (nat !== null) {
    return negative ? -nat : nat;
  }
  if (expected) {
    throw makeError(state, "Expected integer.");
  }
  return null;
}

function parseFloatNum(state: State, expected = false): number | null {
  const start = position(state);
  const str = eat(state, /-?[0-9]*\.?[0-9]*/);
  if (str === null) {
    if (expected) {
      throw makeError(state, "Expected number.");
    }
    return null;
  }
  const f = parseFloat(str);
  if (Number.isNaN(f)) {
    throw makeError(state, ["Expected number, found `", str, "`."], rangeFrom(state, start));
  }
  return f;
}

function parseName(state: State, expected: boolean): string | null {
  const name = eat(state, /[0-9a-z_-]+/i);
  if (name === null && expected) {
    throw makeError(state, "Expected name.");
  }
  return name;
}

function parseColour(state: State, expected = false): ParserColour | null {
  const start = position(state);
  if (eat(state, "{rgb,")) {
    const s = parseNat(state, true)!;
    eat(state, ":red,", true);
    const r = parseNat(state, true)!;
    eat(state, ";green,", true);
    const g = parseNat(state, true)!;
    eat(state, ";blue,", true);
    const b = parseNat(state, true)!;
    eat(state, "}", true);
    if (
      s !== 255 ||
      ![r, g, b].every((value) => value !== null && value >= 0 && value <= 255)
    ) {
      throw makeWarning(state, "Malformed colour specification.", rangeFrom(state, start));
    }
    return makeColour(r, g, b);
  }
  if (expected) {
    throw makeError(state, "Expected colour specification.");
  }
  return null;
}

function skipToCommaOrBracket(state: State, brackets: RegExp | null = null) {
  return (diagnostic: ParseError | ParseWarning | null = null): Range => {
    const start = position(state);
    state.code = state.code.replace(/^[^,\]}]*(?=[,\]}])/, "");
    const range = rangeFrom(state, start);
    if (brackets !== null) {
      state.code = state.code.replace(brackets, "");
    }
    if (diagnostic !== null && diagnostic.range !== null) {
      diagnostic.range = Range.fromTo(diagnostic.range.start, range.end);
    }
    return range;
  };
}

function unknownOptionWarning(state: State, regex: RegExp, kind: string): never {
  const match = state.code.match(regex);
  if (match !== null) {
    const option = match[0];
    const message =
      option.length > 0 ? [`Unknown ${kind} option: \`${option}\`.`] : `Expected ${kind} option.`;
    throw makeWarning(state, message, new Range(position(state), match[0].length));
  }
  throw makeError(state, `Unexpected end of ${kind} options.`);
}

function parseDiagramOptions(state: State): boolean {
  if (eat(state, "[")) {
    eatWhitespace(state);
    if (!eat(state, "]")) {
      while (true) {
        catchAndLog(
          state,
          () => parseDiagramOption(state),
          skipToCommaOrBracket(state, /^\}/)
        );
        eatWhitespace(state);
        if (eat(state, "]")) break;
        if (!eat(state, ",")) {
          if (state.code.length !== 0) {
            throw makeError(state, "Expected comma before the start of the next diagram option.");
          }
          break;
        }
        eatWhitespace(state);
      }
    }
    return true;
  }
  return false;
}

function parseDiagramOption(state: State) {
  if (eat(state, "ampersand replacement")) {
    eatWhitespace(state);
    eat(state, "=", true);
    const colDelim = eat(state, /[^\s,\]]+/);
    if (colDelim !== null) {
      state.col_delim = colDelim;
    } else {
      throw makeError(state, "Expected column delimiter.");
    }
    return;
  }
  if (eat(state, "row sep") || eat(state, "column sep") || eat(state, "sep")) {
    eatWhitespace(state);
    eat(state, "=", true);
    eatWhitespace(state);
    if (eat(state, /-?[0-9a-z.]+/) === null) {
      throw makeError(state, "Expected separation amount.");
    }
    return;
  }
  if (eat(state, "cramped")) return;

  unknownOptionWarning(state, /^[^,\]]*(?=[,\]])/, "diagram");
}

function parseNode(state: State): ParserVertex | null {
  const start = position(state);
  if (check(state, "\\end")) return null;

  let colour: ParserColour | null = null;
  catchAndLog(state, () => {
    if (eat(state, "\\textcolor")) {
      colour = parseColour(state, true)!;
    }
  });

  let label: string | null = null;
  if (eat(state, "{")) {
    let brackets = 1;
    let i = 0;
    for (i = 0; i <= state.code.length; ++i) {
      if (state.code[i] === "{") ++brackets;
      if (state.code[i] === "}") --brackets;
      if (brackets === 0) break;
    }
    if (brackets === 0) {
      label = state.code.substring(0, i);
      state.code = state.code.slice(i + 1);
    }
  } else if (check(state, /^\S+/)) {
    label = "";
    let whitespace = "";
    while (true) {
      const match = state.code.match(/^\S+/);
      if (!match) break;
      label += match[0];
      state.code = state.code.replace(/^\S+/, "");
      whitespace = eatWhitespace(state) || "";
      if (
        state.code.length !== 0 &&
        !check(state, state.col_delim) &&
        !check(state, "\\\\") &&
        !check(state, "\\ar[") &&
        !check(state, "\\arrow[") &&
        !check(state, "\\end") &&
        check(state, /^\S+/)
      ) {
        label += whitespace;
        continue;
      }
      state.code = whitespace + state.code;
      break;
    }
  }

  if (label !== null) {
    return {
      kind: "vertex",
      label,
      labelColour: colour ?? COLOUR_BLACK,
      position: { x: state.x, y: state.y }
    };
  }
  if (colour !== null) {
    throw makeError(state, "Colour specification without node.", rangeFrom(state, start));
  }
  return null;
}

function parseEdgeBlock(state: State): ParserEdge | null {
  const start = position(state);
  if (eat(state, "\\ar")) {
    eat(state, "row");
    eat(state, "[", true);
    const edge: ParserEdge = {
      kind: "edge",
      source: { x: state.x, y: state.y },
      target: undefined,
      label: "",
      label_colour: COLOUR_BLACK,
      options: defaultEdgeOptions(),
      shorten: { source: 0, target: 0 },
      between: { source: null, target: null },
      reverse: false,
      loop: false,
      loop_tail_angle: 55,
      loop_head_angle: 125,
      phantom: false,
      range: { start, length: 0 }
    };
    eatWhitespace(state);
    if (!eat(state, "]")) {
      while (true) {
        catchAndLog(
          state,
          () => parseEdgeOption(state, edge),
          skipToCommaOrBracket(state, /^\}/)
        );
        eatWhitespace(state);
        if (eat(state, "]")) break;
        if (!eat(state, ",")) {
          if (state.code.length !== 0) {
            throw makeError(state, "Expected comma before the start of the next arrow option.");
          }
          break;
        }
        eatWhitespace(state);
      }
    }
    edge.range.length = position(state) - edge.range.start;
    return edge;
  }
  return null;
}

function swapLabelAlignment(opt: ParserEdgeOptions) {
  if (opt.label_alignment === "left") opt.label_alignment = "right";
  else if (opt.label_alignment === "right") opt.label_alignment = "left";
}

function parseEdgeOption(state: State, edge: ParserEdge) {
  // Special-cased decorative arrows.
  if (eat(state, '"\\dashv"{anchor=center')) {
    eat(state, /, rotate=-?\d+/);
    eat(state, "}", true);
    edge.options.style.name = "adjunction";
    return;
  }
  if (eat(state, '"\\lrcorner"{anchor=center, pos=0.125')) {
    eat(state, /, rotate=-?\d+/);
    eat(state, "}", true);
    edge.options.style.name = "corner";
    return;
  }
  if (eat(state, '"\\ulcorner"{anchor=center, pos=0.125')) {
    eat(state, /, rotate=-?\d+/);
    eat(state, "}", true);
    edge.options.style.name = "corner-inverse";
    return;
  }
  const markings: Array<[string, string]> = [
    ["\\shortmid", "barred"],
    ["{\\shortmid\\shortmid}", "double barred"],
    ["\\bullet", "bullet solid"],
    ["\\circ", "bullet hollow"]
  ];
  for (const [marking, body] of markings) {
    if (eat(state, `"${marking}"{marking`)) {
      eatWhitespace(state);
      if (eat(state, ",") && eatWhitespace(state) && eat(state, "pos")) {
        eatWhitespace(state);
        eat(state, "=", true);
        eatWhitespace(state);
        parseFloatNum(state, true);
        eatWhitespace(state);
      }
      if (eat(state, ",")) {
        eatWhitespace(state);
        eat(state, "text", true);
        eatWhitespace(state);
        eat(state, "=", true);
        eatWhitespace(state);
        if (!eat(state, "\\pgfkeysvalueof{/tikz/commutative diagrams/background color}")) {
          parseColour(state, true);
        }
      }
      eat(state, "}", true);
      edge.options.style.body.name = body;
      return;
    }
  }
  if (eat(state, "phantom")) {
    edge.phantom = true;
    edge.options.label_alignment = "centre";
    edge.options.style.head.name = "none";
    edge.options.style.body.name = "none";
    edge.options.style.tail.name = "none";
    return;
  }
  if (eat(state, "swap")) {
    swapLabelAlignment(edge.options);
    return;
  }
  // Label.
  if (eat(state, '"')) {
    let label = eat(state, /[^"]*/) ?? "";
    eat(state, '"', true);
    if (label.length >= 2 && label[0] === "{" && label[label.length - 1] === "}") {
      label = label.replace(/^\{|\}$/g, "");
    }
    edge.label = label;
    while (eat(state, "'")) {
      swapLabelAlignment(edge.options);
    }
    eatWhitespace(state);
    if (eat(state, "{")) {
      eatWhitespace(state);
      if (!eat(state, "}")) {
        while (true) {
          catchAndLog(
            state,
            () => parseLabelOption(state, edge),
            skipToCommaOrBracket(state)
          );
          eatWhitespace(state);
          if (eat(state, "}")) break;
          if (!eat(state, ",")) {
            if (state.code.length !== 0) {
              throw makeError(state, "Expected comma before the start of the next label option.");
            }
            break;
          }
          eatWhitespace(state);
        }
      }
    } else {
      if (!check(state, "]") && !check(state, ",")) {
        catchAndLog(
          state,
          () => parseLabelOption(state, edge),
          skipToCommaOrBracket(state)
        );
      }
    }
    return;
  }
  // Relative target positioning (urld).
  let to: string | null;
  if ((to = eat(state, /[urld]+(?=\s*[,\]])/))) {
    const u = (to.match(/u/g) || []).length;
    const r = (to.match(/r/g) || []).length;
    const l = (to.match(/l/g) || []).length;
    const d = (to.match(/d/g) || []).length;
    const sourcePos =
      edge.source && typeof edge.source !== "string"
        ? edge.source
        : { x: state.x, y: state.y };
    edge.target = { x: sourcePos.x + r - l, y: sourcePos.y + d - u };
    return;
  }
  const parseCoord = (): ParserPosition | string | null => {
    eatWhitespace(state);
    eat(state, "=", true);
    eatWhitespace(state);
    if (/^[0-9]+-[0-9]+/.test(state.code)) {
      const y = parseInteger(state, true)!;
      eat(state, "-");
      const x = parseInteger(state, true)!;
      return { x: x - 1, y: y - 1 };
    }
    const start = position(state);
    const name = parseName(state, true);
    if (name === null) return null;
    if (!state.cells.has(name)) {
      logDiagnostic(
        state,
        new ParseError(`No cell named \`${name}\`.`, rangeFrom(state, start)),
        "error"
      );
      return null;
    }
    return name;
  };
  if (eat(state, "from")) {
    const coord = parseCoord();
    edge.source = coord;
    if (coord === null) skipToCommaOrBracket(state, /^\}/)();
    return;
  }
  if (eat(state, "to")) {
    const coord = parseCoord();
    edge.target = coord;
    if (coord === null) skipToCommaOrBracket(state, /^\}/)();
    return;
  }
  if (eat(state, "loop")) {
    edge.loop = true;
    return;
  }
  if (eat(state, "distance")) {
    eatWhitespace(state);
    eat(state, "=", true);
    eatWhitespace(state);
    edge.options.radius = 1 + Math.round(clamp(0, parseFloatNum(state, true)! / 5 - 1, 2)) * 2;
    eat(state, /^(em|pt|mm)/);
    return;
  }
  if (eat(state, "in")) {
    eatWhitespace(state);
    eat(state, "=", true);
    edge.loop_head_angle = parseInteger(state, true)!;
    return;
  }
  if (eat(state, "out")) {
    eatWhitespace(state);
    eat(state, "=", true);
    edge.loop_tail_angle = parseInteger(state, true)!;
    return;
  }
  if (eat(state, "curve")) {
    eatWhitespace(state);
    eat(state, "=", true);
    eatWhitespace(state);
    eat(state, "{", true);
    eatWhitespace(state);
    eat(state, "height", true);
    eatWhitespace(state);
    eat(state, "=", true);
    const curve = parseInteger(state, true)!;
    eat(state, "pt", true);
    eatWhitespace(state);
    eat(state, "}", true);
    const factor = PARSER_DEFAULTS.CURVE_HEIGHT * PARSER_DEFAULTS.TIKZ_HORIZONTAL_MULTIPLIER;
    edge.options.curve = Math.round(clamp(-5, curve / factor, 5));
    return;
  }
  let neg = true;
  if (eat(state, "bend left") || ((neg = false), eat(state, "bend right"))) {
    eatWhitespace(state);
    const amount = 1;
    if (eat(state, "=")) {
      eatWhitespace(state);
      parseInteger(state, true);
    }
    edge.options.curve = Math.round(clamp(-5, amount * (neg ? -1 : 1), 5));
    return;
  }
  neg = true;
  if (eat(state, "shift left") || ((neg = false), eat(state, "shift right"))) {
    eatWhitespace(state);
    let amount = 1;
    if (eat(state, "=")) {
      eatWhitespace(state);
      amount = parseInteger(state, true)!;
    }
    edge.options.offset = amount * (neg ? -1 : 1);
    return;
  }
  if (eat(state, "shorten <")) {
    eatWhitespace(state);
    eat(state, "=", true);
    edge.shorten.source = parseInteger(state, true)!;
    eat(state, "pt", true);
    return;
  }
  if (eat(state, "shorten >")) {
    eatWhitespace(state);
    eat(state, "=", true);
    edge.shorten.target = parseInteger(state, true)!;
    eat(state, "pt", true);
    return;
  }
  if (eat(state, "between")) {
    eatWhitespace(state);
    eat(state, "=", true);
    eatWhitespace(state);
    eat(state, "{", true);
    eatWhitespace(state);
    edge.between.source = parseFloatNum(state, true);
    eatWhitespace(state);
    eat(state, "}", true);
    eatWhitespace(state);
    eat(state, "{", true);
    eatWhitespace(state);
    edge.between.target = parseFloatNum(state, true);
    eatWhitespace(state);
    eat(state, "}", true);
    return;
  }
  // tikz-cd presets.
  const flip = (e: ParserEdge, reverse: boolean) => {
    e.reverse = reverse;
    return true;
  };
  if (
    (eat(state, "Rightarrow") && flip(edge, false)) ||
    (eat(state, "Leftarrow") && flip(edge, true))
  ) {
    edge.options.style.body.name = "cell";
    edge.options.level = 2;
    edge.options.style.tail.name = "none";
    edge.options.style.head.name = "arrowhead";
    return;
  }
  if (eat(state, "Leftrightarrow")) {
    edge.options.style.body.name = "cell";
    edge.options.level = 2;
    edge.options.style.tail.name = "arrowhead";
    edge.options.style.head.name = "arrowhead";
  }
  if (
    (eat(state, "mapsto") && flip(edge, false)) ||
    (eat(state, "mapsfrom") && flip(edge, true))
  ) {
    edge.options.style.body.name = "cell";
    edge.options.style.tail.name = "maps to";
    edge.options.style.head.name = "arrowhead";
    return;
  }
  if (
    (eat(state, "Mapsto") && flip(edge, false)) ||
    (eat(state, "Mapsfrom") && flip(edge, true))
  ) {
    edge.options.style.body.name = "cell";
    edge.options.level = 2;
    edge.options.style.tail.name = "maps to";
    edge.options.style.head.name = "arrowhead";
    return;
  }
  if (
    (eat(state, "hookrightarrow") && flip(edge, false)) ||
    (eat(state, "hookleftarrow") && flip(edge, true))
  ) {
    edge.options.style.body.name = "cell";
    edge.options.style.tail.name = "hook";
    edge.options.style.tail.side = "top";
    edge.options.style.head.name = "arrowhead";
    return;
  }
  if (
    (eat(state, "rightarrowtail") && flip(edge, false)) ||
    (eat(state, "leftarrowtail") && flip(edge, true))
  ) {
    edge.options.style.body.name = "cell";
    edge.options.style.tail.name = "mono";
    edge.options.style.head.name = "arrowhead";
    return;
  }
  if (
    (eat(state, "rightarrow") && flip(edge, false)) ||
    (eat(state, "leftarrow") && flip(edge, true))
  ) {
    edge.options.style.body.name = "cell";
    edge.options.style.tail.name = "none";
    edge.options.style.head.name = "arrowhead";
    return;
  }
  if (eat(state, "leftrightarrow")) {
    edge.options.style.body.name = "cell";
    edge.options.style.tail.name = "arrowhead";
    edge.options.style.head.name = "arrowhead";
  }
  if (
    (eat(state, "twoheadrightarrow") && flip(edge, false)) ||
    (eat(state, "twoheadleftarrow") && flip(edge, true))
  ) {
    edge.options.style.body.name = "cell";
    edge.options.style.tail.name = "none";
    edge.options.style.head.name = "epi";
  }
  if (
    (check(state, "rightharpoonup") ||
      check(state, "rightharpoondown") ||
      check(state, "leftharpoonup") ||
      check(state, "leftharpoondown")) &&
    ((eat(state, "rightharpoon") && flip(edge, false)) ||
      (eat(state, "leftharpoon") && flip(edge, true)))
  ) {
    edge.options.style.body.name = "cell";
    edge.options.style.tail.name = "none";
    edge.options.style.head.name = "harpoon";
    if (eat(state, "up")) {
      edge.options.style.head.side = "top";
    } else if (eat(state, "down")) {
      edge.options.style.head.side = "bottom";
    }
    return;
  }
  if (
    (eat(state, "dashrightarrow") && flip(edge, false)) ||
    (eat(state, "dashleftarrow") && flip(edge, true))
  ) {
    edge.options.style.body.name = "dashed";
    edge.options.style.tail.name = "none";
    edge.options.style.head.name = "arrowhead";
    return;
  }
  if (
    (eat(state, "rightsquigarrow") && flip(edge, false)) ||
    (eat(state, "leftsquigarrow") && flip(edge, true))
  ) {
    edge.options.style.body.name = "squiggly";
    edge.options.style.tail.name = "none";
    edge.options.style.head.name = "arrowhead";
    return;
  }
  if (eat(state, "leftrightsquigarrow")) {
    edge.options.style.body.name = "squiggly";
    edge.options.style.tail.name = "arrowhead";
    edge.options.style.head.name = "arrowhead";
    return;
  }
  if (!check(state, "dashed") && eat(state, "dash")) {
    edge.options.style.body.name = "cell";
    edge.options.level = 1;
    edge.options.style.tail.name = "none";
    edge.options.style.head.name = "none";
    return;
  }
  if (eat(state, "equal")) {
    eat(state, "s");
    edge.options.style.body.name = "cell";
    edge.options.level = 2;
    edge.options.style.tail.name = "none";
    edge.options.style.head.name = "none";
    return;
  }
  if (eat(state, "double line")) {
    edge.options.level = 2;
  }
  if (eat(state, "scaling nfold")) {
    eatWhitespace(state);
    eat(state, "=", true);
    eatWhitespace(state);
    const start = position(state);
    const nat = parseNat(state, true);
    if (nat !== null) {
      edge.options.level = clamp(2, nat, PARSER_DEFAULTS.MAXIMUM_CELL_LEVEL);
      if (nat < 2 || nat > PARSER_DEFAULTS.MAXIMUM_CELL_LEVEL) {
        throw makeWarning(
          state,
          `Level must be between 2 and ${PARSER_DEFAULTS.MAXIMUM_CELL_LEVEL}.`,
          rangeFrom(state, start)
        );
      }
    }
    return;
  }
  for (const style of ["dashed", "dotted", "squiggly"] as const) {
    if (eat(state, style)) {
      edge.options.style.body.name = style;
      return;
    }
  }
  if (eat(state, "no body")) {
    edge.options.style.body.name = "none";
    return;
  }
  if (eat(state, "maps to")) {
    edge.options.style.tail.name = "maps to";
    return;
  }
  if (eat(state, "tail") || eat(state, "2tail")) {
    if (eat(state, " reversed")) {
      edge.options.style.tail.name = "arrowhead";
    } else {
      edge.options.style.tail.name = "mono";
    }
    return;
  }
  if (eat(state, "hook")) {
    edge.options.style.tail.name = "hook";
    edge.options.style.tail.side = eat(state, "'") ? "bottom" : "top";
    return;
  }
  if (eat(state, "to head")) {
    edge.options.style.head.name = "cell";
    return;
  }
  if (eat(state, "no head")) {
    edge.options.style.head.name = "none";
    return;
  }
  if (eat(state, "two heads")) {
    edge.options.style.head.name = "epi";
    return;
  }
  if (eat(state, "harpoon")) {
    edge.options.style.head.name = "harpoon";
    edge.options.style.head.side = eat(state, "'") ? "bottom" : "top";
    return;
  }
  let ate_color = false;
  if (eat(state, "draw") || ((ate_color = true), eat(state, "color"))) {
    eatWhitespace(state);
    eat(state, "=", true);
    eatWhitespace(state);
    if (!ate_color && eat(state, "none")) {
      edge.options.style.head.name = "none";
      edge.options.style.body.name = "none";
      edge.options.style.tail.name = "none";
      return;
    }
    const colour = parseColour(state, true)!;
    edge.options.colour = colour;
    if (ate_color) {
      edge.label_colour = colour;
    }
    return;
  }
  if (eat(state, "start anchor=center") || eat(state, "end anchor=center")) {
    return;
  }
  unknownOptionWarning(state, /^[^,\]]*(?=[,\]])/, "arrow");
}

function parseLabelOption(state: State, edge: ParserEdge) {
  if (eat(state, "text")) {
    eatWhitespace(state);
    eat(state, "=", true);
    eatWhitespace(state);
    const colour = parseColour(state, true)!;
    edge.label_colour = colour;
    return;
  }
  if (eat(state, "name")) {
    eatWhitespace(state);
    eat(state, "=", true);
    eatWhitespace(state);
    const name = parseName(state, true)!;
    state.cells.set(name, edge);
    return;
  }
  if (eat(state, "description")) {
    edge.options.label_alignment = "centre";
    return;
  }
  if (eat(state, "marking")) {
    edge.options.label_alignment = "over";
    return;
  }
  if (eat(state, "pos")) {
    eatWhitespace(state);
    eat(state, "=", true);
    eatWhitespace(state);
    const pos = parseFloatNum(state, true)!;
    edge.options.label_position = clamp(0, pos * 100, 100);
    return;
  }
  if (eat(state, "at start")) {
    edge.options.label_position = 0;
    return;
  }
  if (eat(state, "very near start")) {
    edge.options.label_position = 10;
    return;
  }
  if (eat(state, "near start")) {
    edge.options.label_position = 20;
    return;
  }
  if (eat(state, "midway")) {
    edge.options.label_position = 50;
    return;
  }
  if (eat(state, "near end")) {
    edge.options.label_position = 80;
    return;
  }
  if (eat(state, "very near end")) {
    edge.options.label_position = 90;
    return;
  }
  if (eat(state, "at end")) {
    edge.options.label_position = 1;
    return;
  }
  if (eat(state, "inner sep=")) {
    if (eat(state, "0") || eat(state, ".8ex")) return;
  }
  if (eat(state, "anchor=center")) return;
  if (eat(state, "allow upside down")) return;
  unknownOptionWarning(state, /^[^,}]*(?=[,}])/, "label");
}

function endpointKey(endpoint: { x: number; y: number } | string): string {
  return typeof endpoint === "string" ? endpoint : `${endpoint.x} ${endpoint.y}`;
}

function parseDiagram(state: State) {
  catchAndLog(state, () => {
    eatWhitespaceAndComments(state);
    const inBlock = eat(state, "\\[") !== null;
    eatWhitespaceAndComments(state);
    if (!eat(state, "\\begin{tikzcd}")) {
      throw makeError(
        state,
        ["Diagrams must start with `\\begin{tikzcd}`."],
        new Range(0, state.code.length)
      );
    }
    catchAndLog(state, () => parseDiagramOptions(state));
    const parserEdges: ParserEdge[] = [];

    let prevX: number | null = null;
    let prevY: number | null = null;

    while (true) {
      eatWhitespaceAndComments(state);
      const edge = parseEdgeBlock(state);
      if (edge !== null) {
        parserEdges.push(edge);
        continue;
      }
      if (eat(state, state.col_delim)) {
        ++state.x;
        continue;
      }
      if (eat(state, "\\\\")) {
        state.x = 0;
        ++state.y;
        continue;
      }
      let cont = false;
      const start = position(state);
      catchAndLog(
        state,
        () => {
          const node = parseNode(state);
          if (node !== null) {
            cont = true;
            if (state.x === prevX && state.y === prevY) {
              throw makeError(
                state,
                [`Expected \`${state.col_delim}\` or \`\\\\\` between nodes.`],
                new Range(start, 0)
              );
            }
            prevX = state.x;
            prevY = state.y;
            const key = `${node.position.x} ${node.position.y}`;
            state.cells.set(key, node);
            state.vertexOrder.set(key, node);
          }
        },
        () => {
          cont = true;
        }
      );
      if (!cont) break;
    }

    // Phantom-edge handling (parser.mjs:144-156).
    const phantoms = new Set<ParserEdge>();
    const adjustForPhantoms = (
      edge: ParserEdge,
      end: "source" | "target"
    ): { x: number; y: number } | string | null | undefined => {
      const value = edge[end];
      if (value === undefined) return value;
      if (value === null) return value;
      const key = endpointKey(value);
      if (/^[0-9]+p$/.test(key)) {
        const nonPhantom = key.slice(0, -1);
        const candidate = state.cells.get(key);
        if (candidate && "phantom" in candidate && candidate.phantom && state.cells.has(nonPhantom)) {
          phantoms.add(candidate as ParserEdge);
          edge.options.edge_alignment[end] = false;
          return nonPhantom;
        }
      }
      return value;
    };

    for (const edge of parserEdges) {
      if (edge.source === null || edge.target === null) {
        continue;
      }
      const source = adjustForPhantoms(edge, "source");
      let target = adjustForPhantoms(edge, "target");
      if (source !== undefined && source !== null) edge.source = source;
      if (target !== undefined && target !== null) edge.target = target;

      // Implicit vertices.
      const sourceKey =
        edge.source !== null && edge.source !== undefined ? endpointKey(edge.source) : null;
      if (sourceKey !== null && !state.cells.has(sourceKey)) {
        const dummy: ParserVertex = {
          kind: "vertex",
          label: "",
          labelColour: COLOUR_BLACK,
          position:
            typeof edge.source === "string"
              ? { x: 0, y: 0 }
              : (edge.source as ParserPosition)
        };
        state.cells.set(sourceKey, dummy);
        state.vertexOrder.set(sourceKey, dummy);
      }

      if (target === undefined) {
        if (edge.loop) {
          target = edge.source!;
        } else {
          logDiagnostic(
            state,
            new ParseError("Encountered arrow with no target.", new Range(edge.range.start, edge.range.length)),
            "error"
          );
          continue;
        }
      }
      edge.target = target;
      const targetKey =
        edge.target !== null && edge.target !== undefined ? endpointKey(edge.target) : null;
      if (sourceKey !== null && targetKey !== null && targetKey === sourceKey && !edge.loop) {
        logDiagnostic(
          state,
          new ParseError(
            "Encountered non-`loop` arrow with the same source and target.",
            new Range(edge.range.start, edge.range.length)
          ),
          "error"
        );
        continue;
      }
      if (edge.loop) {
        if (targetKey !== sourceKey) {
          logDiagnostic(
            state,
            new ParseError(
              "Encountered loop with different source and target.",
              new Range(edge.range.start, edge.range.length)
            ),
            "error"
          );
          continue;
        }
        const clockwise = mod(edge.loop_head_angle - edge.loop_tail_angle + 180, 360) < 180;
        if (!clockwise) {
          edge.options.radius *= -1;
        }
        const angleDis = mod(edge.loop_head_angle - edge.loop_tail_angle + 180, 360) - 180;
        let loopAngle = mod(
          90 * (clockwise ? 1 : -1) - mod(edge.loop_tail_angle + angleDis / 2, 360),
          360
        );
        if (loopAngle > 180) loopAngle -= 360;
        edge.options.angle = loopAngle;
      }
      if (targetKey !== null && !state.cells.has(targetKey)) {
        const dummy: ParserVertex = {
          kind: "vertex",
          label: "",
          labelColour: COLOUR_BLACK,
          position:
            typeof edge.target === "string"
              ? { x: 0, y: 0 }
              : (edge.target as ParserPosition)
        };
        state.cells.set(targetKey, dummy);
        state.vertexOrder.set(targetKey, dummy);
      }
      state.edges.push(edge);
    }

    // Drop confirmed quiver-emitted phantom edges.
    state.edges = state.edges.filter((e) => !phantoms.has(e));

    if (!eat(state, "\\end{tikzcd}")) {
      throw makeError(
        state,
        ["Diagrams must end with `\\end{tikzcd}`."],
        new Range(0, state.source.length)
      );
    }
    eatWhitespaceAndComments(state);
    if (inBlock) {
      eat(state, "\\]", true);
    }
    eatWhitespaceAndComments(state);
    if (state.code.length !== 0) {
      throw makeError(
        state,
        "Unexpected content after diagram.",
        Range.fromTo(position(state), state.source.length)
      );
    }
  });
}

/**
 * Parse a tikzcd block body. The caller passes the *inside* of `\begin{tikzcd}
 * ... \end{tikzcd}`; this helper wraps it so the original recursive-descent
 * parser sees the begin/end tokens it expects.
 */
export function parseTikzcd(body: string): TikzcdParseResult {
  const wrapped = `\\begin{tikzcd}\n${body}\n\\end{tikzcd}`;
  const state = makeState(wrapped);
  try {
    parseDiagram(state);
  } catch (error) {
    if (error instanceof ParseError) {
      return {
        ok: false,
        error: { message: error.message },
        diagnostics: state.diagnostics
      };
    }
    throw error;
  }
  const fatalDiagnostic = state.diagnostics.find((d) => d.level === "error");
  if (fatalDiagnostic && state.vertexOrder.size === 0 && state.edges.length === 0) {
    return {
      ok: false,
      error: { message: fatalDiagnostic.message },
      diagnostics: state.diagnostics
    };
  }
  const document = toCommutativeDocument({
    vertices: state.vertexOrder,
    edges: state.edges
  });
  return {
    ok: true,
    document,
    diagnostics: state.diagnostics
  };
}

export type { ParseDiagnostic } from "./quiver-data.js";
