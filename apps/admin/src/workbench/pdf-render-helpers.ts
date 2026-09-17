/**
 * Pure helper functions for PDF export document construction.
 * No Vite-specific imports — safe to run in Node.js tests.
 */

import type { PdfExportSettings } from "./pdf-types";
import { PAGE_SIZE_CSS } from "./pdf-types";
import type { ThemeGroupSummary } from "@blog-system/content-core";

// ---------------------------------------------------------------------------
// Theme asset selection
// ---------------------------------------------------------------------------

/**
 * Pure function: select enabled theme CSS assets using the same semantics as
 * `listEnabledThemeAssets` — each enabled group independently picks CSS files
 * whose `colorMode` matches the group's own `mode`. Returns assets in original
 * group/files order.
 *
 * This is intentionally separated from the fetch logic so it can be unit
 * tested without a DOM / Vite environment.
 */
export function selectEnabledThemeAssets(
  themeGroups: ThemeGroupSummary[]
): Array<{ groupId: string; fileName: string }> {
  const assets: Array<{ groupId: string; fileName: string }> = [];
  for (const group of themeGroups) {
    if (!group.enable) continue;
    for (const file of group.files) {
      if (file.type === "css" && file.colorMode === group.mode) {
        assets.push({ groupId: group.groupId, fileName: file.fileName });
      }
    }
  }
  return assets;
}

// ---------------------------------------------------------------------------
// Async helpers
// ---------------------------------------------------------------------------

/**
 * Reject with `createError()` if `promise` does not settle within `timeoutMs`;
 * otherwise mirror `promise` exactly (including its original rejection).
 *
 * This is intentionally DOM-free and dependency-free so the timeout behaviour
 * can be unit tested in Node. Used for the print iframe `load` wait, where a
 * timeout must abort the export rather than silently printing an empty/partial
 * document.
 */
export function rejectAfterTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(createError());
    }, timeoutMs);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

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

/**
 * Build browser-only print override CSS from user settings.
 *
 * Browsers cannot force scale/print-background through JavaScript, so the
 * browser print path expresses them as `@media print` CSS instead. This CSS
 * must ONLY be embedded in the browser iframe document — the Electron path
 * applies the same settings through `printToPDF` options, and embedding this
 * rule too would double-apply them (e.g. scale).
 *
 * Results are best-effort; some renderers may ignore certain properties.
 */
export function buildBrowserPrintCss(settings: PdfExportSettings): string {
  const rules: string[] = [];

  if (settings.printBackground) {
    rules.push("  -webkit-print-color-adjust: exact;\n  print-color-adjust: exact;");
  }

  if (settings.scale !== 1) {
    rules.push(
      `  --pdf-scale: ${settings.scale};\n` +
      "  transform: scale(var(--pdf-scale));\n" +
      "  transform-origin: top left;\n" +
      `  width: calc(100% / ${settings.scale});`
    );
  }

  if (rules.length === 0) return "";

  return `@media print {\nbody {\n${rules.join("\n")}\n}\n}\n`;
}

// ---------------------------------------------------------------------------
// @page CSS builder
// ---------------------------------------------------------------------------

/**
 * Build a @page CSS rule from settings.
 *
 * Orientation is expressed purely by swapping the width/height pair of the
 * `size` value (e.g. A4 landscape → `size: 297mm 210mm`). The `landscape`
 * keyword is intentionally NOT used: `landscape <w> <h>` is invalid CSS and
 * Chromium silently falls back to Letter portrait when `preferCSSPageSize` is
 * enabled. A bare `<w> <h>` pair is valid and unambiguous.
 */
export function buildPageCss(settings: PdfExportSettings): string {
  const { pageSize, orientation, marginsMm } = settings;
  const dims = PAGE_SIZE_CSS[pageSize];
  const sizeStr =
    orientation === "landscape"
      ? `${dims.height}mm ${dims.width}mm`
      : `${dims.width}mm ${dims.height}mm`;
  return `@page {
  size: ${sizeStr};
  margin: ${marginsMm.top}mm ${marginsMm.right}mm ${marginsMm.bottom}mm ${marginsMm.left}mm;
}`;
}

// ---------------------------------------------------------------------------
// HTML document builder
// ---------------------------------------------------------------------------

/** Options for buildPdfHtml. */
export interface PdfHtmlBuildOptions {
  /**
   * Base URL for a `<base href>` tag so relative asset URLs (images, etc.)
   * can be resolved. Used when the HTML is loaded in a BrowserWindow or iframe
   * with a different origin from the admin app.
   */
  baseUrl?: string;

  /**
   * When true, emit browser-only print overrides (print-background color-adjust
   * and scale CSS transform) as `@media print` rules. Must be `true` for the
   * browser iframe document and `false` (or omitted) for the Electron path,
   * which applies these settings via `printToPDF` options instead — embedding
   * them would double-apply (especially scale).
   */
  browserPrintOverrides?: boolean;
}

/**
 * Build the complete HTML document string for PDF rendering.
 * Matches the static-site article content area appearance, excluding admin
 * chrome and non-content elements (header, footer, hero, TOC, pager,
 * side-panel). The DOM structure mirrors the static site's article wrappers
 * so theme CSS selectors targeting those containers compute the same styles.
 *
 * @param title - Document title (escaped internally)
 * @param articleHtml - Pre-rendered article content HTML
 * @param settings - Page settings for @page CSS
 * @param themeCssLinks - Inline <style> elements for theme CSS
 * @param katexCss - KaTeX CSS text
 * @param highlightCss - Syntax highlight CSS text
 * @param options - Optional build flags
 */
export function buildPdfHtml(
  title: string,
  articleHtml: string,
  settings: PdfExportSettings,
  themeCssLinks: string[],
  katexCss: string,
  highlightCss: string,
  options: PdfHtmlBuildOptions = {}
): string {
  const pageCss = buildPageCss(settings);
  const browserOverrideCss = options.browserPrintOverrides ? buildBrowserPrintCss(settings) : "";
  const baseTag = options.baseUrl
    ? `<base href="${escapeHtmlAttribute(options.baseUrl)}">\n`
    : "";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtmlAttribute(title)}</title>
${baseTag}${themeCssLinks.join("\n")}
<style>
${katexCss}
${highlightCss}
${pageCss}
${PDF_PRINT_CSS}
${browserOverrideCss}
</style>
</head>
<body>
<div class="paper-background">
  <div class="paper-background__grain"></div>
  <div class="paper-background__geometry"></div>
</div>
<div class="site-shell">
  <main class="page-shell">
    <section class="article-layout">
      <article class="article-panel">
        <div class="prose">${articleHtml}</div>
      </article>
    </section>
  </main>
</div>
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