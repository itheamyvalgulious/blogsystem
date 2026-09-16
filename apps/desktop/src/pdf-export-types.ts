/**
 * Shared types for the Electron PDF export IPC bridge.
 *
 * Margin units: millimeters (mm) on the wire. The handler converts them to
 * Electron's internal pixel unit (1 mm ≈ 3.779527559 px at 96 DPI).
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
   * Custom margins in **millimeters**. The handler converts mm to pixels
   * (1 mm = 3.779527559 px at 96 DPI) and passes them to Electron's
   * PrintToPDFOptions with marginType: 'custom'.
   *
   * When absent, CSS @page margin rules are honored (preferCSSPageSize=true).
   */
  marginsMm?: PrintPdfMarginsMm;
}

export type PrintPdfResult =
  | { canceled: true; filePath?: undefined }
  | { canceled: false; filePath: string };