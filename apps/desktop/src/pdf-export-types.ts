/**
 * Shared types for the Electron PDF export IPC bridge.
 *
 * Margin units: millimeters (mm) on the wire. The handler converts them to
 * inches (mm ÷ 25.4), because Electron 42's printToPDF custom margin values
 * are interpreted as inches (the "in pixels" doc in electron.d.ts is stale).
 * If the renderer provides CSS-driven margins via @page, set `preferCSSPageSize`
 * to true (the handler does this). Custom margin values pass through with
 * marginType: 'custom'; they override CSS page margins.
 */

export const VALID_PAGE_SIZES = [
  "A0", "A1", "A2", "A3", "A4", "A5", "A6",
  "Legal", "Letter", "Tabloid", "Ledger",
] as const;

export type PageSizeString = (typeof VALID_PAGE_SIZES)[number];

export interface PrintPdfMarginsMm {
  /** Top margin in millimeters */
  top: number;
  /** Right margin in millimeters */
  right: number;
  /** Bottom margin in millimeters */
  bottom: number;
  /** Left margin in millimeters */
  left: number;
}

export interface PrintPdfRequest {
  /**
   * Desired filename (without path). The handler takes only the basename,
   * strips both `/` and `\\` separators, and appends ".pdf" if missing.
   * Empty/null string falls back to "article".
   */
  defaultFileName: string;

  /** Page size. Defaults to "A4" if invalid/missing. */
  pageSize?: PageSizeString;

  /** Landscape orientation. Defaults to false. */
  landscape?: boolean;

  /** Print background colors/images. Defaults to false. */
  printBackground?: boolean;

  /** Scale factor (0.1 – 2.0). Clamped on receive. Defaults to 1. */
  scale?: number;

  /**
   * Generate a tagged (accessible) PDF with document structure.
   * Maps to Electron's experimental `generateTaggedPDF`. Defaults to false.
   */
  documentOutline?: boolean;

  /**
   * Custom margins in **millimeters**. The handler converts mm to inches
   * (mm ÷ 25.4) because Electron 42's printToPDF interprets custom margin
   * values as inches, not pixels (the "pixels" doc in electron.d.ts is stale).
   *
   * When absent, CSS @page margin rules are honored (preferCSSPageSize=true).
   */
  marginsMm?: PrintPdfMarginsMm;

  /**
   * Pre-rendered article HTML document (complete with all CSS inlined).
   * When provided, the main process creates a dedicated hidden BrowserWindow
   * with this content and calls printToPDF on that window instead of on the
   * admin BrowserWindow. This avoids capturing the admin UI chrome.
  */
  html?: string;
}

export type PrintPdfResult =
  | { canceled: true; filePath?: undefined }
  | { canceled: false; filePath: string };
