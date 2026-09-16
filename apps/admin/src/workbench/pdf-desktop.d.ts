/**
 * Ambient type declaration for the Electron preload API exposed on
 * `window.blogSystemDesktop`.
 *
 * The preload script (apps/desktop/src/preload.ts) exposes this object
 * via `contextBridge.exposeInMainWorld`. The type must be kept in sync
 * with the actual preload implementation.
 */

import type { PdfPrintRequest, PdfPrintResult } from "./pdf-types";

declare global {
  interface Window {
    blogSystemDesktop?: {
      isElectron: boolean;
      printCurrentWindowToPdf: (request: PdfPrintRequest) => Promise<PdfPrintResult>;
    };
  }
}

export {};