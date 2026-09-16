import { contextBridge, ipcRenderer } from "electron";

import type { PrintPdfRequest, PrintPdfResult } from "./pdf-export-types";

const DESKTOP_SHORTCUT_CHANNEL = "blog-system:workbench-shortcut";
const PRINT_TO_PDF_CHANNEL = "blog-system:print-to-pdf";

function dispatchWorkbenchShortcut(payload: {
  altKey: boolean;
  code: string;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}) {
  const eventInit: KeyboardEventInit = {
    altKey: payload.altKey,
    bubbles: true,
    cancelable: true,
    code: payload.code,
    ctrlKey: payload.ctrlKey,
    key: payload.key,
    metaKey: payload.metaKey,
    shiftKey: payload.shiftKey
  };

  const event = new KeyboardEvent("keydown", eventInit);
  document.dispatchEvent(event);
  window.dispatchEvent(new KeyboardEvent("keydown", eventInit));
}

window.addEventListener("DOMContentLoaded", () => {
  ipcRenderer.on(DESKTOP_SHORTCUT_CHANNEL, (_event, payload) => {
    dispatchWorkbenchShortcut(payload);
  });
});

contextBridge.exposeInMainWorld("blogSystemDesktop", {
  isElectron: true,

  /** Open the native save dialog and export the current window as PDF. */
  printCurrentWindowToPdf(request: PrintPdfRequest): Promise<PrintPdfResult> {
    return ipcRenderer.invoke(PRINT_TO_PDF_CHANNEL, request);
  },
});

// The main process sets ADMIN_USERNAME/ADMIN_PASSWORD to the credentials
// resolved by the embedded server. Renderer processes inherit the environment,
// so we can offer the same credentials here for login prefill.
contextBridge.exposeInMainWorld("desktopAuth", {
  getCredentials(): { username: string; password: string } | null {
    const username = process.env.ADMIN_USERNAME?.trim() || "admin";
    const password = process.env.ADMIN_PASSWORD;

    if (!password) {
      return null;
    }

    return { username, password };
  }
});
