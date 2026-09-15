import assert from "node:assert/strict";
import test from "node:test";

import { EditorState, type TransactionSpec } from "@codemirror/state";

import { scanDocumentMathPairs } from "../../markdown-math-scanner";
import { getSnippetLanguageFromMathPairs } from "../../snippet-context";
import {
  cmMathContextExtension,
  cmMathContextField,
  computeCmMathLineStates,
  getCmMathLanguageAt
} from "./cm-math-context";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function referenceLanguage(text: string, lineNumber: number, col: number) {
  return getSnippetLanguageFromMathPairs(scanDocumentMathPairs(text), lineNumber, col);
}

function assertMatchesReference(text: string) {
  const state = EditorState.create({ doc: text, extensions: [cmMathContextExtension] });
  const docLen = text.length;
  for (let offset = 0; offset <= docLen; offset += 1) {
    const safeOffset = Math.min(offset, Math.max(docLen, 0));
    const line = state.doc.lineAt(safeOffset);
    const col = safeOffset - line.from + 1;
    assert.equal(
      getCmMathLanguageAt(state, offset),
      referenceLanguage(text, line.number, col),
      `text=${JSON.stringify(text)} offset=${offset}`
    );
  }
}

function assertFieldEqualsCompute(state: EditorState) {
  const field = state.field(cmMathContextField);
  const computed = computeCmMathLineStates(state.doc);
  assert.equal(field.length, computed.length);
  for (let k = 0; k < field.length; k += 1) {
    assert.equal(field[k].inFenceMarker, computed[k].inFenceMarker, `index=${k} inFenceMarker`);
    assert.equal(field[k].inMath, computed[k].inMath, `index=${k} inMath`);
  }
}

// Seeded PRNG (mulberry32)
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = [
  "", "a", "bb", "$", "$$", "`", "``", "```", "```ts", "$a$",
  "x $b$ y", "\\$", "c \\$ d", "$$block", "text", "```", "~~~",
  "$open", "$$x", "a$ b", "# heading"
];

// ---------------------------------------------------------------------------
// 1. Handcrafted docs, exhaustive offsets
// ---------------------------------------------------------------------------

test("cmMathContext — handcrafted docs exhaustive offsets", () => {
  const docs = [
    "",
    "a",
    "$",
    "$$",
    "$a$",
    "a $x$ b",
    "$a",
    "$$a$$",
    "$$a",
    "$a\nb$",
    "$a\nb",
    "`$x$`",
    "` $ `x` $ `",
    "```\n$x$\n```",
    "```js\nconst a = '$x$'\n```",
    "~~~\n$x$\n~~~",
    "\\$x\\$",
    "$a$ $b",
    "$a$\n$b",
    "$a $$b$$ c$",
    "$a$\ntext\n$ b$",
    "$\n$",
    "````\n$\n```",
    "$``$`",
    "text $x$ more $$y$$ tail"
  ];

  for (const doc of docs) {
    assertMatchesReference(doc);
  }
});

// ---------------------------------------------------------------------------
// 1b. Replace-all transactions (exercises update + defensive branch)
// ---------------------------------------------------------------------------

test("cmMathContext — replace-all transaction (small -> large)", () => {
  const startState = EditorState.create({
    doc: "$a",
    extensions: [cmMathContextExtension]
  });
  const state = startState.update({
    changes: { from: 0, to: 2, insert: "text $x$ more $$y$$ tail" }
  }).state;
  const text = "text $x$ more $$y$$ tail";
  for (let offset = 0; offset <= text.length; offset += 1) {
    const line = state.doc.lineAt(Math.min(offset, text.length));
    const col = Math.min(offset, text.length) - line.from + 1;
    assert.equal(
      getCmMathLanguageAt(state, offset),
      referenceLanguage(text, line.number, col),
      `offset=${offset}`
    );
  }
});

test("cmMathContext — replace-all transaction (large -> small)", () => {
  const startState = EditorState.create({
    doc: "$a\nb$",
    extensions: [cmMathContextExtension]
  });
  const state = startState.update({
    changes: { from: 0, to: 5, insert: "x" }
  }).state;
  const text = "x";
  for (let offset = 0; offset <= text.length; offset += 1) {
    const line = state.doc.lineAt(Math.min(offset, text.length));
    const col = Math.min(offset, text.length) - line.from + 1;
    assert.equal(
      getCmMathLanguageAt(state, offset),
      referenceLanguage(text, line.number, col),
      `offset=${offset}`
    );
  }
});

// ---------------------------------------------------------------------------
// 2. Incremental updates on a rich doc
// ---------------------------------------------------------------------------

test("cmMathContext — incremental updates", () => {
  const richDoc = [
    "Paragraph one with some text.",
    "",
    "```",
    "fence content",
    "```",
    "",
    "Here is $x$ inline math and $y$ more.",
    "",
    "$$",
    "block math",
    "line two",
    "$$",
    "",
    "`code $x$ here` and text",
    "",
    "unclosed $z"
  ].join("\n");

  let state = EditorState.create({
    doc: richDoc,
    extensions: [cmMathContextExtension]
  });

  const TXNS: Array<{ label: string; changes: TransactionSpec }> = [
    {
      label: "type one char mid-paragraph",
      changes: { changes: { from: 10, insert: "X" } }
    },
    {
      label: "insert newline",
      changes: { changes: { from: 20, insert: "\n" } }
    },
    {
      label: "delete a $ that opens a pair",
      changes: { changes: { from: richDoc.indexOf("$x$"), to: richDoc.indexOf("$x$") + 1, insert: "" } }
    },
    {
      label: "paste a 3-line block with math",
      changes: { changes: { from: 5, insert: "$$\nz\n$$" } }
    },
    {
      label: "delete a newline",
      changes: { changes: { from: 7, to: 8, insert: "" } }
    },
    {
      label: "edit a line inside the fence",
      changes: { changes: { from: richDoc.indexOf("fence content"), to: richDoc.indexOf("fence content") + "fence content".length, insert: "edited fence" } }
    },
    {
      label: "edit a line ABOVE the math block",
      changes: { changes: { from: 2, to: 2, insert: "NEW" } }
    },
    {
      label: "two separate single-char edits in one transaction",
      changes: { changes: [{ from: 1, insert: "A" }, { from: 50, insert: "B" }] }
    },
    {
      label: "replace-all with completely different doc",
      changes: { changes: { from: 0, to: state.doc.length, insert: "$new$ doc" } }
    }
  ];

  for (const { label, changes } of TXNS) {
    state = state.update(changes).state;
    assertFieldEqualsCompute(state);

    const docStr = state.doc.toString();
    const docLen = docStr.length;
    // Check 30 spread offsets
    const offsets: number[] = [];
    if (docLen <= 30) {
      for (let o = 0; o <= docLen; o += 1) offsets.push(o);
    } else {
      for (let o = 0; o <= docLen; o += Math.max(1, Math.floor(docLen / 30))) {
        offsets.push(o);
      }
      if (offsets[offsets.length - 1] !== docLen) offsets.push(docLen);
    }
    for (const offset of offsets) {
      const safeOffset = Math.min(offset, docLen);
      const line = state.doc.lineAt(safeOffset);
      const col = safeOffset - line.from + 1;
      assert.equal(
        getCmMathLanguageAt(state, offset),
        referenceLanguage(docStr, line.number, col),
        `${label}: offset=${offset}`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 3. Randomized property test
// ---------------------------------------------------------------------------

test("cmMathContext — randomized property test", () => {
  const rng = mulberry32(0xC0FFEE);

  function randomToken(): string {
    return TOKENS[Math.floor(rng() * TOKENS.length)];
  }

  function generateDoc(): string {
    const lineCount = 5 + Math.floor(rng() * 36); // 5..40
    const lines: string[] = [];
    for (let i = 0; i < lineCount; i += 1) {
      const tokens = randomToken();
      // Occasionally add a second token with a space separator
      if (rng() > 0.6) {
        lines.push(tokens + " " + randomToken());
      } else {
        lines.push(tokens);
      }
    }
    return lines.join("\n");
  }

  const MAX_FULL_LEN = 2000;
  const SAMPLE_COUNT = 300;
  const EDIT_SAMPLE_COUNT = 40;

  for (let docIdx = 0; docIdx < 40; docIdx += 1) {
    const text = generateDoc();
    let state = EditorState.create({ doc: text, extensions: [cmMathContextExtension] });
    const docLen = text.length;

    // Exhaustive or sampled comparison
    if (docLen <= MAX_FULL_LEN) {
      for (let offset = 0; offset <= docLen; offset += 1) {
        const line = state.doc.lineAt(Math.min(offset, docLen));
        const col = Math.min(offset, docLen) - line.from + 1;
        assert.equal(
          getCmMathLanguageAt(state, offset),
          referenceLanguage(text, line.number, col),
          `docIdx=${docIdx} text=${JSON.stringify(text)} offset=${offset}`
        );
      }
    } else {
      for (let s = 0; s < SAMPLE_COUNT; s += 1) {
        const offset = Math.floor(rng() * (docLen + 1));
        const line = state.doc.lineAt(offset);
        const col = offset - line.from + 1;
        assert.equal(
          getCmMathLanguageAt(state, offset),
          referenceLanguage(text, line.number, col),
          `docIdx=${docIdx} (sampled) text=${JSON.stringify(text)} offset=${offset}`
        );
      }
    }

    // 15 random edits
    for (let editIdx = 0; editIdx < 15; editIdx += 1) {
      const oldLen = state.doc.length;
      const from = Math.floor(rng() * (oldLen + 1));
      const maxTo = Math.min(oldLen, from + 12);
      const to = from + Math.floor(rng() * (maxTo - from + 1));
      const insert = rng() > 0.1 ? randomToken() : "";
      let insertText = insert;
      // Occasionally make it multi-line
      if (rng() > 0.7 && insert.length > 0) {
        insertText = insert + "\n" + randomToken();
      }

      state = state.update({ changes: { from, to, insert: insertText } }).state;

      // Field must match full recompute
      assertFieldEqualsCompute(state);

      // Sampled offset comparison
      const newDocStr = state.doc.toString();
      const newLen = state.doc.length;
      for (let s = 0; s < EDIT_SAMPLE_COUNT; s += 1) {
        const offset = Math.floor(rng() * (newLen + 1));
        const line = state.doc.lineAt(offset);
        const col = offset - line.from + 1;
        assert.equal(
          getCmMathLanguageAt(state, offset),
          referenceLanguage(newDocStr, line.number, col),
          `docIdx=${docIdx} editIdx=${editIdx} offset=${offset} insertText=${JSON.stringify(insertText)} from=${from} to=${to}`
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Fallback path — no field installed
// ---------------------------------------------------------------------------

test("cmMathContext — fallback without field", () => {
  const state = EditorState.create({ doc: "$a$ x" });
  assert.equal(getCmMathLanguageAt(state, 2), "latex");
  assert.equal(getCmMathLanguageAt(state, 5), "markdown");
});