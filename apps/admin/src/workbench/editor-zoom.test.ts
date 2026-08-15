import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_EDITOR_FONT_SIZE,
  EDITOR_ZOOM_STORAGE_KEY,
  MAX_EDITOR_FONT_SIZE,
  MIN_EDITOR_FONT_SIZE,
  clampEditorFontSize,
  getEditorZoomAction,
  nextEditorFontSize,
  parseStoredEditorFontSize,
  persistEditorFontSize,
  readEditorFontSize
} from "./editor-zoom";

test("clampEditorFontSize enforces readable bounds and integer pixels", () => {
  assert.equal(clampEditorFontSize(Number.NaN), DEFAULT_EDITOR_FONT_SIZE);
  assert.equal(clampEditorFontSize(MIN_EDITOR_FONT_SIZE - 5), MIN_EDITOR_FONT_SIZE);
  assert.equal(clampEditorFontSize(MAX_EDITOR_FONT_SIZE + 5), MAX_EDITOR_FONT_SIZE);
  assert.equal(clampEditorFontSize(15.6), 16);
});

test("getEditorZoomAction recognizes Ctrl/Cmd zoom keys only", () => {
  assert.equal(getEditorZoomAction({ ctrlKey: true, key: "+" }), "increase");
  assert.equal(getEditorZoomAction({ metaKey: true, key: "=" }), "increase");
  assert.equal(getEditorZoomAction({ ctrlKey: true, code: "NumpadSubtract", key: "-" }), "decrease");
  assert.equal(getEditorZoomAction({ metaKey: true, code: "Digit0", key: "0" }), "reset");
  assert.equal(getEditorZoomAction({ key: "+" }), null);
  assert.equal(getEditorZoomAction({ ctrlKey: true, altKey: true, key: "-" }), null);
});

test("nextEditorFontSize applies one-step changes and reset", () => {
  assert.equal(nextEditorFontSize(14, "increase"), 15);
  assert.equal(nextEditorFontSize(14, "decrease"), 13);
  assert.equal(nextEditorFontSize(10, "decrease"), 10);
  assert.equal(nextEditorFontSize(28, "increase"), 28);
  assert.equal(nextEditorFontSize(22, "reset"), DEFAULT_EDITOR_FONT_SIZE);
});

test("stored font sizes are parsed safely and persisted under the editor key", () => {
  assert.equal(parseStoredEditorFontSize(null), DEFAULT_EDITOR_FONT_SIZE);
  assert.equal(parseStoredEditorFontSize("not-a-size"), DEFAULT_EDITOR_FONT_SIZE);
  assert.equal(parseStoredEditorFontSize("999"), MAX_EDITOR_FONT_SIZE);

  let storedValue: string | null = null;
  const storage = {
    getItem: (key: string) => (key === EDITOR_ZOOM_STORAGE_KEY ? storedValue : null),
    setItem: (key: string, value: string) => {
      assert.equal(key, EDITOR_ZOOM_STORAGE_KEY);
      storedValue = value;
    }
  };

  assert.equal(persistEditorFontSize(19, storage), 19);
  assert.equal(storedValue, "19");
  assert.equal(readEditorFontSize(storage), 19);
});
