import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadWorkspacePaths } from "@blog-system/content-core/node";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const projectRoot = path.resolve(currentDir, "../../..");
const workspacePaths = loadWorkspacePaths(projectRoot);

export interface ServerSettings {
  assetsRoot: string;
  adminDistDir: string;
  adminPassword: string;
  adminUsername: string;
  configRoot: string;
  contentRoot: string;
  editorConfigDir: string;
  npmCommand: string;
  projectRoot: string;
  projectsRoot: string;
  port: number;
  host: string;
  sessionSecret: string;
  siteDistDir: string;
  workspaceRoot: string;
  /** True when `adminPassword` was randomly generated because ADMIN_PASSWORD was not set. */
  generatedAdminPassword?: boolean;
}

function generateAdminPassword() {
  // 12 random bytes -> 16 base64url characters.
  return crypto.randomBytes(12).toString("base64url");
}

function generateSessionSecret() {
  return crypto.randomBytes(32).toString("base64url");
}

function isLoopbackHost(host: string) {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

// Credentials are announced at most once per process, so callers that build
// several apps in one process (tests, the desktop runtime) do not spam the
// terminal with passwords that their explicit settings later override.
let hasAnnouncedCredentialState = false;

function announceCredentialState(settings: ServerSettings, sessionSecretFromEnv: boolean) {
  if (hasAnnouncedCredentialState) {
    return;
  }
  hasAnnouncedCredentialState = true;

  if (settings.generatedAdminPassword) {
    console.log("[blog-system] ADMIN_PASSWORD is not set; generated a random admin password for this run:");
    console.log(`[blog-system]   admin username: ${settings.adminUsername}`);
    console.log(`[blog-system]   admin password: ${settings.adminPassword}`);
    console.log("[blog-system] Set the ADMIN_PASSWORD environment variable to use a fixed password.");
  }

  if (!isLoopbackHost(settings.host) && (settings.generatedAdminPassword || !sessionSecretFromEnv)) {
    console.warn("[blog-system] *** SECURITY WARNING ***");
    console.warn(
      `[blog-system] Binding to non-loopback host "${settings.host}" without explicit ADMIN_PASSWORD/SESSION_SECRET.`
    );
    console.warn("[blog-system] Sessions are signed with an ephemeral secret and the admin password is random.");
    console.warn("[blog-system] Set ADMIN_PASSWORD and SESSION_SECRET before exposing this server to a network.");
  }
}

export function getDefaultSettings(): ServerSettings {
  const envAdminPassword = process.env.ADMIN_PASSWORD?.trim();
  const envSessionSecret = process.env.SESSION_SECRET?.trim();

  const settings: ServerSettings = {
    assetsRoot: workspacePaths.assetsRoot,
    adminDistDir: path.join(projectRoot, "apps", "admin", "dist"),
    adminPassword: envAdminPassword || generateAdminPassword(),
    adminUsername: process.env.ADMIN_USERNAME ?? "admin",
    configRoot: workspacePaths.configRoot,
    contentRoot: workspacePaths.contentRoot,
    editorConfigDir: workspacePaths.editorConfigDir,
    npmCommand: process.platform === "win32" ? "npm.cmd" : "npm",
    projectRoot,
    projectsRoot: workspacePaths.projectsRoot,
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? "127.0.0.1",
    sessionSecret: envSessionSecret || generateSessionSecret(),
    siteDistDir: path.join(projectRoot, "apps", "site", "dist"),
    workspaceRoot: workspacePaths.workspaceRoot,
    generatedAdminPassword: !envAdminPassword
  };

  announceCredentialState(settings, Boolean(envSessionSecret));

  return settings;
}
