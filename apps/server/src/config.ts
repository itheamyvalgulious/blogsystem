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
}

export function getDefaultSettings(): ServerSettings {
  return {
    assetsRoot: workspacePaths.assetsRoot,
    adminDistDir: path.join(projectRoot, "apps", "admin", "dist"),
    adminPassword: process.env.ADMIN_PASSWORD ?? "changeme123",
    adminUsername: process.env.ADMIN_USERNAME ?? "admin",
    configRoot: workspacePaths.configRoot,
    contentRoot: workspacePaths.contentRoot,
    editorConfigDir: workspacePaths.editorConfigDir,
    npmCommand: process.platform === "win32" ? "npm.cmd" : "npm",
    projectRoot,
    projectsRoot: workspacePaths.projectsRoot,
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? "127.0.0.1",
    sessionSecret: process.env.SESSION_SECRET ?? "blog-system-dev-session-secret",
    siteDistDir: path.join(projectRoot, "apps", "site", "dist"),
    workspaceRoot: workspacePaths.workspaceRoot
  };
}
