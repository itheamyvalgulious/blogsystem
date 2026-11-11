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
  parseCssUrl,
  isFullSizeBackgroundSize,
  PDF_FENCE_RENDERERS,
  PDF_PRINT_CSS,
  PDF_BAKE_SCRIPT
} from "./pdf-render-helpers";
import type { PdfExportSettings } from "./pdf-types";
import { renderMarkdownWithKatex, type ThemeGroupSummary } from "@blog-system/content-core";
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

test("buildPdfHtml restricts scripts to the bake script via a nonce CSP", () => {
  const html = buildPdfHtml("CSP", "<p>content</p>", DEFAULT_PDF_SETTINGS, [], "", "");
  const cspMatch = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(cspMatch, "CSP meta tag must be present");

  const csp = cspMatch[1];
  const nonceMatch = /script-src 'nonce-([0-9a-f]{32})'/.exec(csp);
  assert.ok(nonceMatch, "script-src must use a per-document nonce");
  assert.ok(!csp.includes("script-src 'unsafe-inline'"));

  // Inline styles must stay allowed: theme, KaTeX, and commutative CSS are
  // all embedded as <style> elements.
  assert.ok(csp.includes("style-src 'unsafe-inline'"));
  assert.ok(html.includes(`<script nonce="${nonceMatch[1]}">`));
});

test("buildPdfHtml uses a fresh CSP nonce per document", () => {
  const first = buildPdfHtml("A", "<p>a</p>", DEFAULT_PDF_SETTINGS, [], "", "");
  const second = buildPdfHtml("B", "<p>b</p>", DEFAULT_PDF_SETTINGS, [], "", "");
  const firstNonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(first)?.[1];
  const secondNonce = /script-src 'nonce-([0-9a-f]{32})'/.exec(second)?.[1];
  assert.ok(firstNonce && secondNonce);
  assert.notEqual(firstNonce, secondNonce);
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
// PDF_PRINT_CSS — pdfium blank-page workaround
// ---------------------------------------------------------------------------

test("PDF_PRINT_CSS moves site background images off the root for pdfium compatibility", () => {
  // Root must never paint background images (pdfium blank-page workaround).
  assert.ok(PDF_PRINT_CSS.includes("html, body { background-image: none !important; }"));
  // The decoration container the PDF template always emits carries the
  // theme's site background image + base color as a single multi-background.
  assert.ok(PDF_PRINT_CSS.includes(".paper-background"));
  assert.ok(PDF_PRINT_CSS.includes("var(--site-background-image, none)"));
  assert.ok(PDF_PRINT_CSS.includes("var(--bg, #ffffff)"));
  // Both rules live inside the @media print block (it spans the whole constant).
  assert.ok(PDF_PRINT_CSS.trim().startsWith("@media print"));
  // And buildPdfHtml embeds the print CSS into the document.
  const html = buildPdfHtml(
    "t",
    "<p>hi</p>",
    DEFAULT_PDF_SETTINGS,
    [],
    "",
    ""
  );
  assert.ok(html.includes("html, body { background-image: none !important; }"));
  assert.ok(html.includes("var(--site-background-image, none)"));
});

// ---------------------------------------------------------------------------
// PDF_FENCE_RENDERERS — diagrams must render, not degrade to code blocks
// ---------------------------------------------------------------------------

test("PDF_FENCE_RENDERERS renders commutative fences as diagrams with inline CSS", async () => {
  const markdown = [
    "before",
    "",
    "```commutative",
    String.raw`A \arrow[r] \arrow[d] & B \arrow[d] \\`,
    String.raw`C \arrow[r] & D`,
    "```",
    "",
    "after"
  ].join("\n");

  const rendered = await renderMarkdownWithKatex(markdown, null, PDF_FENCE_RENDERERS);

  assert.equal(rendered.errors?.length ?? 0, 0);
  assert.ok(rendered.html.includes('class="commutative"'), "diagram figure must be emitted");
  assert.ok(rendered.html.includes("cg-svg"), "diagram SVG must be emitted");
  assert.ok(
    rendered.html.includes("data-markdown-fence-renderers"),
    "diagram CSS must be embedded in the document"
  );
  assert.ok(
    rendered.html.includes(".commutative") && rendered.html.includes(".cg-node"),
    "diagram CSS rules must be present"
  );
  // The raw fence must not fall through to a highlighted code block.
  assert.ok(!rendered.html.includes("language-commutative"));
});

test("PDF_FENCE_RENDERERS keeps parse errors visible instead of throwing", async () => {
  const rendered = await renderMarkdownWithKatex(
    ["```commutative", "\\arrow[", "```"].join("\n"),
    null,
    PDF_FENCE_RENDERERS
  );

  assert.equal(rendered.errors?.length ?? 0, 0);
  assert.ok(rendered.html.includes("commutative--error"));
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

// ---------------------------------------------------------------------------
// PDF_BAKE_SCRIPT — pdfium gradient baking
// ---------------------------------------------------------------------------

test("buildPdfHtml embeds the pdfium bake script and page pixel dimensions", () => {
  const portrait = buildPdfHtml("t", "<p>hi</p>", { ...DEFAULT_PDF_SETTINGS, orientation: "portrait" }, [], "", "");
  assert.ok(portrait.includes('data-pdf-page-width-px="794"'));
  assert.ok(portrait.includes('data-pdf-page-height-px="1123"'));
  const landscape = buildPdfHtml("t", "<p>hi</p>", { ...DEFAULT_PDF_SETTINGS, orientation: "landscape" }, [], "", "");
  assert.ok(landscape.includes('data-pdf-page-width-px="1123"'));
  assert.ok(landscape.includes('data-pdf-page-height-px="794"'));
  for (const html of [portrait, landscape]) {
    assert.ok(html.includes("window.__pdfBakePromise"));
    assert.ok(html.includes("data-pdf-bake-done"));
  }
  // The bake script must never restyle the root elements (blank-page guard) and
  // must skip visually-tiling backgrounds.
  assert.ok(PDF_BAKE_SCRIPT.includes("el === document.body || el === document.documentElement"));
  assert.ok(PDF_BAKE_SCRIPT.includes("repeating-"));
  // Must use matched quotes capture group (group 1 quote, group 2 url) and check m && m[2]
  assert.ok(PDF_BAKE_SCRIPT.includes("m && m[2]"));
  // Must skip paper-background stack bake when siteVar is unparseable (preserves original background)
  assert.ok(PDF_BAKE_SCRIPT.includes("siteCss = null; // unparseable URL: skip stack bake entirely"));
  assert.ok(PDF_BAKE_SCRIPT.includes("siteCss = null; // unparseable: skip stack bake entirely"));
  // Must NOT use substring indexOf("100%") which breaks 1D partial sizes
  assert.ok(!PDF_BAKE_SCRIPT.includes('indexOf("100%")'));
});

test("parseCssUrl correctly extracts URLs across double, single, and unquoted formats", () => {
  assert.equal(parseCssUrl('url("https://example.com/bg.png")'), "https://example.com/bg.png");
  assert.equal(parseCssUrl("url('https://example.com/bg.png')"), "https://example.com/bg.png");
  assert.equal(parseCssUrl("url(https://example.com/bg.png)"), "https://example.com/bg.png");
  assert.equal(parseCssUrl('url(  "https://example.com/bg.png"  )'), "https://example.com/bg.png");
  assert.equal(parseCssUrl("url(  '/assets/paper.jpg'  )"), "/assets/paper.jpg");
  assert.equal(parseCssUrl("url(/assets/image.svg)"), "/assets/image.svg");

  // Invalid / non-url / empty values return null
  assert.equal(parseCssUrl("none"), null);
  assert.equal(parseCssUrl(""), null);
  assert.equal(parseCssUrl('url("")'), null);
  assert.equal(parseCssUrl("url('')"), null);
  assert.equal(parseCssUrl('url("mismatched\')'), null);
  assert.equal(parseCssUrl("linear-gradient(to right, red, blue)"), null);
  assert.equal(parseCssUrl("not-a-url"), null);
});

test("isFullSizeBackgroundSize conservatively allows only full-size layers and rejects partial dimensions", () => {
  // Allowed full-size keyword and 1D/2D complete coverings
  assert.equal(isFullSizeBackgroundSize("auto"), true);
  assert.equal(isFullSizeBackgroundSize("cover"), true);
  assert.equal(isFullSizeBackgroundSize("contain"), true);
  assert.equal(isFullSizeBackgroundSize("100%"), true);
  assert.equal(isFullSizeBackgroundSize("100% 100%"), true);
  assert.equal(isFullSizeBackgroundSize("auto 100%"), true);
  assert.equal(isFullSizeBackgroundSize("100% auto"), true);
  assert.equal(isFullSizeBackgroundSize("auto auto"), true);

  // Multi-layer all safe
  assert.equal(isFullSizeBackgroundSize("100% 100%, cover"), true);
  assert.equal(isFullSizeBackgroundSize("cover, contain, auto"), true);

  // Partial dimensions (such as underlines or side markers) must be rejected
  assert.equal(isFullSizeBackgroundSize("100% 2px"), false);
  assert.equal(isFullSizeBackgroundSize("40px 100%"), false);
  assert.equal(isFullSizeBackgroundSize("20px 20px"), false);
  assert.equal(isFullSizeBackgroundSize("10px 10px"), false);
  assert.equal(isFullSizeBackgroundSize("calc(100% - 10px) 100%"), false);

  // Mixed layers with any partial dimension must be rejected
  assert.equal(isFullSizeBackgroundSize("100% 100%, 20px 20px"), false);
  assert.equal(isFullSizeBackgroundSize("100% 2px, cover"), false);
});

/**
 * fetchThemeCssLinks error propagation is not tested in Node because
 * pdf-export.ts imports Vite-specific `?inline` CSS modules that tsx
 * cannot resolve. The pure `selectEnabledThemeAssets` helper above
 * already covers the asset selection semantics; fetch-failure → throw
 * is verified during manual integration / Playwright testing.
 */