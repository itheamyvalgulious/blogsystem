/**
 * PDF export renderer service.
 *
 * Builds a temporary DOM containing only the article content, loads the same
 * static-site theme CSS assets (in the same order as the preview/static site),
 * preserves KaTeX/code/highlight/custom-fence output, injects print CSS, and
 * triggers the Electron print-to-PDF IPC.
 *
 * Every DOM mutation is cleaned up in a `finally` block. Fonts and images
 * referenced by the article are waited for (via
 * `document.fonts.ready` / image `onload`) before the IPC call.
 *
 * Margin control strategy:
 *   The renderer injects `@page` CSS with the user's margin values so the
 *   print output respects them regardless of how the main process translates
 *   the IPC payload. The main process (ipc handler) may still forward the
 *   marginsMm field to `webContents.printToPDF` options as a secondary layer;
 *   if both are set, the more restrictive rule wins.
 */

import {
  renderMarkdownWithKatex,
  rewriteManagedMediaTextReferences,
  rewriteManagedMediaUrls,
  rewriteRelativeAssetUrls,
  getErrorMessage,
  highlightThemeCss,
  type ArticleRecord,
  type ThemeGroupSummary
} from "@blog-system/content-core";
import katexCssRaw from "katex/dist/katex.min.css?raw";

import type { PdfExportSettings, PdfPrintRequest } from "./pdf-types";
import { buildPdfHtml, buildPageCss, PDF_PRINT_CSS, escapeHtmlAttribute } from "./pdf-render-helpers";

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
 * Fetch theme group CSS assets (the same set used by the preview/static site)
 * and return them as inline <style> elements with rewritten media URL references.
 */
async function fetchThemeCssLinks(
  themeGroups: ThemeGroupSummary[],
  colorMode: "light" | "dark",
  renderStyleAssetVersion: number
): Promise<string[]> {
  const assets: Array<{ groupId: string; fileName: string }> = [];
  for (const group of themeGroups) {
    if (!group.enable) continue;
    for (const file of group.files) {
      if (file.type === "css" && file.colorMode === colorMode) {
        assets.push({ groupId: group.groupId, fileName: file.fileName });
      }
    }
  }

  const results = await Promise.allSettled(
    assets.map(async (asset) => {
      const href = buildThemeAssetUrl(asset.groupId, asset.fileName, renderStyleAssetVersion);
      const response = await fetch(href, { credentials: "include" });
      const cssText = rewriteManagedMediaTextReferences(await response.text(), "/media");
      return { groupId: asset.groupId, cssText };
    })
  );

  const linkElements: string[] = [];
  for (const result of results) {
    if (result.status === "fulfilled") {
      linkElements.push(
        `<style data-theme-group="${escapeHtmlAttribute(result.value.groupId)}">\n${result.value.cssText}\n</style>`
      );
    }
  }
  return linkElements;
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
// Main export entry point
// ---------------------------------------------------------------------------

/**
 * Main entry point: export a PDF for the given article.
 *
 * 1. Resolves content (draft or API).
 * 2. Parses frontmatter to get title/directory.
 * 3. Renders markdown via the shared pipeline.
 * 4. Fetches theme CSS assets.
 * 5. Builds a complete HTML document.
 * 6. Creates a temporary hidden iframe, loads the HTML, waits for fonts/images.
 * 7. Calls the Electron preload print-to-PDF IPC.
 * 8. Cleans up the iframe in `finally`.
 *
 * @throws {Error} If not running in Electron (blogSystemDesktop API missing).
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
    /** Current color mode (light/dark) matching the preview theme. */
    colorMode: "light" | "dark";
    /** Bump version for theme asset cache busting. */
    renderStyleAssetVersion: number;
  }
): Promise<{ canceled: boolean; filePath?: string }> {
  const desktopApi = window.blogSystemDesktop;
  if (!desktopApi?.printCurrentWindowToPdf) {
    throw new Error(
      "PDF export is only available in the Electron desktop application. " +
      "The printCurrentWindowToPdf API was not found on window.blogSystemDesktop."
    );
  }

  // Build the print request
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
    marginsMm: settings.marginsMm
  };

  // Render markdown
  const articleHtml = await renderArticleHtml(options.markdown, options.directory);

  // Fetch theme CSS
  const themeCssLinks = await fetchThemeCssLinks(
    options.themeGroups,
    options.colorMode,
    options.renderStyleAssetVersion
  );

  // Build the full HTML document
  const html = buildPdfHtml(options.title, articleHtml, settings, themeCssLinks, katexCssRaw, highlightThemeCss);

  // Create a temporary hidden iframe for rendering
  const iframe = document.createElement("iframe");
  iframe.style.cssText =
    "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;border:none;visibility:hidden";
  iframe.srcdoc = html;
  document.body.appendChild(iframe);

  try {
    // Wait for the iframe to load
    await new Promise<void>((resolve, reject) => {
      iframe.onload = () => resolve();
      iframe.onerror = () => reject(new Error("Failed to load PDF preview iframe"));
      // srcdoc may fire load synchronously in some engines; set a safety timer
      const timer = setTimeout(() => resolve(), 500);
      const originalResolve = resolve;
      iframe.onload = () => {
        clearTimeout(timer);
        originalResolve();
      };
    });

    // Wait for web fonts to load inside the iframe
    if (iframe.contentDocument?.fonts) {
      await iframe.contentDocument.fonts.ready;
    }

    // Wait for images to load inside the iframe
    const images = iframe.contentDocument?.querySelectorAll("img") ?? [];
    if (images.length > 0) {
      await Promise.allSettled(
        Array.from(images).map(
          (img) =>
            new Promise<void>((resolve) => {
              if (img.complete) {
                resolve();
              } else {
                img.onload = () => resolve();
                img.onerror = () => resolve(); // don't block on broken images
              }
            })
        )
      );
    }

    // Call the preload IPC
    const result = await desktopApi.printCurrentWindowToPdf(printRequest);
    return result;
  } finally {
    // Clean up the iframe
    try {
      if (iframe.parentNode) {
        iframe.parentNode.removeChild(iframe);
      }
    } catch {
      // Ignore cleanup errors
    }
  }
}

export {
  fetchThemeCssLinks,
  renderArticleHtml,
  resolveArticleContent,
  buildPdfHtml,
  buildPageCss,
  PDF_PRINT_CSS
};