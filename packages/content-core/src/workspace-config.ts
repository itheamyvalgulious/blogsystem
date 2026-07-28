import { readFileSync } from "node:fs";
import path from "node:path";

export interface WorkspaceConfigFile {
  workspace: string;
}

export interface WorkspacePaths {
  assetsRoot: string;
  codeRoot: string;
  configRoot: string;
  contentRoot: string;
  editorConfigDir: string;
  projectsRoot: string;
  workspaceRoot: string;
}

/**
 * Reads `config.json` at the code root to find the workspace path.
 * `BLOG_SYSTEM_WORKSPACE` env overrides it (for CI/tests). All other
 * config (credentials, AI, editor settings) lives in the workspace's
 * `config/` subdirectory.
 */
export function loadWorkspacePaths(codeRoot: string): WorkspacePaths {
  const configPath = path.join(codeRoot, "config.json");
  const envWorkspaceValue = process.env.BLOG_SYSTEM_WORKSPACE?.trim();
  const rawConfig = envWorkspaceValue ? null : readFileSync(configPath, "utf8");
  const parsed = rawConfig ? (JSON.parse(rawConfig) as Partial<WorkspaceConfigFile>) : {};
  const workspaceValue = envWorkspaceValue ?? parsed.workspace?.trim();

  if (!workspaceValue) {
    throw new Error(`"workspace" is required in ${configPath}.`);
  }

  const workspaceRoot = path.resolve(codeRoot, workspaceValue);

  return {
    assetsRoot: path.join(workspaceRoot, "assets"),
    codeRoot,
    configRoot: path.join(workspaceRoot, "config"),
    contentRoot: path.join(workspaceRoot, "content"),
    editorConfigDir: path.join(workspaceRoot, "config", "editor"),
    projectsRoot: path.join(workspaceRoot, "projects"),
    workspaceRoot
  };
}
