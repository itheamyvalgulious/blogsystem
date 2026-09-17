/**
 * PDF export types — shared between the renderer dialog/service and the Electron
 * preload/main-process boundary.
 *
 * The preload exposes a single IPC method matching this shape:
 *
 *   window.blogSystemDesktop.printCurrentWindowToPdf(request)
 *
 * The main process receives the request via `ipcMain.handle` and uses Electron's
 * `webContents.printToPDF` (or a native print dialog via `BrowserWindow.webContents.print`).
 *
 * Margins: the main process may translate `marginsMm` either to native print
 * options or to `@page` CSS injected into the renderer document. The behaviour
 * is coherent as long as one side takes ownership of margin control (see
 * pdf-export.ts for the renderer-side `@page` CSS approach).
 */

/** Supported page sizes for PDF export. */
export type PdfPageSize = "A4" | "A5" | "Letter" | "Legal";

/** Orientation mode. */
export type PdfOrientation = "portrait" | "landscape";

/** Margin values in millimetres. */
export interface PdfMarginsMm {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Settings the user picks in the export dialog. */
export interface PdfExportSettings {
  pageSize: PdfPageSize;
  orientation: PdfOrientation;
  marginsMm: PdfMarginsMm;
  scale: number;
  printBackground: boolean;
}

/** The exact shape sent to the preload IPC. */
export interface PdfPrintRequest {
  defaultFileName: string;
  pageSize: PdfPageSize;
  landscape: boolean;
  printBackground: boolean;
  scale: number;
  marginsMm: PdfMarginsMm;

  /**
   * Pre-rendered article HTML document (complete with all CSS inlined).
   * The main process uses a dedicated hidden BrowserWindow instead of
   * printing the admin BrowserWindow, so the PDF captures only the article.
  */
  html?: string;
}

/** The response from the preload IPC after the print dialog resolves. */
export interface PdfPrintResult {
  canceled: boolean;
  filePath?: string;
}

/** Which export pipeline handled a PDF export request. */
export type PdfExportMethod = "electron" | "browser";

/**
 * The unified result from exportArticlePdf.
 *
 * - Electron path (`method: "electron"`): `canceled` comes from the save dialog;
 *   `filePath` contains the chosen path when the user confirmed.
 * - Browser path (`method: "browser"`): `canceled` is always `false` — browsers
 *   cannot distinguish print vs cancel via `window.print()`; `filePath` is unset.
 */
export interface PdfExportResult {
  method: PdfExportMethod;
  canceled: boolean;
  filePath?: string;
}

/** Default settings for a fresh export dialog. */
export const DEFAULT_PDF_SETTINGS: PdfExportSettings = {
  pageSize: "A4",
  orientation: "portrait",
  marginsMm: { top: 20, right: 15, bottom: 20, left: 15 },
  scale: 1,
  printBackground: false
};

/** Map from page size to CSS dimensions (mm) for @page. */
export const PAGE_SIZE_CSS: Record<PdfPageSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
  Letter: { width: 215.9, height: 279.4 },
  Legal: { width: 215.9, height: 355.6 }
};
