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

/**
 * CSS injected only during PDF rendering.
 *
 * - `.no-pdf` blocks are hidden from the print output.
 * - `background-image: none` on html/body: a painted canvas background on
 *   the root, combined with full-page semi-transparent layers (e.g. the
 *   fixed `.paper-background` in the atlas theme), makes Chromium's print
 *   pipeline emit pages that render blank in pdfium (the PDF viewer in
 *   Chrome/Edge). The root therefore never paints background images.
 * - `.paper-background` (a DOM node the PDF template always emits, so this
 *   selector is system-controlled) instead carries the theme's site
 *   background image and base color as a single multi-background layer.
 *   Verified empirically: painting the image on the decoration container
 *   itself renders correctly in pdfium (the image shows up in the page
 *   margins), while an extra sibling layer carrying the image still
 *   triggers the blank-page bug. Themes with `--site-background-image:
 *   none` (the default) degrade to a solid `--bg` page base — visually
 *   identical to the site's paper look.
 */

/**
 * Background-bake script injected into PDF HTML documents to work around
 * extreme pdfium rendering slowness with CSS gradient backgrounds.
 *
 * ## Problem (empirically verified)
 *
 * Chromium's printBackground export converts CSS gradients (linear-gradient,
 * radial-gradient, conic-gradient) into PDF tiling patterns / shadings (Skia
 * encoding). The pdfium renderer (used by Chrome/Edge built-in PDF viewer)
 * handles these constructs extremely poorly — it must compute each tile
 * individually rather than blitting a pre-rendered image. Measured results
 * on a 6-page document with atlas theme decorative gradient layers:
 *   - Full document load: 6.4s (vs ~0.3s after bake)
 *   - Single page at high zoom: 19s (vs ~0.9s after bake)
 *   - PDF pattern count: hundreds (vs 0 after bake)
 *
 * ## Baking strategy
 *
 * 1. **Fixed decoration stack → one full-page raster**: The
 *    `.paper-background` container and its children (grain, geometry) compose
 *    a fixed overlay above the article content. These are rendered into a
 *    single PNG via SVG foreignObject → Canvas2D → toDataURL, then set as a
 *    static `background-image` on the container. The original child elements
 *    are hidden (display:none) so they do not re-contribute gradient layers.
 *
 * 2. **Flow elements with non-repeating gradients → per-element raster**:
 *    Every element with a gradient background whose layers fully cover the
 *    element (auto / 100% / cover / contain) is individually baked to a PNG
 *    in the same way. Repeating gradients are skipped — they already produce
 *    acceptable pdfium performance because pdfium handles the repeating
 *    pattern at the image level rather than as tiling shadings.
 *
 * ## Failure semantics
 *
 * The entire bake is wrapped in try/catch. If any step throws (SVG
 * serialization, canvas allocation, toDataURL failure) that job is skipped
 * and the element's original CSS is left intact. The attribute
 * `data-pdf-bake-done` is set to `"ok:N"` on success or `"error"` on
 * exception. Callers should await `window.__pdfBakePromise` before
 * triggering print; if the bake never resolves or errors out, printing
 * proceeds with the original (slow) CSS — degraded performance but no
 * content loss.
 */
export const PDF_BAKE_SCRIPT = `window.__pdfBakePromise = (async function () {
  try {
    var de = document.documentElement;
    var PW = parseFloat(de.getAttribute("data-pdf-page-width-px") || "0");
    var PH = parseFloat(de.getAttribute("data-pdf-page-height-px") || "0");
    if (!PW || !PH) return;

    var SVGNS = "http://www.w3.org/2000/svg";

    function bakeToDataUrl(w, h, innerCss) {
      return new Promise(function (resolve) {
        var svg = document.createElementNS(SVGNS, "svg");
        svg.setAttribute("width", String(Math.round(w)));
        svg.setAttribute("height", String(Math.round(h)));
        var fo = document.createElementNS(SVGNS, "foreignObject");
        fo.setAttribute("width", "100%");
        fo.setAttribute("height", "100%");
        var div = document.createElement("div");
        div.setAttribute(
          "style",
          "width:" + Math.round(w) + "px;height:" + Math.round(h) + "px;" + innerCss
        );
        fo.appendChild(div);
        svg.appendChild(fo);
        var xml = new XMLSerializer().serializeToString(svg);
        var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
        var img = new Image();
        img.onload = function () {
          try {
            var canvas = document.createElement("canvas");
            canvas.width = Math.round(w);
            canvas.height = Math.round(h);
            var ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL("image/png"));
          } catch (e) {
            resolve(null);
          }
        };
        img.onerror = function () {
          resolve(null);
        };
        img.src = url;
      });
    }

    function computedBgCss(el) {
      var cs = getComputedStyle(el);
      return (
        "background-color:" + cs.backgroundColor + ";" +
        "background-image:" + cs.backgroundImage + ";" +
        "background-size:" + cs.backgroundSize + ";" +
        "background-position:" + cs.backgroundPosition + ";" +
        "background-repeat:" + cs.backgroundRepeat + ";" +
        "background-origin:" + cs.backgroundOrigin + ";" +
        "background-clip:" + cs.backgroundClip + ";"
      );
    }

    function setImportant(el, prop, value) {
      el.style.setProperty(prop, value, "important");
    }

    var jobs = [];

    // --- 1. Fixed decoration stack -> one full-page image ---
    var pb = document.querySelector(".paper-background");
    if (pb) {
      var grain = pb.querySelector(".paper-background__grain");
      var geo = pb.querySelector(".paper-background__geometry");
      var siteVar = getComputedStyle(de).getPropertyValue("--site-background-image").trim();
      var bgVar = getComputedStyle(de).getPropertyValue("--bg").trim();
      var siteCss = "";
      if (siteVar && siteVar !== "none") {
        var m = /^url\\(\\s*(['"]?)([^'"]+)\\1\\s*\\)$/.exec(siteVar.replace(/\\s+/g, " "));
        if (m && m[2]) {
          var abs = null;
          try {
            abs = new URL(m[2], document.baseURI).href;
          } catch (e) {
            abs = null;
          }
          if (abs) {
            siteCss = "background-image:url('" + abs + "');background-size:cover;background-position:center;background-repeat:no-repeat;";
          } else {
            siteCss = null; // unparseable URL: skip stack bake entirely
          }
        } else {
          siteCss = null; // unparseable: skip stack bake entirely
        }
      }
      if (siteCss !== null) {
        jobs.push((async function () {
          // Compose carrier + children in one foreignObject
          var svg = document.createElementNS(SVGNS, "svg");
          svg.setAttribute("width", String(Math.round(PW)));
          svg.setAttribute("height", String(Math.round(PH)));
          var fo = document.createElementNS(SVGNS, "foreignObject");
          fo.setAttribute("width", "100%");
          fo.setAttribute("height", "100%");
          var root = document.createElement("div");
          root.setAttribute(
            "style",
            "position:relative;width:" + Math.round(PW) + "px;height:" + Math.round(PH) +
              "px;background-color:" + (bgVar || "#ffffff") + ";" + siteCss
          );
          [grain, geo].forEach(function (el) {
            if (el) {
              var child = document.createElement("div");
              var cs = getComputedStyle(el);
              child.setAttribute(
                "style",
                "position:absolute;left:0;top:0;width:100%;height:100%;opacity:" +
                  cs.opacity + ";" + computedBgCss(el)
              );
              root.appendChild(child);
            }
          });
          fo.appendChild(root);
          svg.appendChild(fo);
          var xml = new XMLSerializer().serializeToString(svg);
          var url = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(xml);
          var data = await new Promise(function (resolve) {
            var img = new Image();
            img.onload = function () {
              try {
                var canvas = document.createElement("canvas");
                canvas.width = Math.round(PW);
                canvas.height = Math.round(PH);
                var ctx = canvas.getContext("2d");
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL("image/png"));
              } catch (e) {
                resolve(null);
              }
            };
            img.onerror = function () {
              resolve(null);
            };
            img.src = url;
          });
          if (!data) return;
          setImportant(pb, "background-image", 'url("' + data + '")');
          setImportant(pb, "background-repeat", "no-repeat");
          setImportant(pb, "background-position", "0% 0%");
          setImportant(pb, "background-size", "100% 100%");
          setImportant(pb, "background-color", "transparent");
          [grain, geo].forEach(function (el) {
            if (el) setImportant(el, "display", "none");
          });
        })());
      }
    }

    // --- 2. Flow elements with non-repeating gradient backgrounds ---
    var all = document.querySelectorAll("body *");
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el === document.body || el === document.documentElement) continue;
      if (el.closest(".paper-background")) continue;
      var cs = getComputedStyle(el);
      var bi = cs.backgroundImage;
      if (!bi || bi === "none") continue;
      if (bi.indexOf("gradient(") === -1) continue;
      if (bi.indexOf("repeating-") !== -1) continue;
      // Per-layer size check: conservative whitelist of full-size backgrounds
      // (auto, cover, contain, 100%, 100% 100%, auto 100%, 100% auto, auto auto).
      // Disallow non-full sizes like '100% 2px' or '40px 100%' so they are not
      // incorrectly stretched to 100% 100%.
      var sizes = cs.backgroundSize.split(",");
      var safe = true;
      for (var s = 0; s < sizes.length; s++) {
        var t = sizes[s].trim().replace(/\\s+/g, " ");
        if (t === "auto" || t === "cover" || t === "contain" || t === "100%") continue;
        var parts = t.split(" ");
        if (
          parts.length === 2 &&
          (parts[0] === "100%" || parts[0] === "auto") &&
          (parts[1] === "100%" || parts[1] === "auto")
        ) {
          continue;
        }
        safe = false;
        break;
      }
      if (!safe) continue;
      var rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      (function (target, w, h, css, radius) {
        jobs.push(
          bakeToDataUrl(w, h, css + "border-radius:" + radius + ";").then(function (data) {
            if (!data) return;
            setImportant(target, "background-image", 'url("' + data + '")');
            setImportant(target, "background-repeat", "no-repeat");
            setImportant(target, "background-position", "0% 0%");
            setImportant(target, "background-size", "100% 100%");
          })
        );
      })(el, rect.width, rect.height, computedBgCss(el), cs.borderRadius);
    }

    await Promise.all(jobs);
    de.setAttribute("data-pdf-bake-done", "ok:" + jobs.length);
  } catch (e) {
    try {
      document.documentElement.setAttribute("data-pdf-bake-done", "error");
    } catch (e2) { /* ignore */ }
  }
})();`;
export const PDF_PRINT_CSS = `
@media print {
  .no-pdf { display: none !important; }
  body {
    margin: 0;
    padding: 0;
  }
  html, body { background-image: none !important; }
  .paper-background {
    background: var(--site-background-image, none) center / cover no-repeat,
      var(--bg, #ffffff) !important;
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
 * The document also embeds the PDF background bake script
 * ({@link PDF_BAKE_SCRIPT}) which rasterises CSS gradient backgrounds to PNG
 * data URLs before printing, avoiding severe pdfium rendering slowness caused
 * by tiling patterns / shadings in Skia-encoded PDF output.
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

  // Page pixel dimensions for the background bake script.
  const { pageSize, orientation } = settings;
  const dims = PAGE_SIZE_CSS[pageSize];
  const mmToPx = (mm: number) => Math.round(mm * 96 / 25.4);
  const pageW = orientation === "landscape" ? mmToPx(dims.height) : mmToPx(dims.width);
  const pageH = orientation === "landscape" ? mmToPx(dims.width) : mmToPx(dims.height);

  return `<!DOCTYPE html>
<html data-pdf-page-width-px="${pageW}" data-pdf-page-height-px="${pageH}">
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
<script>
${PDF_BAKE_SCRIPT}
</script>
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

/**
 * Extract URL from a CSS `url(...)` value, supporting unquoted, single-quoted,
 * and double-quoted forms. Returns null for non-url, empty, or malformed strings.
 * Mirrors the regex and extraction discipline inside PDF_BAKE_SCRIPT.
 */
export function parseCssUrl(cssValue: string): string | null {
  const trimmed = cssValue.trim();
  const m = /^url\(\s*(['"]?)([^'"]+)\1\s*\)$/.exec(trimmed.replace(/\s+/g, " "));
  if (!m || !m[2]) return null;
  return m[2];
}

/**
 * Conservative check whether a CSS background-size specification covers the full area
 * across all layers (auto, cover, contain, 100%, 100% 100%, auto 100%, 100% auto, auto auto).
 * Rejects non-full sizes like `100% 2px` or `40px 100%`.
 * Mirrors the per-layer validation inside PDF_BAKE_SCRIPT.
 */
export function isFullSizeBackgroundSize(sizeStr: string): boolean {
  const sizes = sizeStr.split(",");
  for (let s = 0; s < sizes.length; s++) {
    const t = sizes[s].trim().replace(/\s+/g, " ");
    if (t === "auto" || t === "cover" || t === "contain" || t === "100%") {
      continue;
    }
    const parts = t.split(" ");
    if (
      parts.length === 2 &&
      (parts[0] === "100%" || parts[0] === "auto") &&
      (parts[1] === "100%" || parts[1] === "auto")
    ) {
      continue;
    }
    return false;
  }
  return true;
}
