import assert from "node:assert/strict";
import test from "node:test";

import type { ThemeDefinition } from "../types";
import { resolveCmThemeColors } from "./cm-theme";

function makeTheme(overrides: Partial<ThemeDefinition["monacoTheme"]>): ThemeDefinition {
  return {
    appearance: "dark",
    cssVariables: {},
    id: "test-theme",
    label: "Test Theme",
    monacoTheme: {
      base: "vs-dark",
      colors: {},
      inherit: true,
      rules: [],
      ...overrides
    }
  };
}

test("resolveCmThemeColors maps base to dark/light flag", () => {
  assert.equal(resolveCmThemeColors(makeTheme({ base: "vs-dark" })).isDark, true);
  assert.equal(resolveCmThemeColors(makeTheme({ base: "hc-black" })).isDark, true);
  assert.equal(resolveCmThemeColors(makeTheme({ base: "vs" })).isDark, false);
  assert.equal(resolveCmThemeColors(makeTheme({ base: "hc-light" })).isDark, false);
});

test("resolveCmThemeColors normalizes colors with and without '#'", () => {
  const colors = resolveCmThemeColors(
    makeTheme({
      colors: {
        "editor.background": "253340",
        "editor.foreground": "#d8dee9",
        "editor.selectionBackground": "#3f556480",
        "editorCursor.foreground": "14e2b8",
        "editorLineNumber.foreground": "#587181"
      }
    })
  );

  assert.equal(colors.background, "#253340");
  assert.equal(colors.foreground, "#d8dee9");
  assert.equal(colors.selectionBackground, "#3f556480");
  assert.equal(colors.cursor, "#14e2b8");
  assert.equal(colors.lineNumber, "#587181");
  assert.equal(colors.suggestBackground, undefined);
});

test("resolveCmThemeColors indexes rules by token with default entry", () => {
  const colors = resolveCmThemeColors(
    makeTheme({
      rules: [
        { token: "", foreground: "d8dee9" },
        { token: "keyword", foreground: "8ab5ff", fontStyle: "bold" },
        { token: "comment", foreground: "7f95a6", fontStyle: "italic" }
      ]
    })
  );

  assert.deepEqual(colors.tokens.default, { fontStyle: undefined, foreground: "#d8dee9" });
  assert.deepEqual(colors.tokens.keyword, { fontStyle: "bold", foreground: "#8ab5ff" });
  assert.deepEqual(colors.tokens.comment, { fontStyle: "italic", foreground: "#7f95a6" });
  assert.equal(colors.tokens.number, undefined);
});
