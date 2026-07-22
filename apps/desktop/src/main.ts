import { app, BrowserWindow, Menu, dialog } from "electron";
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { startAdminHostServer, type RunningAdminHost } from "./admin-host";
import { loadDesktopRuntimeConfig } from "./runtime-config";

const DESKTOP_SHORTCUT_CHANNEL = "blog-system:workbench-shortcut";
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

interface DesktopCredentials {
  adminPassword: string;
  sessionSecret: string;
}

function ensureDesktopCredentials(): DesktopCredentials {
  // The embedded server is imported into this process, so it reads the same
  // environment. `??=` keeps credentials the user exported before launching,
  // otherwise we generate per-launch random ones; the preload script exposes
  // them to the renderer for login prefill via window.desktopAuth.
  process.env.ADMIN_PASSWORD ??= randomBytes(12).toString("base64url");
  process.env.SESSION_SECRET ??= randomBytes(32).toString("base64url");

  return {
    adminPassword: process.env.ADMIN_PASSWORD,
    sessionSecret: process.env.SESSION_SECRET
  };
}

async function startEmbeddedServer(serverPort: number, credentials: DesktopCredentials) {
  writeDebugLog(`starting embedded server on ${serverPort}`);
  const serverEntry = path.join(getProjectRoot(), "apps", "server", "dist", "index.cjs");
  const serverModule = (await import(pathToFileURL(serverEntry).href)) as {
    startServer(customSettings?: {
      adminPassword?: string;
      port?: number;
      sessionSecret?: string;
    }): Promise<{ close(): Promise<void> }>;
  };

  return serverModule.startServer({
    port: serverPort,
    adminPassword: credentials.adminPassword,
    sessionSecret: credentials.sessionSecret
  });
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
        const credentials = ensureDesktopCredentials();
        nextEmbeddedServer = await startEmbeddedServer(runtimeConfig.serverPort, credentials);
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
