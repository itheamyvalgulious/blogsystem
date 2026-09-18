import { app, BrowserWindow, ipcMain, Menu, dialog } from "electron";
import { appendFileSync, existsSync, statSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { startAdminHostServer, type RunningAdminHost } from "./admin-host";
import { loadDesktopRuntimeConfig } from "./runtime-config";
import {
  type PageSizeString,
  type PrintPdfResult,
  VALID_PAGE_SIZES,
} from "./pdf-export-types";
import {
  clamp,
  ensurePdfExtension,
  formatBytes,
  printMarginsMmToInches,
  sanitizePdfFilename,
  shouldConfirmPdfOverwrite,
  withTimeout,
} from "./pdf-export-helpers";

const DESKTOP_SHORTCUT_CHANNEL = "blog-system:workbench-shortcut";
const PRINT_TO_PDF_CHANNEL = "blog-system:print-to-pdf";
const DEV_START_URL = process.env.BLOG_SYSTEM_ELECTRON_START_URL?.trim();
const IS_DEV = Boolean(DEV_START_URL);

// Timeout values for PDF generation stages (milliseconds).
const LOAD_HTML_TIMEOUT_MS = 30_000;
const FONT_IMAGE_TIMEOUT_MS = 15_000;
const PRINT_TO_PDF_TIMEOUT_MS = 30_000;

let adminHost: RunningAdminHost | null = null;
let embeddedServer: { close(): Promise<void> } | null = null;
let runtimeStartUrl: string | null = null;
let runtimeStartupPromise: Promise<string> | null = null;
let isQuitting = false;

function writeDebugLog(message: string) {
  const debugLogPath = process.env.BLOG_SYSTEM_ELECTRON_DEBUG_LOG?.trim();

  if (!debugLogPath) {
    return;
  }

  try {
    appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // Debug logging is best-effort. A write failure must never interrupt
    // or break the PDF export flow, so errors are silently swallowed.
  }
}

function showDesktopError(error: unknown) {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  writeDebugLog(`error: ${message}`);
  console.error(message);
  dialog.showErrorBox("Blog System Desktop Error", message);
}

function getProjectRoot() {
  return path.resolve(__dirname, "../../..");
}

function getAdminDistPath() {
  return path.join(getProjectRoot(), "apps", "admin", "dist");
}

function getPreloadPath() {
  return path.join(__dirname, "preload.js");
}

function isWorkbenchShortcut(input: {
  alt: boolean;
  code: string;
  control: boolean;
  key: string;
  meta: boolean;
  shift: boolean;
  type: string;
}) {
  if (input.type !== "keyDown" || !(input.control || input.meta) || input.alt || input.shift) {
    return false;
  }

  return (
    /^Digit[1-9]$/.test(input.code) ||
    input.code === "KeyW" ||
    input.code === "PageUp" ||
    input.code === "PageDown"
  );
}

function forwardWorkbenchShortcut(window: BrowserWindow, input: Parameters<NonNullable<BrowserWindow["webContents"]["on"]>>[1] extends never ? never : any) {
  window.webContents.send(DESKTOP_SHORTCUT_CHANNEL, {
    altKey: input.alt === true,
    code: input.code,
    ctrlKey: input.control === true,
    key: input.key,
    metaKey: input.meta === true,
    shiftKey: input.shift === true
  });
}

/**
 * Wait until fonts and images are ready, with a hard timeout so a single
 * unloadable resource can never hang PDF generation forever.
 *
 * The returned promise always resolves (never rejects): if the timeout fires
 * we log a warning and proceed to print with whatever is already rendered.
 */
async function waitForResourcesReady(window: BrowserWindow): Promise<void> {
  const script = `Promise.race([
    Promise.all([
      document.fonts ? document.fonts.ready : Promise.resolve(),
      ...Array.from(document.images, image => image.complete
        ? Promise.resolve()
        : new Promise(resolve => {
            image.addEventListener("load", resolve, { once: true });
            image.addEventListener("error", resolve, { once: true });
          }))
    ]).then(() => "ready", () => "ready"),
    new Promise(resolve => setTimeout(() => resolve("timeout"), ${FONT_IMAGE_TIMEOUT_MS}))
  ])`;

  let outcome: unknown;
  try {
    // The injected script already races against FONT_IMAGE_TIMEOUT_MS; this
    // outer timeout is a second safety net in case the renderer itself stops
    // responding and never settles `executeJavaScript`.
    outcome = await withTimeout(
      window.webContents.executeJavaScript(script),
      FONT_IMAGE_TIMEOUT_MS + 5_000,
      "Waiting for fonts/images"
    );
  } catch (error) {
    // A script error / timeout should not abort generation — print what we have.
    writeDebugLog(
      `pdf-export: resource-wait failed, proceeding: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  if (outcome === "timeout") {
    writeDebugLog(
      `pdf-export: font/image wait timed out after ${FONT_IMAGE_TIMEOUT_MS}ms, proceeding to print`
    );
  }
}

/**
 * Create a temporary hidden BrowserWindow, load the given HTML document,
 * generate a PDF, then close the window and return the PDF buffer.
 *
 * The HTML is written to a temporary file to avoid CORS restrictions when
 * loading resources (images, fonts) from the admin server. The file is
 * cleaned up after PDF generation.
 *
 * Every failure is wrapped with the stage that produced it so the UI can
 * show a diagnosable message.
 */
async function generatePdfFromHtml(
  html: string,
  printOptions: Electron.PrintToPDFOptions
): Promise<Buffer> {
  const tempDir = await mkdtemp(path.join(app.getPath("temp"), "blog-system-pdf-"));
  const tempFile = path.join(tempDir, "article.html");
  let pdfWindow: BrowserWindow | null = null;

  try {
    writeDebugLog(`pdf-export: rendering started (html bytes=${html.length})`);

    try {
      await writeFile(tempFile, html, "utf8");
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeDebugLog(`pdf-export: failed to write temp HTML: ${detail}`);
      throw new Error(`Failed to write temporary HTML file: ${detail}`);
    }

    pdfWindow = new BrowserWindow({
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    try {
      await withTimeout(
        pdfWindow.loadURL(pathToFileURL(tempFile).href),
        LOAD_HTML_TIMEOUT_MS,
        "Loading HTML in hidden window"
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeDebugLog(`pdf-export: failed to load HTML: ${detail}`);
      throw new Error(`Failed to load HTML in hidden window: ${detail}`);
    }

    await waitForResourcesReady(pdfWindow);

    let buffer: Buffer;
    try {
      buffer = await withTimeout(
        pdfWindow.webContents.printToPDF(printOptions),
        PRINT_TO_PDF_TIMEOUT_MS,
        "Rendering PDF"
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeDebugLog(`pdf-export: failed to render PDF: ${detail}`);
      throw new Error(`Failed to render PDF: ${detail}`);
    }

    if (!buffer || buffer.length === 0) {
      writeDebugLog("pdf-export: failed to render PDF: printToPDF returned an empty buffer");
      throw new Error("Failed to render PDF: printToPDF returned an empty buffer");
    }

    writeDebugLog(
      `pdf-export: rendering completed (pdf bytes=${buffer.length}, ${formatBytes(buffer.length)})`
    );
    return buffer;
  } finally {
    if (pdfWindow && !pdfWindow.isDestroyed()) {
      pdfWindow.destroy();
    }
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // Temp cleanup is best-effort.
    }
  }
}

async function handlePrintToPdf(
  event: Electron.IpcMainInvokeEvent,
  request: unknown
): Promise<PrintPdfResult> {
  // --- Guard: null / non-object / missing renderer ---
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("Invalid print-to-pdf request: expected a non-null object");
  }

  const body = request as Record<string, unknown>;
  const window = BrowserWindow.fromWebContents(event.sender);

  if (!window) {
    throw new Error("No BrowserWindow found for the sender");
  }

  // --- Validate / clamp untrusted renderer values ---
  const filename = sanitizePdfFilename(
    typeof body.defaultFileName === "string" ? body.defaultFileName : ""
  );
  const pageSize: PageSizeString | "A4" = VALID_PAGE_SIZES.includes(body.pageSize as PageSizeString)
    ? (body.pageSize as PageSizeString)
    : "A4";
  const landscape = body.landscape === true;
  const printBackground = body.printBackground === true;
  const scale = clamp(typeof body.scale === "number" ? body.scale : 1, 0.1, 2.0);
  const generateTaggedPDF = body.documentOutline === true;
  const html = typeof body.html === "string" ? body.html : undefined;
  // --- Native save dialog ---
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: "Export Article as PDF",
    defaultPath: filename,
    filters: [{ name: "PDF Files", extensions: ["pdf"] }],
  });

  if (canceled || !filePath) {
    writeDebugLog("pdf-export: save dialog canceled");
    return { canceled: true };
  }

  // The save dialog may return a path without a `.pdf` suffix (the user can
  // type anything, and the filter is only a hint). Normalise it so what we
  // write and what we report always match. Existing casing is preserved.
  const targetPath = ensurePdfExtension(filePath);
  writeDebugLog(`pdf-export: target path chosen (${targetPath})`);

  // If we changed the path (appended .pdf) and the target already exists,
  // the native save dialog's overwrite confirmation does not cover it.
  // Show a secondary confirmation to preserve overwrite semantics.
  if (shouldConfirmPdfOverwrite(filePath, targetPath, existsSync(targetPath))) {
    const { response } = await dialog.showMessageBox(window, {
      type: "warning",
      buttons: ["Cancel", "Overwrite"],
      defaultId: 0,
      cancelId: 0,
      title: "Confirm overwrite",
      message: `"${path.basename(targetPath)}" already exists.`,
      detail: "The original filename did not include a .pdf extension. Do you want to replace the existing file with the exported PDF?",
    });

    if (response !== 1) {
      writeDebugLog("pdf-export: overwrite confirmation declined");
      return { canceled: true };
    }

    writeDebugLog("pdf-export: overwrite confirmed");
  }

  // --- Build Electron print options ---
  const printOptions: Electron.PrintToPDFOptions = {
    landscape,
    printBackground,
    scale,
    pageSize,
    preferCSSPageSize: true,
    generateTaggedPDF,
  };

  // Custom margins — Electron interprets custom margin numbers as inches
  // (verified on Electron 42; the "pixels" doc in electron.d.ts is stale).
  // Convert the renderer's millimeter values, clamped to the dialog's 0–50 mm range.
  const marginsMm = body.marginsMm;
  if (marginsMm && typeof marginsMm === "object") {
    printOptions.margins = {
      marginType: "custom",
      ...printMarginsMmToInches(marginsMm as Record<string, unknown>),
    };
  }

  // --- Generate PDF ---
  let pdfBuffer: Buffer;

  if (html) {
    // Renderer provided the article HTML — use a dedicated hidden window
    // to avoid capturing the admin UI chrome.
    pdfBuffer = await generatePdfFromHtml(html, printOptions);
  } else {
    // Fallback: capture the admin window (legacy path)
    try {
      pdfBuffer = await withTimeout(
        window.webContents.printToPDF(printOptions),
        PRINT_TO_PDF_TIMEOUT_MS,
        "Rendering PDF (fallback path)"
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      writeDebugLog(`pdf-export: fallback render failed: ${detail}`);
      throw new Error(`Failed to render PDF (fallback path): ${detail}`);
    }

    if (!pdfBuffer || pdfBuffer.length === 0) {
      writeDebugLog("pdf-export: fallback render returned empty buffer");
      throw new Error("Failed to render PDF (fallback path): printToPDF returned an empty buffer");
    }

    writeDebugLog(
      `pdf-export: fallback rendering completed (pdf bytes=${pdfBuffer.length}, ${formatBytes(pdfBuffer.length)})`
    );
  }

  // --- Write to chosen path ---
  writeDebugLog(`pdf-export: writing to ${targetPath} (${pdfBuffer.length} bytes)`);

  try {
    await writeFile(targetPath, pdfBuffer);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeDebugLog(`pdf-export: write failed (${targetPath}): ${detail}`);
    throw new Error(`Failed to write PDF file: ${detail}`);
  }

  // Verify the file after writing.
  try {
    const stats = statSync(targetPath);
    if (!stats.isFile()) {
      throw new Error(`Not a regular file`);
    }
    if (stats.size === 0) {
      throw new Error(`Written file is empty`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    writeDebugLog(`pdf-export: post-write validation failed (${targetPath}): ${detail}`);
    throw new Error(`PDF file validation failed after write: ${detail}`);
  }

  writeDebugLog("pdf-export: write completed and verified successfully");
  return { canceled: false, filePath: targetPath };
}

async function startEmbeddedServer(serverPort: number) {
  writeDebugLog(`starting embedded server on ${serverPort}`);
  const serverEntry = path.join(getProjectRoot(), "apps", "server", "dist", "index.cjs");
  const serverModule = (await import(pathToFileURL(serverEntry).href)) as {
    startServer(customSettings?: { port?: number }): Promise<{
      close(): Promise<void>;
      settings: {
        adminPassword: string;
        adminUsername: string;
      };
    }>;
  };

  const runningServer = await serverModule.startServer({ port: serverPort });

  // Let the server resolve credentials through its normal chain first:
  // environment > workspace config/admin.local.json > generated fallback.
  // Copy the resolved values into the Electron process only after startup so
  // the preload can prefill the same credentials that the server accepts.
  process.env.ADMIN_USERNAME = runningServer.settings.adminUsername;
  process.env.ADMIN_PASSWORD = runningServer.settings.adminPassword;

  return runningServer;
}

async function ensureDesktopRuntime() {
  if (IS_DEV) {
    writeDebugLog(`using dev start url ${DEV_START_URL}`);
    return DEV_START_URL!;
  }

  if (runtimeStartUrl) {
    return runtimeStartUrl;
  }

  if (runtimeStartupPromise) {
    return runtimeStartupPromise;
  }

  runtimeStartupPromise = (async () => {
    writeDebugLog("loading desktop runtime config");
    const runtimeConfig = await loadDesktopRuntimeConfig({
      isPackaged: app.isPackaged,
      projectRoot: getProjectRoot(),
      resourcesPath: process.resourcesPath
    });
    writeDebugLog(`runtime config loaded: ${JSON.stringify(runtimeConfig)}`);

    let nextEmbeddedServer: { close(): Promise<void> } | null = null;

    try {
      if (runtimeConfig.mode === "local") {
        nextEmbeddedServer = await startEmbeddedServer(runtimeConfig.serverPort);
        embeddedServer = nextEmbeddedServer;
      }

      const targetBaseUrl =
        runtimeConfig.mode === "local"
          ? `http://127.0.0.1:${runtimeConfig.serverPort}`
          : runtimeConfig.serverBaseUrl!;

      adminHost = await startAdminHostServer({
        adminDistDir: getAdminDistPath(),
        port: runtimeConfig.adminPort,
        targetBaseUrl
      });
      writeDebugLog(`admin host listening on ${runtimeConfig.adminPort}, target=${targetBaseUrl}`);

      runtimeStartUrl = `http://127.0.0.1:${runtimeConfig.adminPort}/admin/`;
      return runtimeStartUrl;
    } catch (error) {
      if (nextEmbeddedServer) {
        await nextEmbeddedServer.close().catch(() => undefined);
        embeddedServer = null;
      }

      throw error;
    } finally {
      runtimeStartupPromise = null;
    }
  })();

  return runtimeStartupPromise;
}

async function shutdownDesktopRuntime() {
  const nextAdminHost = adminHost;
  const nextEmbeddedServer = embeddedServer;

  adminHost = null;
  embeddedServer = null;
  runtimeStartUrl = null;

  await nextAdminHost?.close().catch(() => undefined);
  await nextEmbeddedServer?.close().catch(() => undefined);
}

async function createMainWindow() {
  const startUrl = await ensureDesktopRuntime();

  const window = new BrowserWindow({
    autoHideMenuBar: true,
    backgroundColor: "#202a33",
    height: 960,
    minHeight: 720,
    minWidth: 1180,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: getPreloadPath(),
      sandbox: false
    },
    width: 1480
  });

  window.webContents.on("before-input-event", (event, input) => {
    if (!isWorkbenchShortcut(input)) {
      return;
    }

    event.preventDefault();
    forwardWorkbenchShortcut(window, input);
  });

  window.once("ready-to-show", () => {
    window.show();
  });

  await window.loadURL(startUrl);
  return window;
}

process.on("uncaughtException", (error) => {
  showDesktopError(error);
});

process.on("unhandledRejection", (error) => {
  showDesktopError(error);
});

app.whenReady()
  .then(async () => {
    ipcMain.handle(PRINT_TO_PDF_CHANNEL, handlePrintToPdf);
    Menu.setApplicationMenu(null);
    await createMainWindow();

    app.on("activate", async () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        await createMainWindow();
      }
    });
  })
  .catch((error) => {
    showDesktopError(error);
    app.exit(1);
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", (event) => {
  if (IS_DEV || isQuitting) {
    return;
  }

  event.preventDefault();
  isQuitting = true;
  void shutdownDesktopRuntime().finally(() => {
    app.exit(0);
  });
});
