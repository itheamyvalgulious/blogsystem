import assert from "node:assert/strict";
import test from "node:test";

import {
  createInitialMarkdownMathContextState,
  scanMarkdownMathLine,
  tokenizeLatexMathFragment
} from "./markdown-math-scanner";

function getTokenScopeAtOffset(
  tokens: ReturnType<typeof tokenizeLatexMathFragment>,
  offset: number
) {
  let scope = tokens[0]?.scopes ?? "";

  for (const token of tokens) {
    if (token.startIndex > offset) {
      break;
    }

    scope = token.scopes;
  }

  return scope;
}

test("scanMarkdownMathLine tracks fenced math blocks without entering fenced code", () => {
  const openedBlock = scanMarkdownMathLine("$$", createInitialMarkdownMathContextState());
  assert.deepEqual(openedBlock.mathRanges, [{ endIndex: 2, mode: "block", startIndex: 0 }]);
  assert.equal(openedBlock.nextState.inMath, "block");

  const insideBlock = scanMarkdownMathLine("\\text{exact } a_{n+1}<a_n", openedBlock.nextState);
  assert.deepEqual(insideBlock.mathRanges, [
    { endIndex: "\\text{exact } a_{n+1}<a_n".length, mode: "block", startIndex: 0 }
  ]);
  assert.equal(insideBlock.nextState.inMath, "block");

  const fencedCode = scanMarkdownMathLine("```ts", createInitialMarkdownMathContextState());
  assert.equal(fencedCode.nextState.inFenceMarker, "```");
  assert.equal(fencedCode.mathRanges.length, 0);

  const ignoredInFence = scanMarkdownMathLine("const price = '$$';", fencedCode.nextState);
  assert.equal(ignoredInFence.mathRanges.length, 0);
  assert.equal(ignoredInFence.nextState.inFenceMarker, "```");
});

test("tokenizeLatexMathFragment keeps math operators out of markdown html styling", () => {
  const source = "\\text{exact } a_{n+1}<a_n";
  const tokens = tokenizeLatexMathFragment(source);
  const lessThanIndex = source.indexOf("<");
  const textCommandIndex = source.indexOf("\\text");

  assert.equal(getTokenScopeAtOffset(tokens, textCommandIndex), "keyword");
  assert.equal(getTokenScopeAtOffset(tokens, lessThanIndex), "delimiter");
  assert.equal(tokens.some((token) => token.scopes.includes("tag")), false);
});
