/**
 * PDF export renderer service.
 *
 * Renders the article markdown, fetches theme CSS assets (same as the static
 * site / preview), builds a complete self-contained HTML document (KaTeX,
 * highlight, @page, and print CSS all inlined), and sends it to the Electron
 * main process via IPC. The main process opens a native save dialog, spawns a
 * dedicated hidden BrowserWindow, generates the PDF via printToPDF, and writes
 * it to the chosen file path.
 *
 * Margin control strategy:
 *   The renderer injects `@page` CSS with the user's margin values so the
 *   print output respects them. The main process also forwards the marginsMm
 *   field to electron's PrintToPDFOptions as a secondary layer.
 */

import {
  renderMarkdownWithKatex,
  rewriteManagedMediaTextReferences,
  rewriteManagedMediaUrls,
  rewriteRelativeAssetUrls,
  highlightThemeCss,
  type ArticleRecord,
  type ThemeGroupSummary
} from "@blog-system/content-core";
/**
 * Vite-processed KaTeX CSS via `?inline`: Vite resolves the `url(fonts/...)`
 * references so they point to the correct dev-server paths (dev) or hashed
 * asset URLs (production build). Without this processing, the inlined CSS in
 * the PDF iframe's srcdoc would resolve font URLs against `<base href>` and
 * fail to find them (returning admin HTML instead of font bytes → OTS decode
 * errors and fallback fonts).
 */
import katexCssProcessed from "katex/dist/katex.min.css?inline";

import type { PdfExportResult, PdfExportSettings, PdfPrintRequest } from "./pdf-types";
import {
  buildPdfHtml,
  buildPageCss,
  buildBrowserPrintCss,
  rejectAfterTimeout,
  selectEnabledThemeAssets,
  PDF_PRINT_CSS,
  escapeHtmlAttribute
} from "./pdf-render-helpers";

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

/**
 * Render article markdown to HTML using the same pipeline as the static site
 * (renderMarkdownWithKatex → rewriteManagedMediaUrls → rewriteRelativeAssetUrls).
 */
async function renderArticleHtml(
  markdown: string,
  directory: string
): Promise<string> {
  const rendered = await renderMarkdownWithKatex(markdown, null, []);
  if ((rendered.errors?.length ?? 0) > 0) {
    throw new Error(
      `Markdown rendering failed: ${rendered.errors
        ?.map((e) => `[${e.fenceLanguage ?? "unknown"}] ${e.message}`)
        .join("; ")}`
    );
  }
  let html = rewriteManagedMediaUrls(rendered.html, "/media");
  html = rewriteRelativeAssetUrls(html, directory, "/content-files");
  return html;
}

// ---------------------------------------------------------------------------
// Theme CSS fetching
// ---------------------------------------------------------------------------

function buildThemeAssetUrl(groupId: string, fileName: string, version: number): string {
  const segments = [groupId, fileName]
    .filter(Boolean)
    .map((s) => encodeURIComponent(s));
  return `/theme-files/${segments.join("/")}?v=${version}`;
}

/**
 * Fetch theme group CSS assets using the same per-group-mode selection
 * semantics as `listEnabledThemeAssets` (not the admin's active appearance)
 * and return them as inline <style> elements with rewritten media URL references.
 *
 * @throws {Error} with group/file/HTTP status details if any fetch returns
 *   a non-2xx status — the PDF must not be silently emitted without its theme.
 */
async function fetchThemeCssLinks(
  themeGroups: ThemeGroupSummary[],
  renderStyleAssetVersion: number
): Promise<string[]> {
  const assets = selectEnabledThemeAssets(themeGroups);

  const results = await Promise.all(
    assets.map(async (asset) => {
      const href = buildThemeAssetUrl(asset.groupId, asset.fileName, renderStyleAssetVersion);
      const response = await fetch(href, { credentials: "include" });

      if (!response.ok) {
        throw new Error(
          `Theme CSS fetch failed for ${asset.groupId}/${asset.fileName}: HTTP ${response.status}`
        );
      }

      const cssText = rewriteManagedMediaTextReferences(await response.text(), "/media");
      return { groupId: asset.groupId, cssText };
    })
  );

  return results.map(
    (result) =>
      `<style data-theme-group="${escapeHtmlAttribute(result.groupId)}">\n${result.cssText}\n</style>`
  );
}

// ---------------------------------------------------------------------------
// Content resolution
// ---------------------------------------------------------------------------

/**
 * Retrieve the article content, preferring the active unsaved draft value over
 * the server-stored version.
 */
async function resolveArticleContent(
  articlePath: string,
  draftValuesRef: { current: Record<string, string> } | null
): Promise<ArticleRecord> {
  const draftId = `article:${articlePath}`;
  if (draftValuesRef?.current && typeof draftValuesRef.current[draftId] === "string") {
    const rawContent = draftValuesRef.current[draftId];
    const { parseArticleSource } = await import("@blog-system/content-core");
    return parseArticleSource(articlePath, rawContent);
  }
  const { api } = await import("../api");
  return api.getArticle(articlePath);
}

// ---------------------------------------------------------------------------
// Browser print helpers
// ---------------------------------------------------------------------------

/** Bounded timeout for the off-screen iframe document to finish loading. */
const PRINT_IFRAME_LOAD_TIMEOUT_MS = 10_000;
/** Bounded timeout for fonts/images to settle before triggering print. */
const PRINT_RESOURCE_TIMEOUT_MS = 5_000;

/**
 * The single print iframe kept alive across the print pipeline.
 * Chromium's "Save as PDF" writes the PDF from the still-mounted frame after
 * the user confirms the file picker — removing it before that produces blank
 * output.
 */
let activePrintFrame: HTMLIFrameElement | null = null;
/** Aborts the pagehide listener bound to the active print frame. */
let activePrintFrameAbort: AbortController | null = null;

function disposeActivePrintFrame(): void {
  if (activePrintFrameAbort) { activePrintFrameAbort.abort(); activePrintFrameAbort = null; }
  if (activePrintFrame?.parentNode) activePrintFrame.parentNode.removeChild(activePrintFrame);
  activePrintFrame = null;
}

/**
 * Resolve with `fallback` if `promise` does not settle within `timeoutMs`.
 * Rejections are also swallowed (replaced with `fallback`).
 */
function settleWithin<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(fallback);
    }, timeoutMs);
    // Use the two-argument form so rejections are handled and normalized to
    // `fallback` rather than surfacing as unhandled rejections.
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

/**
 * Resolve once the iframe fires `load`, or reject on an iframe `error` event or
 * timeout. Unlike the best-effort resource wait, a load failure must abort the
 * export — otherwise we could print about:blank / a partial document.
 */
function waitForIframeLoad(iframe: HTMLIFrameElement, timeoutMs: number): Promise<void> {
  const loaded = new Promise<void>((resolve, reject) => {
    iframe.addEventListener("load", () => resolve(), { once: true });
    iframe.addEventListener(
      "error",
      () => reject(new Error("The print iframe failed to load the article document.")),
      { once: true }
    );
  });
  return rejectAfterTimeout(
    loaded,
    timeoutMs,
    () => new Error(`Timed out after ${timeoutMs}ms waiting for the print iframe to load.`)
  );
}

async function waitForDocumentResources(doc: Document, timeoutMs: number): Promise<void> {
  // Fonts: document.fonts.ready resolves when all declared fonts have loaded.
  const fontsReady = (doc as Document & { fonts?: { ready?: Promise<unknown> } }).fonts?.ready;
  const fontsWaiter: Promise<unknown> = fontsReady ? Promise.resolve(fontsReady) : Promise.resolve();

  // Images: wait for every <img> in the document.
  const imageWaiters = Array.from(doc.images).map((image) =>
    image.complete
      ? Promise.resolve()
      : new Promise<void>((resolve) => {
          image.addEventListener("load", () => resolve(), { once: true });
          image.addEventListener("error", () => resolve(), { once: true });
        })
  );

  await settleWithin(Promise.all([fontsWaiter, ...imageWaiters]), timeoutMs, undefined);
}

/**
 * Send a complete HTML document to the browser's native print dialog using an
 * off-screen iframe with `srcdoc`.
 *
 * Phase 1 — Setup (bounded waits that abort on failure):
 *   Dispose the previous export's iframe, create a new one, wait for the
 *   document to load (10s timeout / rejects on error or timeout), verify the
 *   loaded document is not empty, then wait for fonts and images to settle
 *   (5s timeout, best-effort).
 *
 * Phase 2 — Print: opens the native print dialog via `iframe.contentWindow.print()`.
 *   After `print()` returns the iframe is **kept alive** in the DOM. Chromium
 *   renders the final PDF from the still-mounted frame only after the user
 *   closes the preview and confirms the file picker. Removing the frame before
 *   that (e.g. in `afterprint`) would produce a blank PDF. The iframe is
 *   cleaned up only at the start of the next export or on `pagehide`.
 *
 * @throws {Error} if the DOM is unavailable, iframe load times out / errors,
 *                 or the loaded document is empty — the export is aborted.
 */
async function browserPrintPdf(html: string): Promise<void> {
  if (typeof document === "undefined" || !document.body) {
    throw new Error("Browser PDF export requires a DOM environment.");
  }

  // Dispose the previous export's iframe (no print task is in progress because
  // the native print dialog is modal — the user cannot trigger a second export
  // while one is open).
  disposeActivePrintFrame();

  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.setAttribute("tabindex", "-1");
  iframe.style.position = "fixed";
  iframe.style.left = "-10000px";
  iframe.style.top = "0";
  iframe.style.width = "1024px";
  iframe.style.height = "768px";
  iframe.style.border = "0";
  iframe.style.opacity = "0";
  iframe.style.pointerEvents = "none";
  iframe.style.zIndex = "-1";

  try {
    // Set srcdoc before inserting so the load event fires for the target content.
    iframe.srcdoc = html;
    const loadPromise = waitForIframeLoad(iframe, PRINT_IFRAME_LOAD_TIMEOUT_MS);
    document.body.appendChild(iframe);
    await loadPromise;

    const contentWindow = iframe.contentWindow;
    const frameDocument = iframe.contentDocument;
    if (!contentWindow) {
      throw new Error("The print iframe has no contentWindow.");
    }
    // Verify the document is not about:blank / empty before printing.
    if (!frameDocument || frameDocument.readyState !== "complete" || !frameDocument.body || frameDocument.body.childNodes.length === 0) {
      throw new Error(
        "The print iframe did not load the article document " +
        `(readyState: ${frameDocument?.readyState ?? "none"}, hasBody: ${Boolean(frameDocument?.body)}, bodyEmpty: ${!frameDocument?.body?.childNodes.length}).`
      );
    }

    await waitForDocumentResources(frameDocument, PRINT_RESOURCE_TIMEOUT_MS);

    // Register a pagehide listener to clean up this frame when the page
    // navigates away.  AbortController allows cancellation from dispose().
    const abort = new AbortController();
    window.addEventListener("pagehide", () => {
      if (activePrintFrame === iframe) disposeActivePrintFrame();
    }, { signal: abort.signal, once: true });
    activePrintFrame = iframe;
    activePrintFrameAbort = abort;

    contentWindow.focus();
    contentWindow.print();
    // print() returned: dialog was presented. The iframe is intentionally kept
    // alive.  Chromium renders the final PDF from the still-mounted frame only
    // after the user closes the preview and confirms the file picker.  The
    // frame will be cleaned up at the start of the next export or on pagehide.
  } catch (error) {
    // Covers load/resource timeouts and print() throw errors.
    // Only dispose if this frame is still the active one (defensive against
    // hypothetical concurrent scenarios).
    if (activePrintFrame === iframe) disposeActivePrintFrame();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Main export entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point: export a PDF for the given article.
 *
 * **Electron path** (when `window.blogSystemDesktop` is available):
 * Builds a complete HTML document and sends it via IPC to the main process,
 * which opens a native save dialog and generates the PDF in a dedicated hidden
 * BrowserWindow.
 *
 * **Browser path** (fallback):
 * Builds the same HTML document and renders it in an off-screen iframe, then
 * calls the browser's native print dialog (the user may choose "Save as PDF").
 * The iframe is kept alive after printing so Chromium can render the final PDF
 * from the still-mounted frame — removing it before the save completes would
 * produce a blank PDF. Settings are applied as @page CSS and additional print
 * CSS; browser limitations mean scale and print-background cannot be enforced.
 *
 * @returns `{ canceled, filePath?, method }` where
 *   - `method === "electron"`: `canceled` reflects the native save dialog;
 *     `filePath` is set if the user confirmed.
 *   - `method === "browser"`: `canceled` is always `false` — browsers cannot
 *     distinguish print vs cancel; `filePath` is not set.
 * @throws {Error} If rendering, fetching, or printing fails.
 */
export async function exportArticlePdf(
  articlePath: string,
  settings: PdfExportSettings,
  options: {
    /** Markdown content to render (pre-resolved). */
    markdown: string;
    /** Article title for the PDF filename. */
    title: string;
    /** Article directory for relative URL rewriting. */
    directory: string;
    /** Active theme groups with their CSS/JS asset configs. */
    themeGroups: ThemeGroupSummary[];
    /** Bump version for theme asset cache busting. */
    renderStyleAssetVersion: number;
  }
): Promise<PdfExportResult> {
  // Render markdown
  const articleHtml = await renderArticleHtml(options.markdown, options.directory);

  // Fetch theme CSS — each enabled group independently selects CSS files whose
  // colorMode matches its own group.mode (matching listEnabledThemeAssets semantics).
  const themeCssLinks = await fetchThemeCssLinks(
    options.themeGroups,
    options.renderStyleAssetVersion
  );

  // <base> lets relative asset URLs (images, etc.) resolve when the document
  // is loaded from a BrowserWindow or iframe with a different base URL.
  const baseUrl = window.location.origin;

  const desktopApi = window.blogSystemDesktop;
  if (desktopApi?.printCurrentWindowToPdf) {
    // -----------------------------------------------------------------------
    // Electron path — IPC to main process.
    //
    // No browser print overrides: Electron applies printBackground/scale via
    // printToPDF options, so embedding CSS for them would double-apply.
    // -----------------------------------------------------------------------
    const html = buildPdfHtml(
      options.title,
      articleHtml,
      settings,
      themeCssLinks,
      katexCssProcessed,
      highlightThemeCss,
      { baseUrl }
    );

    const safeFileName = options.title
      .replace(/[^a-zA-Z0-9_\- ]/g, "")
      .trim()
      .replace(/\s+/g, "_");
    const printRequest: PdfPrintRequest = {
      defaultFileName: `${safeFileName || "article"}.pdf`,
      pageSize: settings.pageSize,
      landscape: settings.orientation === "landscape",
      printBackground: settings.printBackground,
      scale: settings.scale,
      marginsMm: settings.marginsMm,
      html
    };

    const result = await desktopApi.printCurrentWindowToPdf(printRequest);
    return { canceled: result.canceled, filePath: result.filePath, method: "electron" };
  }

  // -----------------------------------------------------------------------
  // Browser path — iframe + native print dialog.
  //
  // Includes browser print overrides because the browser print dialog cannot
  // receive printToPDF-style options.
  // -----------------------------------------------------------------------
  const html = buildPdfHtml(
    options.title,
    articleHtml,
    settings,
    themeCssLinks,
    katexCssProcessed,
    highlightThemeCss,
    { baseUrl, browserPrintOverrides: true }
  );

  await browserPrintPdf(html);
  return { canceled: false, method: "browser" };
}

export {
  fetchThemeCssLinks,
  renderArticleHtml,
  resolveArticleContent,
  buildPdfHtml,
  buildPageCss,
  buildBrowserPrintCss,
  PDF_PRINT_CSS
};
