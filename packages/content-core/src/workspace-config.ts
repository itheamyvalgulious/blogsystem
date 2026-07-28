import { existsSync, readFileSync } from "node:fs";
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

const DEFAULT_WORKSPACE_DIRNAME = "blog-workspace";

/**
 * Resolves the workspace root in priority order:
 * 1. `BLOG_SYSTEM_WORKSPACE` env (absolute or relative to code root)
 * 2. `../blog-workspace` sibling of the code root (convention)
 * 3. Legacy `config.json` in the code root (backward compat, gitignored)
 *
 * This keeps all machine-local data in the workspace directory; the code
 * repository stays free of local config files.
 */
export function loadWorkspacePaths(codeRoot: string): WorkspacePaths {
  const envWorkspaceValue = process.env.BLOG_SYSTEM_WORKSPACE?.trim();

  let workspaceRoot: string | undefined;

  if (envWorkspaceValue) {
    workspaceRoot = path.resolve(codeRoot, envWorkspaceValue);
  }

  // Convention: a sibling `blog-workspace` next to the code repo.
  if (!workspaceRoot) {
    const sibling = path.resolve(codeRoot, "..", DEFAULT_WORKSPACE_DIRNAME);
    if (existsSync(sibling)) {
      workspaceRoot = sibling;
    }
  }

  // Legacy: config.json in the code root (gitignored, backward compat).
  if (!workspaceRoot) {
    const legacyPath = path.join(codeRoot, "config.json");
    if (existsSync(legacyPath)) {
      try {
        const parsed = JSON.parse(readFileSync(legacyPath, "utf8")) as Partial<WorkspaceConfigFile>;
        const legacyValue = parsed.workspace?.trim();
        if (legacyValue) {
          workspaceRoot = path.resolve(codeRoot, legacyValue);
        }
      } catch {
        // Malformed legacy config — fall through to the error below.
      }
    }
  }

  if (!workspaceRoot) {
    throw new Error(
      `Workspace not found. Set BLOG_SYSTEM_WORKSPACE, place a sibling "${DEFAULT_WORKSPACE_DIRNAME}/" next to the code, or create config.json with {"workspace": "/abs/path"}.`
    );
  }

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
