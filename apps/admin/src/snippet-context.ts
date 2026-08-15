import {
  createInitialMarkdownMathContextState,
  scanMarkdownMathLine,
  type MathPair
} from "./markdown-math-scanner";
import type { SnippetLanguageId } from "./workbench/types";

export function getSnippetLanguageAtOffset(text: string, offset: number): SnippetLanguageId {
  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const inspectedText = text.slice(0, safeOffset);
  const lines = inspectedText.split("\n");
  let state = createInitialMarkdownMathContextState();

  for (const line of lines) {
    state = scanMarkdownMathLine(line, state).nextState;
  }

  return state.inMath ? "latex" : "markdown";
}

export function getSnippetLanguageFromMathPairs(
  pairs: readonly MathPair[],
  line: number,
  col: number
): SnippetLanguageId {
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
      return "latex";
    }
  }

  return "markdown";
}
