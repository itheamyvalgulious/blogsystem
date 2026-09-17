import assert from "node:assert/strict";
import test from "node:test";

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import {
  buildPageCss,
  buildPdfHtml,
  buildBrowserPrintCss,
  rejectAfterTimeout,
  selectEnabledThemeAssets,
  PDF_PRINT_CSS
} from "./pdf-render-helpers";
import type { PdfExportSettings } from "./pdf-types";
import type { ThemeGroupSummary } from "@blog-system/content-core";
import { PAGE_SIZE_CSS, DEFAULT_PDF_SETTINGS } from "./pdf-types";

// ---------------------------------------------------------------------------
// rejectAfterTimeout
// ---------------------------------------------------------------------------

test("rejectAfterTimeout mirrors a promise that resolves before the timeout", async () => {
  const result = await rejectAfterTimeout(
    Promise.resolve("loaded"),
    1000,
    () => new Error("timed out")
  );
  assert.equal(result, "loaded");
});

test("rejectAfterTimeout rejects with the created error when the timeout elapses first", async () => {
  const neverSettles = new Promise<void>(() => undefined);
  await assert.rejects(
    rejectAfterTimeout(neverSettles, 5, () => new Error("load timed out")),
    /load timed out/
  );
});

test("rejectAfterTimeout propagates the original rejection (load error)", async () => {
  await assert.rejects(
    rejectAfterTimeout(Promise.reject(new Error("iframe error")), 1000, () => new Error("timed out")),
    /iframe error/
  );
});

test("rejectAfterTimeout does not reject after the promise has already resolved", async () => {
  // Regression guard: the timer must be cleared once the promise settles, so a
  // late timeout cannot produce an unhandled rejection.
  const result = await rejectAfterTimeout(
    Promise.resolve("quick"),
    5,
    () => new Error("should never fire")
  );
  assert.equal(result, "quick");
  // Give any (incorrectly retained) timer a chance to fire.
  await new Promise((resolve) => setTimeout(resolve, 15));
});

// ---------------------------------------------------------------------------
// buildPageCss
// ---------------------------------------------------------------------------

test("buildPageCss renders a valid @page rule for portrait A4 with default margins", () => {
  const css = buildPageCss(DEFAULT_PDF_SETTINGS);
  assert.ok(css.startsWith("@page {"));
  assert.ok(css.includes("size: 210mm 297mm"));
  assert.ok(css.includes("margin: 20mm 15mm 20mm 15mm"));
});

test("buildPageCss renders landscape for A5 as swapped dimensions without keyword", () => {
  const settings: PdfExportSettings = {
    ...DEFAULT_PDF_SETTINGS,
    pageSize: "A5",
    orientation: "landscape"
  };
  const css = buildPageCss(settings);
  // landscape A5 = 210x148, no "landscape" keyword (pure <w> <h> only)
  assert.ok(css.includes("size: 210mm 148mm"));
  assert.ok(!css.includes("landscape"));
});

test("buildPageCss uses Letter dimensions", () => {
  const settings: PdfExportSettings = {
    ...DEFAULT_PDF_SETTINGS,
    pageSize: "Letter"
  };
  const css = buildPageCss(settings);
  const dims = PAGE_SIZE_CSS.Letter;
  assert.ok(css.includes(`size: ${dims.width}mm ${dims.height}mm`));
});

test("buildPageCss uses Legal dimensions", () => {
  const settings: PdfExportSettings = {
    ...DEFAULT_PDF_SETTINGS,
    pageSize: "Legal"
  };
  const css = buildPageCss(settings);
  const dims = PAGE_SIZE_CSS.Legal;
  assert.ok(css.includes(`size: ${dims.width}mm ${dims.height}mm`));
});

test("buildPageCss renders custom margins", () => {
  const settings: PdfExportSettings = {
    ...DEFAULT_PDF_SETTINGS,
    marginsMm: { top: 10, right: 5, bottom: 15, left: 5 }
  };
  const css = buildPageCss(settings);
  assert.ok(css.includes("margin: 10mm 5mm 15mm 5mm"));
});

// ---------------------------------------------------------------------------
// buildBrowserPrintCss (browser-only print overrides)
// ---------------------------------------------------------------------------

test("buildBrowserPrintCss returns empty string for default settings (scale=1, printBackground=false)", () => {
  const css = buildBrowserPrintCss(DEFAULT_PDF_SETTINGS);
  assert.equal(css, "");
});

test("buildBrowserPrintCss includes print-color-adjust when printBackground is true", () => {
  const css = buildBrowserPrintCss({ ...DEFAULT_PDF_SETTINGS, printBackground: true });
  assert.ok(css.includes("print-color-adjust: exact;"));
  assert.ok(css.includes("-webkit-print-color-adjust: exact;"));
  assert.ok(css.startsWith("@media print"));
});

test("buildBrowserPrintCss includes scale transform when scale is not 1", () => {
  const css = buildBrowserPrintCss({ ...DEFAULT_PDF_SETTINGS, scale: 1.5 });
  assert.ok(css.includes("--pdf-scale: 1.5"));
  assert.ok(css.includes("transform: scale(var(--pdf-scale))"));
  assert.ok(css.includes("transform-origin: top left"));
});

test("buildBrowserPrintCss includes both print-background and scale when both differ from defaults", () => {
  const css = buildBrowserPrintCss({
    ...DEFAULT_PDF_SETTINGS,
    printBackground: true,
    scale: 0.75
  });
  assert.ok(css.includes("print-color-adjust: exact;"));
  assert.ok(css.includes("--pdf-scale: 0.75"));
  assert.ok(css.startsWith("@media print"));
  assert.ok(css.includes("body {"));
});

test("buildBrowserPrintCss targets body inside @media print", () => {
  const css = buildBrowserPrintCss({ ...DEFAULT_PDF_SETTINGS, scale: 1.2 });
  assert.ok(css.startsWith("@media print"));
  assert.ok(css.includes("\nbody {"));
  assert.ok(css.endsWith("}\n"));
});

// ---------------------------------------------------------------------------
// buildPdfHtml
// ---------------------------------------------------------------------------

test("buildPdfHtml produces a complete HTML document with required sections", () => {
  const html = buildPdfHtml(
    "Test Article",
    "<p>Hello world</p>",
    DEFAULT_PDF_SETTINGS,
    ["<style>.test-theme { color: red; }</style>"],
    ".katex { }",
    ".hljs { }"
  );

  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes("<title>Test Article</title>"));
  assert.ok(html.includes("<article class=\"article-panel\">"));
  assert.ok(html.includes("<div class=\"prose\"><p>Hello world</p></div>"));
  assert.ok(html.includes(".test-theme { color: red; }"));
  assert.ok(html.includes(PDF_PRINT_CSS));
  assert.ok(html.includes("@page {"));
  assert.ok(html.includes(".katex { }"));
  assert.ok(html.includes(".hljs { }"));
});

test("buildPdfHtml includes static-site-compatible content wrappers", () => {
  const html = buildPdfHtml(
    "Wrappers",
    "<p>content</p>",
    DEFAULT_PDF_SETTINGS,
    [],
    "",
    ""
  );

  // Must include the full article content area structure
  assert.ok(html.includes(`<div class="paper-background">`));
  assert.ok(html.includes(`<div class="paper-background__grain"></div>`));
  assert.ok(html.includes(`<div class="paper-background__geometry"></div>`));
  assert.ok(html.includes(`<div class="site-shell">`));
  assert.ok(html.includes(`<main class="page-shell">`));
  assert.ok(html.includes(`<section class="article-layout">`));
  assert.ok(html.includes(`<article class="article-panel">`));
  assert.ok(html.includes(`<div class="prose"><p>content</p></div>`));
});

test("buildPdfHtml excludes site header, footer, hero, TOC, pager, and side-panel", () => {
  const html = buildPdfHtml(
    "NoChrome",
    "<p>content</p>",
    DEFAULT_PDF_SETTINGS,
    [],
    "",
    ""
  );

  // These non-content elements must not appear in the PDF document
  assert.ok(!html.includes("site-header"));
  assert.ok(!html.includes("site-footer"));
  assert.ok(!html.includes("site-brand"));
  assert.ok(!html.includes("side-panel"));
  assert.ok(!html.includes("On This Page"));
  assert.ok(!html.includes("article-pager"));
  assert.ok(!html.includes("article-hero"));
});

test("buildPdfHtml escapes HTML in the title", () => {
  const html = buildPdfHtml(
    'Article <script>alert("xss")</script>',
    "<p>content</p>",
    DEFAULT_PDF_SETTINGS,
    [],
    "",
    ""
  );
  assert.ok(html.includes("<title>Article &lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</title>"));
});

test("buildPdfHtml omits <base> tag when baseUrl is not provided", () => {
  const html = buildPdfHtml(
    "No Base",
    "<p>test</p>",
    DEFAULT_PDF_SETTINGS,
    [],
    "",
    ""
  );
  assert.ok(!html.includes("<base "));
});

test("buildPdfHtml includes <base> tag when baseUrl is provided", () => {
  const html = buildPdfHtml(
    "With Base",
    "<p>test</p>",
    DEFAULT_PDF_SETTINGS,
    [],
    "",
    "",
    { baseUrl: "http://127.0.0.1:3456" }
  );
  assert.ok(html.includes('<base href="http://127.0.0.1:3456">'));
});

test("buildPdfHtml escapes special characters in baseUrl", () => {
  const html = buildPdfHtml(
    "Escaped Base",
    "<p>test</p>",
    DEFAULT_PDF_SETTINGS,
    [],
    "",
    "",
    { baseUrl: 'http://example.com/path?query=<"test">' }
  );
  assert.ok(html.includes('<base href="http://example.com/path?query=&lt;&quot;test&quot;&gt;">'));
});

test("buildPdfHtml omits browser print overrides when browserPrintOverrides is not set (Electron path)", () => {
  const html = buildPdfHtml("Electron", "<p>test</p>", DEFAULT_PDF_SETTINGS, [], "", "");
  assert.ok(!html.includes("print-color-adjust"));
  assert.ok(!html.includes("--pdf-scale"));
});

test("buildPdfHtml omits browser print overrides even with non-default scale when browserPrintOverrides is false", () => {
  const html = buildPdfHtml(
    "ElectronScaled",
    "<p>test</p>",
    { ...DEFAULT_PDF_SETTINGS, scale: 1.25, printBackground: true },
    [],
    "",
    ""
  );
  // Electron must NOT get CSS overrides — it applies these via printToPDF options.
  assert.ok(!html.includes("print-color-adjust"));
  assert.ok(!html.includes("--pdf-scale"));
});

test("buildPdfHtml still includes @page and PDF_PRINT_CSS for Electron path", () => {
  const html = buildPdfHtml("Electron", "<p>test</p>", DEFAULT_PDF_SETTINGS, [], "", "");
  assert.ok(html.includes("@page {"));
  assert.ok(html.includes(PDF_PRINT_CSS));
});

test("buildPdfHtml embeds browser overrides only when browserPrintOverrides is true", () => {
  const html = buildPdfHtml(
    "Browser",
    "<p>test</p>",
    { ...DEFAULT_PDF_SETTINGS, printBackground: true, scale: 1.25 },
    [],
    "",
    "",
    { browserPrintOverrides: true }
  );
  assert.ok(html.includes("print-color-adjust: exact;"));
  assert.ok(html.includes("--pdf-scale: 1.25"));
});

test("buildPdfHtml still includes @page and PDF_PRINT_CSS alongside browser overrides", () => {
  const html = buildPdfHtml(
    "Browser",
    "<p>test</p>",
    { ...DEFAULT_PDF_SETTINGS, scale: 0.9 },
    [],
    "",
    "",
    { browserPrintOverrides: true }
  );
  assert.ok(html.includes("@page {"));
  assert.ok(html.includes(PDF_PRINT_CSS));
  assert.ok(html.includes("--pdf-scale: 0.9"));
});

// ---------------------------------------------------------------------------
// Source-level regression guard for KaTeX CSS processing
// ---------------------------------------------------------------------------

test("pdf-export uses Vite-processed KaTeX CSS (?inline) so font URLs are rewritten", async () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const sourcePath = resolve(__dirname, "pdf-export.ts");
  const source = await readFile(sourcePath, "utf8");
  // Must use ?inline (not ?raw) — Vite processes url(fonts/...) in ?inline,
  // rewriting them to absolute dev paths or hashed production asset URLs.
  assert.ok(
    source.includes('katex/dist/katex.min.css?inline'),
    "pdf-export.ts must import KaTeX CSS via ?inline so font URLs get rewritten"
  );
  assert.ok(
    !source.includes('katex.min.css?raw'),
    "pdf-export.ts must not import KaTeX CSS via ?raw (would leave bare url(fonts/...))"
  );
});

// ---------------------------------------------------------------------------
// PAGE_SIZE_CSS constants
// ---------------------------------------------------------------------------

test("PAGE_SIZE_CSS has correct dimensions for all sizes", () => {
  assert.equal(PAGE_SIZE_CSS.A4.width, 210);
  assert.equal(PAGE_SIZE_CSS.A4.height, 297);

  assert.equal(PAGE_SIZE_CSS.A5.width, 148);
  assert.equal(PAGE_SIZE_CSS.A5.height, 210);

  assert.equal(PAGE_SIZE_CSS.Letter.width, 215.9);
  assert.equal(PAGE_SIZE_CSS.Letter.height, 279.4);

  assert.equal(PAGE_SIZE_CSS.Legal.width, 215.9);
  assert.equal(PAGE_SIZE_CSS.Legal.height, 355.6);
});

// ---------------------------------------------------------------------------
// DEFAULT_PDF_SETTINGS
// ---------------------------------------------------------------------------

test("DEFAULT_PDF_SETTINGS has sensible defaults", () => {
  assert.equal(DEFAULT_PDF_SETTINGS.pageSize, "A4");
  assert.equal(DEFAULT_PDF_SETTINGS.orientation, "portrait");
  assert.equal(DEFAULT_PDF_SETTINGS.scale, 1);
  assert.equal(DEFAULT_PDF_SETTINGS.printBackground, false);
  assert.deepEqual(DEFAULT_PDF_SETTINGS.marginsMm, { top: 20, right: 15, bottom: 20, left: 15 });
});

// ---------------------------------------------------------------------------
// selectEnabledThemeAssets
// ---------------------------------------------------------------------------

function makeGroup(overrides: Partial<ThemeGroupSummary> & { groupId: string }): ThemeGroupSummary {
  return {
    enable: true,
    files: [],
    label: "Test",
    mode: "light",
    ...overrides
  };
}

function makeCssFile(fileName: string, colorMode: "light" | "dark", adminPreview = false) {
  return { adminPreview, colorMode, fileName, type: "css" as const };
}

function makeJsFile(fileName: string) {
  return { adminPreview: false, fileName, type: "js" as const };
}

test("selectEnabledThemeAssets selects CSS matching each group's own mode", () => {
  const groups: ThemeGroupSummary[] = [
    makeGroup({
      groupId: "atlas",
      mode: "light",
      files: [
        makeCssFile("chrome.light.css", "light"),
        makeCssFile("chrome.dark.css", "dark"),
        makeCssFile("prose.light.css", "light"),
        makeCssFile("prose.dark.css", "dark")
      ]
    }),
    makeGroup({
      groupId: "syntax",
      mode: "dark",
      files: [
        makeCssFile("code.light.css", "light"),
        makeCssFile("code.dark.css", "dark")
      ]
    })
  ];

  const assets = selectEnabledThemeAssets(groups);
  assert.equal(assets.length, 3);
  assert.equal(assets[0].groupId, "atlas");
  assert.equal(assets[0].fileName, "chrome.light.css");
  assert.equal(assets[1].groupId, "atlas");
  assert.equal(assets[1].fileName, "prose.light.css");
  assert.equal(assets[2].groupId, "syntax");
  assert.equal(assets[2].fileName, "code.dark.css");
});

test("selectEnabledThemeAssets excludes disabled groups", () => {
  const groups: ThemeGroupSummary[] = [
    makeGroup({
      groupId: "enabled",
      enable: true,
      mode: "light",
      files: [makeCssFile("active.css", "light")]
    }),
    makeGroup({
      groupId: "disabled",
      enable: false,
      mode: "light",
      files: [makeCssFile("inactive.css", "light")]
    })
  ];

  const assets = selectEnabledThemeAssets(groups);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].groupId, "enabled");
});

test("selectEnabledThemeAssets excludes CSS files whose colorMode does not match group mode", () => {
  const groups: ThemeGroupSummary[] = [
    makeGroup({
      groupId: "theme",
      mode: "light",
      files: [
        makeCssFile("light.css", "light"),
        makeCssFile("dark.css", "dark") // excluded — mismatch
      ]
    })
  ];

  const assets = selectEnabledThemeAssets(groups);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].fileName, "light.css");
});

test("selectEnabledThemeAssets preserves group and file order", () => {
  const groups: ThemeGroupSummary[] = [
    makeGroup({
      groupId: "b",
      mode: "light",
      files: [makeCssFile("z.css", "light"), makeCssFile("a.css", "light")]
    }),
    makeGroup({
      groupId: "a",
      mode: "light",
      files: [makeCssFile("m.css", "light")]
    })
  ];

  const assets = selectEnabledThemeAssets(groups);
  assert.equal(assets.length, 3);
  // Group "b" comes first (original order), then "a"
  assert.equal(assets[0].groupId, "b");
  assert.equal(assets[0].fileName, "z.css");
  assert.equal(assets[1].groupId, "b");
  assert.equal(assets[1].fileName, "a.css");
  assert.equal(assets[2].groupId, "a");
  assert.equal(assets[2].fileName, "m.css");
});

test("selectEnabledThemeAssets excludes JS files (only CSS with matching colorMode)", () => {
  const groups: ThemeGroupSummary[] = [
    makeGroup({
      groupId: "theme",
      mode: "light",
      files: [
        makeJsFile("script.js"),
        makeCssFile("style.light.css", "light")
      ]
    })
  ];

  const assets = selectEnabledThemeAssets(groups);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].fileName, "style.light.css");
});

test("selectEnabledThemeAssets returns empty for empty input", () => {
  assert.deepEqual(selectEnabledThemeAssets([]), []);
});

/**
 * fetchThemeCssLinks error propagation is not tested in Node because
 * pdf-export.ts imports Vite-specific `?inline` CSS modules that tsx
 * cannot resolve. The pure `selectEnabledThemeAssets` helper above
 * already covers the asset selection semantics; fetch-failure → throw
 * is verified during manual integration / Playwright testing.
 */