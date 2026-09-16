import assert from "node:assert/strict";
import test from "node:test";

import { classifyLatexMathFragment } from "./cm-math-highlight";

test("classifyLatexMathFragment maps tokenizer scopes to cm-mtok spans", () => {
  const spans = classifyLatexMathFragment("\\alpha x_1^2$");

  assert.deepEqual(spans, [
    { className: "cm-mtok-keyword", from: 0, to: 6 },
    { className: "cm-mtok-type", from: 7, to: 8 },
    { className: "cm-mtok-delimiter", from: 8, to: 9 },
    { className: "cm-mtok-number", from: 9, to: 10 },
    { className: "cm-mtok-delimiter", from: 10, to: 11 },
    { className: "cm-mtok-number", from: 11, to: 12 },
    { className: "cm-mtok-keyword", from: 12, to: 13 }
  ]);
});

test("classifyLatexMathFragment classifies comments to end of fragment", () => {
  const spans = classifyLatexMathFragment("x % rest of line");

  assert.deepEqual(spans, [
    { className: "cm-mtok-type", from: 0, to: 1 },
    { className: "cm-mtok-comment", from: 2, to: 16 }
  ]);
});

test("classifyLatexMathFragment skips whitespace-only and empty fragments", () => {
  assert.deepEqual(classifyLatexMathFragment(""), []);
  assert.deepEqual(classifyLatexMathFragment("  \n "), []);
});

test("classifyLatexMathFragment handles block math delimiters and newlines", () => {
  const spans = classifyLatexMathFragment("$$\n\\int_0^1 x\n$$");

  assert.deepEqual(spans[0], { className: "cm-mtok-keyword", from: 0, to: 2 });
  assert.deepEqual(spans[spans.length - 1], {
    className: "cm-mtok-keyword",
    from: 14,
    to: 16
  });
  assert.ok(spans.some((span) => span.className === "cm-mtok-number" && span.from === 8 && span.to === 9));
});
