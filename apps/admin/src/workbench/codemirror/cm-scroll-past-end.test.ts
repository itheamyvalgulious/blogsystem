import assert from "node:assert/strict";
import test from "node:test";

import {
  computeScrollPastEndPadding,
  type ScrollPastEndMeasurements
} from "./cm-scroll-past-end";

function measurements(overrides: Partial<ScrollPastEndMeasurements> = {}): ScrollPastEndMeasurements {
  return {
    contentHeight: 2000,
    editorHeight: 800,
    lineHeight: 21,
    paddingTop: 8,
    ...overrides
  };
}

test("scrollable editors get a one-viewport bottom blank (last line can reach the top)", () => {
  // Mirrors the built-in scrollPastEnd formula: viewport − one line − top padding − 0.5.
  assert.equal(computeScrollPastEndPadding(measurements()), 800 - 21 - 8 - 0.5);
});

test("fixed-height editors are padded even while the content is shorter than the viewport", () => {
  // An empty/short document must already carry the bottom blank, so a tall
  // below-source preview collapsing during typing can never clamp scrollTop.
  assert.equal(computeScrollPastEndPadding(measurements({ contentHeight: 16 })), 770.5);
});

test("content-sized editors (auto-height scrollers) never get padding", () => {
  // The embedded project editors: the scroller IS its content. Padding would
  // grow the editor itself and diverge across measure cycles.
  assert.equal(computeScrollPastEndPadding(measurements({ contentHeight: 345.6, editorHeight: 346 })), null);
  assert.equal(computeScrollPastEndPadding(measurements({ contentHeight: 800, editorHeight: 800 })), null);
});

test("content-sized detection tolerance covers clientHeight rounding only", () => {
  assert.equal(computeScrollPastEndPadding(measurements({ contentHeight: 799, editorHeight: 800 })), null);
  assert.equal(
    computeScrollPastEndPadding(measurements({ contentHeight: 798.4, editorHeight: 800 })),
    770.5
  );
});

test("editors shorter than one line get no padding", () => {
  assert.equal(computeScrollPastEndPadding(measurements({ editorHeight: 10 })), null);
});

test("pre-measure state (zero heights) is treated as content-sized", () => {
  assert.equal(computeScrollPastEndPadding(measurements({ editorHeight: 0, contentHeight: 0 })), null);
});
