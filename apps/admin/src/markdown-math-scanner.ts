export type MarkdownMathMode = "inline" | "block";

export interface MarkdownMathContextState {
  inFenceMarker: string | null;
  inMath: MarkdownMathMode | null;
}

export interface MarkdownMathRange {
  startIndex: number;
  endIndex: number;
  mode: MarkdownMathMode;
}

export interface MarkdownMathScanResult {
  mathRanges: MarkdownMathRange[];
  nextState: MarkdownMathContextState;
}

function getFenceMarker(line: string) {
  const trimmed = line.trimStart();
  const match = /^(?<marker>`{3,}|~{3,})/.exec(trimmed);
  return match?.groups?.marker ?? null;
}

export function createInitialMarkdownMathContextState(): MarkdownMathContextState {
  return {
    inFenceMarker: null,
    inMath: null
  };
}

export interface MathPair {
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

let cachedMathPairs: MathPair[] = [];

export function updateMathPairsCache(pairs: MathPair[]) {
  cachedMathPairs = pairs;
}

export function getCachedMathPairs(): MathPair[] {
  return cachedMathPairs;
}

export function findMathRangeForPosition(line: number, col: number): MathPair | null {
  const pairs = cachedMathPairs;
  let low = 0;
  let high = pairs.length - 1;
  let result: MathPair | null = null;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    const pair = pairs[mid];
    if (pair.startLine < line || (pair.startLine === line && pair.startCol <= col)) {
      result = pair;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (result) {
    const afterStart = result.startLine < line || (result.startLine === line && result.startCol <= col);
    const beforeEnd = line < result.endLine || (line === result.endLine && col <= result.endCol);
    if (afterStart && beforeEnd) {
      return result;
    }
  }

  return null;
}

export function findMathRangesForLine(line: number): MathPair[] {
  const pairs = cachedMathPairs;
  const result: MathPair[] = [];

  for (const pair of pairs) {
    if (pair.endLine < line) continue;
    if (pair.startLine > line) break;
    result.push(pair);
  }

  return result;
}

export function scanDocumentMathPairs(text: string): MathPair[] {
  const lines = text.split("\n");
  const pairs: MathPair[] = [];
  let inMathMode: "inline" | "block" | null = null;
  let pairStartLine = 0;
  let pairStartCol = 0;
  let fenceMarker: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const fenceMatch = /^(?<marker>`{3,}|~{3,})/.exec(trimmed);

    if (fenceMatch) {
      const marker = fenceMatch.groups!.marker;
      if (fenceMarker === marker) {
        fenceMarker = null;
        continue;
      }
      if (!fenceMarker && !inMathMode) {
        fenceMarker = marker;
        continue;
      }
    }

    if (fenceMarker) continue;

    let inlineCodeLen = 0;

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];

      if (ch === "\\") { j += 1; continue; }

      if (!inMathMode && ch === "`") {
        let run = 1;
        while (line[j + run] === "`") run += 1;
        if (inlineCodeLen === 0) inlineCodeLen = run;
        else if (inlineCodeLen === run) inlineCodeLen = 0;
        j += run - 1;
        continue;
      }

      if (inlineCodeLen > 0 || ch !== "$") continue;

      const delimLen = line[j + 1] === "$" ? 2 : 1;
      const mode: "inline" | "block" = delimLen === 2 ? "block" : "inline";

      if (inMathMode === mode) {
        pairs.push({
          startLine: pairStartLine + 1,
          startCol: pairStartCol + 1,
          endLine: i + 1,
          endCol: j + delimLen
        });
        inMathMode = null;
      } else if (!inMathMode) {
        inMathMode = mode;
        pairStartLine = i;
        pairStartCol = j;
      }

      j += delimLen - 1;
    }
  }

  return pairs;
}

export function scanMarkdownMathLine(
  line: string,
  previousState: MarkdownMathContextState
): MarkdownMathScanResult {
  const inFenceMarker = previousState.inFenceMarker;
  const mathRanges: MarkdownMathRange[] = [];
  const fenceMarker = getFenceMarker(line);

  if (fenceMarker) {
    if (inFenceMarker === fenceMarker) {
      return {
        mathRanges,
        nextState: {
          inFenceMarker: null,
          inMath: previousState.inMath
        }
      };
    }

    if (!inFenceMarker && !previousState.inMath) {
      return {
        mathRanges,
        nextState: {
          inFenceMarker: fenceMarker,
          inMath: null
        }
      };
    }
  }

  if (inFenceMarker) {
    return {
      mathRanges,
      nextState: {
        inFenceMarker,
        inMath: previousState.inMath
      }
    };
  }

  let inlineCodeDelimiterLength = 0;
  let activeMathMode = previousState.inMath;
  let activeMathStartIndex = activeMathMode ? 0 : -1;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];

    if (character === "\\") {
      index += 1;
      continue;
    }

    if (!activeMathMode && character === "`") {
      let runLength = 1;
      while (line[index + runLength] === "`") {
        runLength += 1;
      }

      if (inlineCodeDelimiterLength === 0) {
        inlineCodeDelimiterLength = runLength;
      } else if (inlineCodeDelimiterLength === runLength) {
        inlineCodeDelimiterLength = 0;
      }

      index += runLength - 1;
      continue;
    }

    if (inlineCodeDelimiterLength > 0 || character !== "$") {
      continue;
    }

    const delimiterLength = line[index + 1] === "$" ? 2 : 1;
    const nextMathMode: MarkdownMathMode = delimiterLength === 2 ? "block" : "inline";

    if (activeMathMode === nextMathMode) {
      mathRanges.push({
        endIndex: index + delimiterLength,
        mode: nextMathMode,
        startIndex: Math.max(0, activeMathStartIndex)
      });
      activeMathMode = null;
      activeMathStartIndex = -1;
    } else if (!activeMathMode) {
      activeMathMode = nextMathMode;
      activeMathStartIndex = index;
    }

    index += delimiterLength - 1;
  }

  if (activeMathMode) {
    mathRanges.push({
      endIndex: line.length,
      mode: activeMathMode,
      startIndex: Math.max(0, activeMathStartIndex)
    });
  }

  return {
    mathRanges,
    nextState: {
      inFenceMarker,
      inMath: activeMathMode
    }
  };
}

export interface MarkdownMathToken {
  scopes: string;
  startIndex: number;
}

function pushToken(tokens: MarkdownMathToken[], startIndex: number, scopes: string) {
  const lastToken = tokens[tokens.length - 1];
  if (lastToken && lastToken.scopes === scopes) {
    return;
  }

  tokens.push({ scopes, startIndex });
}

/** Classifies a LaTeX fragment without depending on an editor engine. */
export function tokenizeLatexMathFragment(
  fragment: string,
  startIndex = 0
): MarkdownMathToken[] {
  const tokens: MarkdownMathToken[] = [];
  let index = 0;

  while (index < fragment.length) {
    const remaining = fragment.slice(index);

    if (remaining.startsWith("$$")) {
      pushToken(tokens, startIndex + index, "keyword");
      index += 2;
      continue;
    }

    if (remaining.startsWith("$")) {
      pushToken(tokens, startIndex + index, "keyword");
      index += 1;
      continue;
    }

    const whitespaceMatch = /^\s+/.exec(remaining);
    if (whitespaceMatch) {
      pushToken(tokens, startIndex + index, "");
      index += whitespaceMatch[0].length;
      continue;
    }

    const commentMatch = /^%.*$/.exec(remaining);
    if (commentMatch) {
      pushToken(tokens, startIndex + index, "comment");
      break;
    }

    const commandMatch = /^\\(?:[A-Za-z]+|.)/.exec(remaining);
    if (commandMatch) {
      pushToken(tokens, startIndex + index, "keyword");
      index += commandMatch[0].length;
      continue;
    }

    const numberMatch = /^\d+(?:\.\d+)?/.exec(remaining);
    if (numberMatch) {
      pushToken(tokens, startIndex + index, "number");
      index += numberMatch[0].length;
      continue;
    }

    const delimiterMatch = /^(?:<=|>=|!=|==|&&|\|\||[<>=+\-*/^_&|:,;.!?])/.exec(remaining);
    if (delimiterMatch) {
      pushToken(tokens, startIndex + index, "delimiter");
      index += delimiterMatch[0].length;
      continue;
    }

    const bracketMatch = /^(?:\[|\]|[{}()])/.exec(remaining);
    if (bracketMatch) {
      pushToken(tokens, startIndex + index, "delimiter");
      index += bracketMatch[0].length;
      continue;
    }

    const identifierMatch = /^[A-Za-z]+/.exec(remaining);
    if (identifierMatch) {
      pushToken(tokens, startIndex + index, "type");
      index += identifierMatch[0].length;
      continue;
    }

    pushToken(tokens, startIndex + index, "type");
    index += 1;
  }

  if (tokens.length === 0) {
    tokens.push({ scopes: "", startIndex });
  }

  return tokens;
}
