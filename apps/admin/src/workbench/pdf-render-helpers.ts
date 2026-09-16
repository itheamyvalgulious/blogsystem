/**
 * Pure helper functions for PDF export document construction.
 * No Vite-specific imports — safe to run in Node.js tests.
 */

import type { PdfExportSettings } from "./pdf-types";
import { PAGE_SIZE_CSS } from "./pdf-types";

// ---------------------------------------------------------------------------
// Print CSS
// ---------------------------------------------------------------------------

/** CSS injected only during PDF rendering — hides elements from print output. */
export const PDF_PRINT_CSS = `
@media print {
  .no-pdf { display: none !important; }
  body {
    margin: 0;
    padding: 0;
  }
}
`;

// ---------------------------------------------------------------------------
// @page CSS builder
// ---------------------------------------------------------------------------

/** Build a @page CSS rule from settings. */
export function buildPageCss(settings: PdfExportSettings): string {
  const { pageSize, orientation, marginsMm } = settings;
  const dims = PAGE_SIZE_CSS[pageSize];
  const sizeStr =
    orientation === "landscape"
      ? `landscape ${dims.height}mm ${dims.width}mm`
      : `${dims.width}mm ${dims.height}mm`;
  return `@page {
  size: ${sizeStr};
  margin: ${marginsMm.top}mm ${marginsMm.right}mm ${marginsMm.bottom}mm ${marginsMm.left}mm;
}`;
}

// ---------------------------------------------------------------------------
// HTML document builder
// ---------------------------------------------------------------------------

/**
 * Build the complete HTML document string for PDF rendering.
 * Matches the static-site article appearance, excluding admin chrome.
 *
 * @param title - Document title (escaped internally)
 * @param articleHtml - Pre-rendered article content HTML
 * @param settings - Page settings for @page CSS
 * @param themeCssLinks - Inline <style> elements for theme CSS
 * @param katexCss - KaTeX CSS text
 * @param highlightCss - Syntax highlight CSS text
 */
export function buildPdfHtml(
  title: string,
  articleHtml: string,
  settings: PdfExportSettings,
  themeCssLinks: string[],
  katexCss: string,
  highlightCss: string
): string {
  const pageCss = buildPageCss(settings);
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlAttribute(title)}</title>
${themeCssLinks.join("\n")}
<style>
${katexCss}
${highlightCss}
${pageCss}
${PDF_PRINT_CSS}
</style>
</head>
<body>
<article class="article-panel">
  <div class="prose">${articleHtml}</div>
</article>
</body>
</html>`;
}

export function escapeHtmlAttribute(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}