import { app, BrowserWindow, ipcMain, Menu, dialog } from "electron";
import { appendFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { startAdminHostServer, type RunningAdminHost } from "./admin-host";
import { loadDesktopRuntimeConfig } from "./runtime-config";
import {
  type PageSizeString,
  type PrintPdfResult,
  VALID_PAGE_SIZES,
} from "./pdf-export-types";

const DESKTOP_SHORTCUT_CHANNEL = "blog-system:workbench-shortcut";
const PRINT_TO_PDF_CHANNEL = "blog-system:print-to-pdf";
const DEV_START_URL = process.env.BLOG_SYSTEM_ELECTRON_START_URL?.trim();
const IS_DEV = Boolean(DEV_START_URL);

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

  appendFileSync(debugLogPath, `[${new Date().toISOString()}] ${message}\n`, "utf8");
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

function sanitizePdfFilename(input: string): string {
  // Normalize both / and \\ separators so path.basename catches everything
  const normalized = (input || "article").replace(/[/\\]/g, path.sep);
  const name = path.basename(normalized);
  // Ensure .pdf extension
  return name.toLowerCase().endsWith(".pdf") ? name : `${name}.pdf`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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

  // --- Native save dialog ---
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: "Export Article as PDF",
    defaultPath: filename,
    filters: [{ name: "PDF Files", extensions: ["pdf"] }],
  });

  if (canceled || !filePath) {
    return { canceled: true };
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

  // Custom margins — convert mm → px (96 DPI: 1 mm ≈ 3.779527559 px)
  const marginsMm = body.marginsMm;
  if (marginsMm && typeof marginsMm === "object") {
    const mm = marginsMm as Record<string, unknown>;
    const mmToPx = (v: unknown) => clamp(typeof v === "number" ? v * 3.779527559 : 0, 0, 1000);
    printOptions.margins = {
      marginType: "custom",
      top: mmToPx(mm.top),
      bottom: mmToPx(mm.bottom),
      left: mmToPx(mm.left),
      right: mmToPx(mm.right),
    };
  }

  // --- Generate PDF ---
  const pdfBuffer = await window.webContents.printToPDF(printOptions);

  // --- Write to chosen path ---
  await writeFile(filePath, pdfBuffer);

  return { canceled: false, filePath };
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
