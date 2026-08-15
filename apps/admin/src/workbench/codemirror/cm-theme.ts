import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { Compartment, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

import {
  clampEditorFontSize,
  handleEditorZoomKeydown,
  readEditorFontSize
} from "../editor-zoom";
import type { ThemeDefinition } from "../types";

// The document lines and their gutter elements must use the same line box.
// CodeMirror gives gutter entries explicit pixel heights, so changing the
// font size also needs a fresh measurement after this value takes effect.
export const CM_EDITOR_LINE_HEIGHT = "1.5";

/**
 * CodeMirror theming for the workbench "live" editor engine.
 *
 * Two layers:
 *
 * - `createCmBaseTheme()` — the variable-driven base chrome (colors reference
 *   --wb-* CSS variables), always active as the fallback layer.
 * - `buildCmThemeExtension(themeDef)` — a full conversion of a workbench
 *   `ThemeDefinition.monacoTheme`: `base` drives dark/light, `colors` map to
 *   the editor chrome (background/foreground/cursor/selection/active line/
 *   gutters/widgets/panels), `rules` feed both a lezer `HighlightStyle` for
 *   markdown syntax and the `.cm-mtok-*` math token classes, plus the
 *   `.cm-ai-ghost` inline-completion style.
 *
 * Theme lifecycle mirrors Monaco's defineTheme/setTheme: the persistence
 * hook calls `defineCmTheme(themeDef)` whenever it defines the Monaco theme
 * and `applyCmTheme(id)` when it sets it. Defined extensions live in a
 * registry; `applyCmTheme` reconfigures a shared Compartment in every live
 * CM view (registered by cm-editor). States parked in cm-editor's per-path
 * cache are re-synced on restore via `syncCmThemeToView`.
 *
 * No monaco imports: this module must stay loadable in Node test runs.
 */

export function createCmBaseTheme(): Extension {
  return EditorView.theme({
    "&": {
      backgroundColor: "var(--wb-bg-elevated)",
      color: "var(--wb-foreground)",
      fontFamily: "'Cascadia Code', 'Fira Code', monospace",
      fontSize: "var(--wb-editor-font-size, 14px)",
      height: "100%"
    },
    ".cm-content": {
      caretColor: "var(--wb-accent-strong)",
      lineHeight: CM_EDITOR_LINE_HEIGHT,
      padding: "8px 0"
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--wb-accent-strong)"
    },
    "&.cm-focused": {
      outline: "none"
    },
    // CM's drawSelection base theme targets
    // `.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground`
    // (higher specificity) — selection rules must match that full selector to
    // win. Solid, high-contrast mix: --wb-selection-bg and even a translucent
    // accent mix read nearly invisible on the dark editor surface.
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
      backgroundColor: "color-mix(in srgb, var(--wb-accent) 42%, var(--wb-bg-elevated))"
    },
    "&:not(.cm-focused) > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
      backgroundColor: "color-mix(in srgb, var(--wb-accent) 22%, var(--wb-bg-elevated))"
    },
    ".cm-activeLine": {
      backgroundColor: "color-mix(in srgb, var(--wb-bg-active) 55%, transparent)"
    },
    ".cm-gutters": {
      backgroundColor: "var(--wb-bg-elevated)",
      border: "none",
      color: "var(--wb-foreground-muted)",
      fontSize: "var(--wb-editor-font-size, 14px)",
      lineHeight: CM_EDITOR_LINE_HEIGHT
    },
    ".cm-gutterElement": {
      lineHeight: CM_EDITOR_LINE_HEIGHT
    },
    ".cm-activeLineGutter": {
      backgroundColor: "color-mix(in srgb, var(--wb-bg-active) 55%, transparent)",
      color: "var(--wb-foreground)"
    },
    ".cm-panels": {
      backgroundColor: "var(--wb-bg-panel)",
      color: "var(--wb-foreground)"
    },
    ".cm-panels input, .cm-panels button": {
      backgroundColor: "var(--wb-input-bg)",
      border: "1px solid var(--wb-input-border)",
      color: "var(--wb-foreground)"
    },
    ".cm-searchMatch": {
      backgroundColor: "var(--wb-info-bg)",
      outline: "1px solid var(--wb-accent)"
    },
    ".cm-searchMatch-selected": {
      backgroundColor: "var(--wb-selection-bg)"
    },
    ".cm-tooltip": {
      backgroundColor: "var(--wb-bg-sidebar)",
      border: "1px solid var(--wb-border)",
      color: "var(--wb-foreground)"
    },
    ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
      backgroundColor: "var(--wb-bg-active)",
      color: "var(--wb-foreground)"
    },
    ".cm-ai-ghost": {
      color: "var(--wb-foreground-muted)",
      opacity: "0.55",
      pointerEvents: "none"
    },
    ".cm-mtok-keyword": {
      color: "var(--wb-accent)"
    },
    ".cm-mtok-comment": {
      color: "var(--wb-foreground-muted)"
    },
    ".cm-mtok-number": {
      color: "var(--wb-warning)"
    },
    ".cm-mtok-delimiter": {
      color: "var(--wb-foreground)"
    },
    ".cm-mtok-type": {
      color: "var(--wb-accent-strong)"
    }
  });
}

export interface CmMonacoTokenStyle {
  fontStyle?: string;
  foreground?: string;
}

/** Pure, testable projection of `ThemeDefinition.monacoTheme`. */
export interface CmThemeColors {
  activeIndentGuide?: string;
  activeLineNumber?: string;
  background?: string;
  cursor?: string;
  foreground?: string;
  hoverBackground?: string;
  hoverBorder?: string;
  inactiveSelectionBackground?: string;
  indentGuide?: string;
  isDark: boolean;
  lineHighlight?: string;
  lineNumber?: string;
  selectionBackground?: string;
  suggestBackground?: string;
  suggestBorder?: string;
  suggestSelectedBackground?: string;
  searchMatchBackground?: string;
  searchMatchSelectedBackground?: string;
  /** Keyed by Monaco token name; the empty token is stored as "default". */
  tokens: Record<string, CmMonacoTokenStyle>;
  widgetBackground?: string;
  widgetBorder?: string;
}

/** Monaco theme rules carry hex colors without the leading "#". */
function normalizeMonacoColor(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{3}$/.test(trimmed) || /^[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(trimmed)) {
    return `#${trimmed}`;
  }
  return trimmed;
}

export function resolveCmThemeColors(themeDef: ThemeDefinition): CmThemeColors {
  const monacoTheme = themeDef.monacoTheme;
  const colors = monacoTheme.colors ?? {};
  const pick = (key: string): string | undefined => normalizeMonacoColor(colors[key]);

  const tokens: Record<string, CmMonacoTokenStyle> = {};
  for (const rule of monacoTheme.rules ?? []) {
    tokens[rule.token || "default"] = {
      fontStyle: rule.fontStyle,
      foreground: normalizeMonacoColor(rule.foreground)
    };
  }

  return {
    activeIndentGuide: pick("editorIndentGuide.activeBackground1"),
    activeLineNumber: pick("editorLineNumber.activeForeground"),
    background: pick("editor.background"),
    cursor: pick("editorCursor.foreground"),
    foreground: pick("editor.foreground"),
    hoverBackground: pick("editorHoverWidget.background"),
    hoverBorder: pick("editorHoverWidget.border"),
    inactiveSelectionBackground: pick("editor.inactiveSelectionBackground"),
    indentGuide: pick("editorIndentGuide.background1"),
    isDark: monacoTheme.base !== "vs" && monacoTheme.base !== "hc-light",
    lineHighlight: pick("editor.lineHighlightBackground"),
    lineNumber: pick("editorLineNumber.foreground"),
    selectionBackground: pick("editor.selectionBackground"),
    suggestBackground: pick("editorSuggestWidget.background"),
    suggestBorder: pick("editorSuggestWidget.border"),
    suggestSelectedBackground: pick("editorSuggestWidget.selectedBackground"),
    searchMatchBackground: pick("editor.findMatchHighlightBackground"),
    searchMatchSelectedBackground: pick("editor.findMatchBackground"),
    tokens,
    widgetBackground: pick("editorWidget.background"),
    widgetBorder: pick("editorWidget.border")
  };
}

interface CmFontStyleFlags {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  underline: boolean;
}

function parseMonacoFontStyle(fontStyle: string | undefined): CmFontStyleFlags {
  const parts = (fontStyle ?? "").toLowerCase().split(/\s+/);
  return {
    bold: parts.includes("bold"),
    italic: parts.includes("italic"),
    strike: parts.includes("strikethrough"),
    underline: parts.includes("underline")
  };
}

function buildSyntaxHighlightStyle(colors: CmThemeColors): Extension {
  const tokenColor = (name: string, cssVariable: string): string =>
    colors.tokens[name]?.foreground ?? `var(${cssVariable})`;
  // Monaco rule fontStyle ("bold"/"italic"/"underline"/"strikethrough")
  // merges into the lezer tag style on top of each tag's semantic default.
  const fontStyleProps = (name: string): Record<string, string> => {
    const flags = parseMonacoFontStyle(colors.tokens[name]?.fontStyle);
    const props: Record<string, string> = {};
    if (flags.bold) {
      props.fontWeight = "bold";
    }
    if (flags.italic) {
      props.fontStyle = "italic";
    }
    if (flags.underline) {
      props.textDecoration = "underline";
    }
    if (flags.strike) {
      props.textDecoration = "line-through";
    }
    return props;
  };

  const keyword = tokenColor("keyword", "--wb-accent");
  const comment = tokenColor("comment", "--wb-foreground-muted");
  const number = tokenColor("number", "--wb-warning");
  const string = tokenColor("string", "--wb-accent-strong");
  const delimiter = tokenColor("delimiter", "--wb-foreground-muted");
  const type = tokenColor("type", "--wb-accent-strong");
  const tagColor = tokenColor("tag", "--wb-danger");

  const style = HighlightStyle.define([
    // No heading rules on purpose: lezer parses an unclosed `$$` block
    // followed by a `==`/`--` line as SetextHeading, and coloring lezer
    // heading tags would paint that math content as a heading. Heading
    // display (color/size/weight) is owned by the live-preview line
    // decorations (.cm-lp-h1..h6), colored in buildChromeTheme below.
    { color: keyword, fontWeight: "bold", ...fontStyleProps("keyword"), tag: tags.strong },
    { color: string, fontStyle: "italic", ...fontStyleProps("string"), tag: tags.emphasis },
    {
      color: comment,
      textDecoration: "line-through",
      ...fontStyleProps("comment"),
      tag: tags.strikethrough
    },
    { color: type, ...fontStyleProps("type"), tag: tags.link },
    { color: type, textDecoration: "underline", ...fontStyleProps("type"), tag: tags.url },
    { color: comment, fontStyle: "italic", ...fontStyleProps("comment"), tag: tags.quote },
    { color: string, ...fontStyleProps("string"), tag: tags.monospace },
    { color: delimiter, ...fontStyleProps("delimiter"), tag: tags.processingInstruction },
    { color: comment, ...fontStyleProps("comment"), tag: tags.comment },
    { color: tagColor, ...fontStyleProps("tag"), tag: tags.labelName },
    { color: number, ...fontStyleProps("number"), tag: tags.atom },
    { color: delimiter, ...fontStyleProps("delimiter"), tag: [tags.meta, tags.contentSeparator] },
    { color: keyword, ...fontStyleProps("keyword"), tag: [tags.escape, tags.character] },
    // Nested code fences (markdown codeLanguages): common syntax tags → the
    // same theme tokens. Parent tags cover their subtags (tags.keyword also
    // styles controlKeyword/operatorKeyword, tags.number integer/float, …).
    { color: keyword, tag: [tags.keyword, tags.modifier] },
    { color: string, tag: tags.string },
    { color: number, tag: tags.number },
    {
      color: type,
      tag: [tags.typeName, tags.className, tags.namespace, tags.function(tags.variableName)]
    },
    { color: tagColor, tag: [tags.propertyName, tags.attributeName] },
    { color: delimiter, tag: [tags.operator, tags.punctuation] }
  ]);
  return syntaxHighlighting(style);
}

function buildChromeTheme(colors: CmThemeColors): Extension {
  const tokenColor = (name: string, cssVariable: string): string =>
    colors.tokens[name]?.foreground ?? `var(${cssVariable})`;

  return EditorView.theme(
    {
      "&": {
        backgroundColor: colors.background ?? "var(--wb-bg-elevated)",
        color: colors.foreground ?? "var(--wb-foreground)"
      },
      ".cm-content": {
        caretColor: colors.cursor ?? "var(--wb-accent-strong)"
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: colors.cursor ?? "var(--wb-accent-strong)"
      },
      // See createCmBaseTheme for why the full drawSelection selector is
      // required (CM's own base theme wins shorter selectors on specificity).
      // Unconditional solid mix: monaco themes ship translucent selection
      // colors (e.g. eva-dark #3f556480) that measure nearly invisible.
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, var(--wb-accent) 42%, var(--wb-bg-elevated))"
      },
      "&:not(.cm-focused) > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
        backgroundColor: "color-mix(in srgb, var(--wb-accent) 22%, var(--wb-bg-elevated))"
      },
      ".cm-activeLine": {
        backgroundColor:
          colors.lineHighlight ?? "color-mix(in srgb, var(--wb-bg-active) 55%, transparent)"
      },
      ".cm-gutters": {
        backgroundColor: colors.background ?? "var(--wb-bg-elevated)",
        color: colors.lineNumber ?? "var(--wb-foreground-muted)"
      },
      ".cm-activeLineGutter": {
        backgroundColor:
          colors.lineHighlight ?? "color-mix(in srgb, var(--wb-bg-active) 55%, transparent)",
        color: colors.activeLineNumber ?? colors.foreground ?? "var(--wb-foreground)"
      },
      ".cm-panels": {
        backgroundColor: colors.widgetBackground ?? "var(--wb-bg-panel)",
        color: colors.foreground ?? "var(--wb-foreground)"
      },
      ".cm-searchMatch": {
        backgroundColor: colors.searchMatchBackground ?? "var(--wb-info-bg)",
        outline: "1px solid var(--wb-accent)"
      },
      ".cm-searchMatch-selected": {
        backgroundColor: colors.searchMatchSelectedBackground ?? "var(--wb-selection-bg)"
      },
      ".cm-tooltip": {
        backgroundColor: colors.widgetBackground ?? "var(--wb-bg-sidebar)",
        border: `1px solid ${colors.widgetBorder ?? "var(--wb-border)"}`,
        color: colors.foreground ?? "var(--wb-foreground)"
      },
      ".cm-tooltip.cm-tooltip-autocomplete": {
        backgroundColor: colors.suggestBackground ?? colors.widgetBackground ?? "var(--wb-bg-sidebar)",
        border: `1px solid ${colors.suggestBorder ?? colors.widgetBorder ?? "var(--wb-border)"}`
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: colors.suggestSelectedBackground ?? "var(--wb-bg-active)",
        color: colors.foreground ?? "var(--wb-foreground)"
      },
      ".cm-tooltip.cm-tooltip-hover": {
        backgroundColor: colors.hoverBackground ?? colors.widgetBackground ?? "var(--wb-bg-sidebar)",
        border: `1px solid ${colors.hoverBorder ?? colors.widgetBorder ?? "var(--wb-border)"}`
      },
      ".cm-ai-ghost": {
        color: colors.tokens.comment?.foreground ?? "var(--wb-foreground-muted)",
        opacity: "0.55",
        pointerEvents: "none"
      },
      ".cm-mtok-keyword": {
        color: tokenColor("keyword", "--wb-accent")
      },
      ".cm-mtok-comment": {
        color: tokenColor("comment", "--wb-foreground-muted")
      },
      ".cm-mtok-number": {
        color: tokenColor("number", "--wb-warning")
      },
      ".cm-mtok-delimiter": {
        color: tokenColor("delimiter", "--wb-foreground")
      },
      ".cm-mtok-type": {
        color: tokenColor("type", "--wb-accent-strong")
      },
      // Heading color lives on the live-preview line decorations (see the
      // comment in buildSyntaxHighlightStyle); size/weight stay in
      // styles.css .cm-lp-h*, which also carries the fallback color.
      ".cm-lp-h1, .cm-lp-h2, .cm-lp-h3, .cm-lp-h4, .cm-lp-h5, .cm-lp-h6": {
        color: tokenColor("keyword", "--wb-accent")
      }
    },
    { dark: colors.isDark }
  );
}

export function buildCmThemeExtension(themeDef: ThemeDefinition): Extension {
  const colors = resolveCmThemeColors(themeDef);
  return [buildSyntaxHighlightStyle(colors), buildChromeTheme(colors)];
}

// --- registry / live-view reconfiguration ----------------------------------

const cmThemeCompartment = new Compartment();
// Reconfiguring this theme compartment marks CodeMirror's line geometry as
// stale. Merely changing an inline CSS variable does not do that when the
// editor's overall DOM height remains unchanged.
const cmFontMeasureCompartment = new Compartment();
const definedCmThemes = new Map<string, Extension>();
const liveCmViews = new Set<EditorView>();
let activeCmThemeExtension: Extension | null = null;

function createCmFontMeasureExtension(fontSize: number): Extension {
  return EditorView.theme({
    "&": {
      "--wb-editor-font-measure": String(clampEditorFontSize(fontSize))
    }
  });
}

function composeCmThemeExtensions(extension: Extension): Extension[] {
  return [extension, cmEditorZoomExtension, cmFontMeasureCompartment.of([])];
}

function setCmEditorFontSize(view: EditorView, fontSize: number): void {
  const normalizedFontSize = clampEditorFontSize(fontSize);
  view.dom.style.setProperty("--wb-editor-font-size", `${normalizedFontSize}px`);
  // A measurement request alone can keep cached line heights when the editor
  // fills a fixed-height container. Reconfiguring this inert theme extension
  // marks content geometry dirty, so the gutter is rebuilt immediately after
  // the font-size change rather than waiting for cursor movement.
  view.dispatch({
    effects: cmFontMeasureCompartment.reconfigure(createCmFontMeasureExtension(normalizedFontSize))
  });
  view.requestMeasure();
}

function getCmEditorFontSize(view: EditorView): number {
  const inlineValue = Number.parseFloat(view.dom.style.getPropertyValue("--wb-editor-font-size"));
  return Number.isFinite(inlineValue) ? clampEditorFontSize(inlineValue) : readEditorFontSize();
}

function applyCmEditorFontSize(fontSize: number): void {
  for (const view of liveCmViews) {
    setCmEditorFontSize(view, fontSize);
  }
}

const cmEditorZoomExtension = EditorView.domEventHandlers({
  keydown: (event, view) =>
    handleEditorZoomKeydown(
      event as KeyboardEvent,
      () => getCmEditorFontSize(view),
      applyCmEditorFontSize
    )
});

/** Registers a theme extension under the workbench theme id (idempotent). */
export function defineCmTheme(themeDef: ThemeDefinition): void {
  definedCmThemes.set(themeDef.id, buildCmThemeExtension(themeDef));
}

/**
 * Activates a previously defined theme: reconfigures the shared theme
 * Compartment in every live CM view. Unknown ids are ignored (the current
 * theme stays active), mirroring how a missing Monaco theme keeps the old
 * one.
 */
export function applyCmTheme(themeId: string): void {
  const extension = definedCmThemes.get(themeId);
  if (!extension) {
    return;
  }
  activeCmThemeExtension = extension;
  for (const view of liveCmViews) {
    view.dispatch({
      effects: cmThemeCompartment.reconfigure(composeCmThemeExtensions(extension))
    });
  }
}

/**
 * Compartment slot for the shared base extension list; newly created states
 * start from the currently active theme.
 */
export function getCmThemeCompartmentExtension(): Extension {
  return cmThemeCompartment.of(composeCmThemeExtensions(activeCmThemeExtension ?? createCmBaseTheme()));
}

/**
 * Re-applies the active theme to a view whose EditorState was restored from
 * cm-editor's per-path cache (parked states keep the theme that was active
 * when they were parked).
 */
export function syncCmThemeToView(view: EditorView): void {
  if (activeCmThemeExtension) {
    view.dispatch({
      effects: cmThemeCompartment.reconfigure(composeCmThemeExtensions(activeCmThemeExtension))
    });
  }
}

/** cm-editor registers/unregisters live views so theme switches reach them. */
export function registerCmThemeView(view: EditorView): () => void {
  liveCmViews.add(view);
  setCmEditorFontSize(view, readEditorFontSize());
  return () => {
    liveCmViews.delete(view);
  };
}
