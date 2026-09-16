import assert from "node:assert/strict";
import test from "node:test";

import { buildPageCss, buildPdfHtml, PDF_PRINT_CSS } from "./pdf-render-helpers";
import type { PdfExportSettings } from "./pdf-types";
import { PAGE_SIZE_CSS, DEFAULT_PDF_SETTINGS } from "./pdf-types";

// ---------------------------------------------------------------------------
// buildPageCss
// ---------------------------------------------------------------------------

test("buildPageCss renders a valid @page rule for portrait A4 with default margins", () => {
  const css = buildPageCss(DEFAULT_PDF_SETTINGS);
  assert.ok(css.startsWith("@page {"));
  assert.ok(css.includes("size: 210mm 297mm"));
  assert.ok(css.includes("margin: 20mm 15mm 20mm 15mm"));
});

test("buildPageCss renders landscape for A5", () => {
  const settings: PdfExportSettings = {
    ...DEFAULT_PDF_SETTINGS,
    pageSize: "A5",
    orientation: "landscape"
  };
  const css = buildPageCss(settings);
  assert.ok(css.includes("landscape 210mm 148mm"));
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