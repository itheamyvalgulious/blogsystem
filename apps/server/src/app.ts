import { promises as fs } from "node:fs";
import path from "node:path";

import cors from "cors";
import express from "express";
import session from "express-session";

import { readArticle } from "@blog-system/content-core/node";

import type { ServerSettings } from "./config.js";
import { loadAdminHomeConfig, saveAdminHomeConfig } from "./admin-home-config-service.js";
import { listMediaAssets, savePastedImages } from "./asset-service.js";
import { getDefaultSettings } from "./config.js";
import {
  createArticleFile,
  createFileSystemEntry,
  deleteFileSystemEntry,
  DuplicateArticleTitleError,
  ensureContentRoot,
  getTreePayload,
  renameFileSystemEntry,
  readFileSystemMetadata,
  saveArticleContent,
  saveFileSystemMetadata,
  transferFileSystemEntry,
  updateArticleStatus
} from "./content-service.js";
import {
  loadEditorConfig,
  saveEditorConfig,
  validateEditorConfigPayload
} from "./editor-config-service.js";
import {
  createGitCommit,
  ensureGitRepository,
  getGitHistory,
  getGitOverview,
  getGitStatus,
  pushGitChanges
} from "./git-service.js";
import { publishSite } from "./publish-service.js";
import { loadPublishConfig, savePublishConfig } from "./publish-config-service.js";
import { loadMarkdownBlockConfig, saveMarkdownBlockConfig } from "./markdown-block-config-service.js";
import {
  MarkdownSearchError,
  previewMarkdownSearch,
  replaceAllMarkdownSearch,
  replaceNextMarkdownSearch
} from "./markdown-search-service.js";
import { loadSiteConfig, saveSiteConfig } from "./site-config-service.js";
import {
  createProject,
  deleteProject,
  createProjectLog,
  createProjectTask,
  listProjectLogs,
  listProjects,
  listProjectTasks,
  readProject,
  readProjectLog,
  readProjectTask,
  saveProject,
  saveProjectLog,
  saveProjectTask
} from "./project-service.js";
import {
  createThemeAsset,
  createThemeGroup,
  deleteThemeAsset,
  deleteThemeGroup,
  getThemeGroupsRoot,
  listThemeGroups,
  readThemeAsset,
  readThemeGroupConfig,
  renameThemeAsset,
  renameThemeGroup,
  saveThemeAsset,
  saveThemeGroupConfig
} from "./theme-group-service.js";
import { loadUsageStats, recordUsageStats } from "./usage-stats-service.js";

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!req.session.isAuthenticated) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  next();
}

export function createApp(customSettings?: Partial<ServerSettings>) {
  const settings = {
    ...getDefaultSettings(),
    ...customSettings
  };

  const app = express();
  app.use(
    cors({
      origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
      credentials: true
    })
  );
  app.use(express.json({ limit: "25mb" }));
  app.use(
    session({
      secret: settings.sessionSecret,
      resave: false,
      saveUninitialized: false,
      cookie: {
        httpOnly: true,
        sameSite: "lax"
      }
    })
  );

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.post("/api/auth/login", async (req, res) => {
    const { username, password } = req.body as { username?: string; password?: string };

    if (username !== settings.adminUsername || password !== settings.adminPassword) {
      res.status(401).json({ error: "Invalid credentials." });
      return;
    }

    req.session.isAuthenticated = true;
    res.json({ ok: true, username: settings.adminUsername });
  });

  app.post("/api/auth/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
  });

  app.use("/api", requireAuth);

  app.get("/api/tree", async (_req, res, next) => {
    try {
      await ensureContentRoot(settings.contentRoot);
      res.json(await getTreePayload(settings.contentRoot));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/article", async (req, res, next) => {
    try {
      const relativePath = String(req.query.path ?? "");
      res.json(await readArticle(settings.contentRoot, relativePath));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/article", async (req, res, next) => {
    try {
      const { path: relativePath, rawContent } = req.body as {
        path?: string;
        rawContent?: string;
      };

      if (!relativePath || typeof rawContent !== "string") {
        res.status(400).json({ error: "Both path and rawContent are required." });
        return;
      }

      res.json(await saveArticleContent(settings.contentRoot, relativePath, rawContent));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/article/new", async (req, res, next) => {
    try {
      const { directoryPath = "", fileName } = req.body as {
        directoryPath?: string;
        fileName?: string;
      };

      if (!fileName) {
        res.status(400).json({ error: "fileName is required." });
        return;
      }

      res.json(await createArticleFile(settings.contentRoot, directoryPath, fileName));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/article/status", async (req, res, next) => {
    try {
      const { path: relativePath, status } = req.body as {
        path?: string;
        status?: "draft" | "working" | "published";
      };

      if (!relativePath || (status !== "draft" && status !== "working" && status !== "published")) {
        res.status(400).json({ error: "Valid path and status are required." });
        return;
      }

      res.json(await updateArticleStatus(settings.contentRoot, relativePath, status));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/tags", async (_req, res, next) => {
    try {
      const payload = await getTreePayload(settings.contentRoot);
      res.json(payload.tags);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/search/markdown/preview", async (req, res, next) => {
    try {
      const { flags, pattern, replace, scope } = req.body as {
        flags?: string;
        pattern?: string;
        replace?: string;
        scope?: "body" | "wholeFile";
      };

      res.json(
        await previewMarkdownSearch(settings.contentRoot, {
          flags,
          pattern: pattern ?? "",
          replace: replace ?? "",
          scope: scope ?? "body"
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/search/markdown/replace-next", async (req, res, next) => {
    try {
      const { flags, matchKey, pattern, replace, scope } = req.body as {
        flags?: string;
        matchKey?: string;
        pattern?: string;
        replace?: string;
        scope?: "body" | "wholeFile";
      };

      res.json(
        await replaceNextMarkdownSearch(
          settings.contentRoot,
          {
            flags,
            pattern: pattern ?? "",
            replace: replace ?? "",
            scope: scope ?? "body"
          },
          matchKey ?? ""
        )
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/search/markdown/replace-all", async (req, res, next) => {
    try {
      const { flags, pattern, replace, scope } = req.body as {
        flags?: string;
        pattern?: string;
        replace?: string;
        scope?: "body" | "wholeFile";
      };

      res.json(
        await replaceAllMarkdownSearch(settings.contentRoot, {
          flags,
          pattern: pattern ?? "",
          replace: replace ?? "",
          scope: scope ?? "body"
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/editor-config", async (_req, res, next) => {
    try {
      const config = await loadEditorConfig(settings.editorConfigDir);
      const validation = validateEditorConfigPayload(
        config.markdownSnippets,
        config.latexSnippets,
        config.keybindings,
        config.editorAssociations
      );
      res.json({
        ...config,
        warnings: validation.warnings
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/editor-config", async (req, res, next) => {
    try {
      const { editorAssociationsRaw, markdownSnippetsRaw, latexSnippetsRaw, keybindingsRaw } = req.body as {
        editorAssociationsRaw?: string;
        markdownSnippetsRaw?: string;
        latexSnippetsRaw?: string;
        keybindingsRaw?: string;
      };

      if (
        typeof markdownSnippetsRaw !== "string" ||
        typeof latexSnippetsRaw !== "string" ||
        typeof keybindingsRaw !== "string" ||
        typeof editorAssociationsRaw !== "string"
      ) {
        res.status(400).json({
          error:
            "markdownSnippetsRaw, latexSnippetsRaw, keybindingsRaw, and editorAssociationsRaw are required."
        });
        return;
      }

      res.json(
        await saveEditorConfig(
          settings.editorConfigDir,
          markdownSnippetsRaw,
          latexSnippetsRaw,
          keybindingsRaw,
          editorAssociationsRaw
        )
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/site-config", async (_req, res, next) => {
    try {
      const config = await loadSiteConfig(settings.configRoot);
      res.json({
        raw: config.raw,
        value: config.value
      });
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/site-config", async (req, res, next) => {
    try {
      const { raw } = req.body as { raw?: string };

      if (typeof raw !== "string") {
        res.status(400).json({ error: "raw is required." });
        return;
      }

      res.json(await saveSiteConfig(settings.configRoot, raw));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/publish-config", async (_req, res, next) => {
    try {
      res.json(await loadPublishConfig(settings.configRoot));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/publish-config", async (req, res, next) => {
    try {
      const { raw } = req.body as { raw?: string };

      if (typeof raw !== "string") {
        res.status(400).json({ error: "raw is required." });
        return;
      }

      res.json(await savePublishConfig(settings.configRoot, raw));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/markdown-block-config", async (_req, res, next) => {
    try {
      res.json(await loadMarkdownBlockConfig(settings.configRoot));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/markdown-block-config", async (req, res, next) => {
    try {
      const { raw } = req.body as { raw?: string };

      if (typeof raw !== "string") {
        res.status(400).json({ error: "raw is required." });
        return;
      }

      res.json(await saveMarkdownBlockConfig(settings.configRoot, raw));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/admin-home-config", async (_req, res, next) => {
    try {
      res.json(await loadAdminHomeConfig(settings.configRoot));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/admin-home-config", async (req, res, next) => {
    try {
      const { raw } = req.body as { raw?: string };

      if (typeof raw !== "string") {
        res.status(400).json({ error: "raw is required." });
        return;
      }

      res.json(await saveAdminHomeConfig(settings.configRoot, raw));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/usage-stats", async (_req, res, next) => {
    try {
      res.json(await loadUsageStats(settings.configRoot));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/usage-stats", async (req, res, next) => {
    try {
      const { activeMilliseconds, documents } = req.body as {
        activeMilliseconds?: number;
        documents?: Array<{
          documentId?: string;
          documentKind?: string;
          title?: string;
          netCharacterDelta?: number;
        }>;
      };

      if (
        activeMilliseconds !== undefined &&
        (!Number.isFinite(activeMilliseconds) || Number(activeMilliseconds) < 0)
      ) {
        res.status(400).json({ error: "activeMilliseconds must be a non-negative number." });
        return;
      }

      if (documents !== undefined && !Array.isArray(documents)) {
        res.status(400).json({ error: "documents must be an array when provided." });
        return;
      }

      const normalizedDocuments = (documents ?? []).map((entry) => ({
        documentId: String(entry.documentId ?? "").trim(),
        documentKind: String(entry.documentKind ?? "").trim() || "unknown",
        title: String(entry.title ?? "").trim() || String(entry.documentId ?? "").trim(),
        netCharacterDelta: Number(entry.netCharacterDelta ?? 0)
      }));

      if (
        normalizedDocuments.some(
          (entry) => !entry.documentId || !Number.isFinite(entry.netCharacterDelta)
        )
      ) {
        res.status(400).json({
          error: "Each document entry requires documentId and a finite netCharacterDelta."
        });
        return;
      }

      res.json(
        await recordUsageStats(settings.configRoot, {
          activeMilliseconds,
          documents: normalizedDocuments
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/projects", async (_req, res, next) => {
    try {
      res.json(await listProjects(settings.projectsRoot));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/create", async (req, res, next) => {
    try {
      const { goal, targetDate, title } = req.body as {
        goal?: string;
        targetDate?: string;
        title?: string;
      };

      if (!title?.trim()) {
        res.status(400).json({ error: "title is required." });
        return;
      }

      res.json(
        await createProject(settings.projectsRoot, {
          goal,
          targetDate,
          title
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/project", async (req, res, next) => {
    try {
      const projectId = String(req.query.projectId ?? "");

      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }

      res.json(await readProject(settings.projectsRoot, projectId));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/project", async (req, res, next) => {
    try {
      const { projectId, raw } = req.body as { projectId?: string; raw?: string };

      if (!projectId || typeof raw !== "string") {
        res.status(400).json({ error: "projectId and raw are required." });
        return;
      }

      res.json(await saveProject(settings.projectsRoot, projectId, raw));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/delete", async (req, res, next) => {
    try {
      const { projectId } = req.body as { projectId?: string };

      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }

      res.json(await deleteProject(settings.projectsRoot, projectId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/project/tasks", async (req, res, next) => {
    try {
      const projectId = String(req.query.projectId ?? "");

      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }

      res.json(await listProjectTasks(settings.projectsRoot, projectId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/task/create", async (req, res, next) => {
    try {
      const { projectId, title } = req.body as { projectId?: string; title?: string };

      if (!projectId || !title?.trim()) {
        res.status(400).json({ error: "projectId and title are required." });
        return;
      }

      res.json(await createProjectTask(settings.projectsRoot, projectId, title));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/project/task", async (req, res, next) => {
    try {
      const projectId = String(req.query.projectId ?? "");
      const taskId = String(req.query.taskId ?? "");

      if (!projectId || !taskId) {
        res.status(400).json({ error: "projectId and taskId are required." });
        return;
      }

      res.json(await readProjectTask(settings.projectsRoot, projectId, taskId));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/project/task", async (req, res, next) => {
    try {
      const { projectId, raw, taskId } = req.body as {
        projectId?: string;
        raw?: string;
        taskId?: string;
      };

      if (!projectId || !taskId || typeof raw !== "string") {
        res.status(400).json({ error: "projectId, taskId, and raw are required." });
        return;
      }

      res.json(await saveProjectTask(settings.projectsRoot, projectId, taskId, raw));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/project/logs", async (req, res, next) => {
    try {
      const projectId = String(req.query.projectId ?? "");

      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }

      res.json(await listProjectLogs(settings.projectsRoot, projectId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/project/log/create", async (req, res, next) => {
    try {
      const { projectId, taskId, taskIds, type } = req.body as {
        projectId?: string;
        taskId?: string;
        taskIds?: string[];
        type?: string;
      };

      if (!projectId) {
        res.status(400).json({ error: "projectId is required." });
        return;
      }

      res.json(await createProjectLog(settings.projectsRoot, projectId, { taskId, taskIds, type }));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/project/log", async (req, res, next) => {
    try {
      const projectId = String(req.query.projectId ?? "");
      const logId = String(req.query.logId ?? "");

      if (!projectId || !logId) {
        res.status(400).json({ error: "projectId and logId are required." });
        return;
      }

      res.json(await readProjectLog(settings.projectsRoot, projectId, logId));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/project/log", async (req, res, next) => {
    try {
      const { logId, projectId, raw } = req.body as {
        logId?: string;
        projectId?: string;
        raw?: string;
      };

      if (!projectId || !logId || typeof raw !== "string") {
        res.status(400).json({ error: "projectId, logId, and raw are required." });
        return;
      }

      res.json(await saveProjectLog(settings.projectsRoot, projectId, logId, raw));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/theme-groups", async (_req, res, next) => {
    try {
      res.json(await listThemeGroups(settings.configRoot));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/theme-group", async (req, res, next) => {
    try {
      const groupId = String(req.query.group ?? "");

      if (!groupId) {
        res.status(400).json({ error: "group is required." });
        return;
      }

      res.json(await readThemeGroupConfig(settings.configRoot, groupId));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/theme-group", async (req, res, next) => {
    try {
      const { groupId, raw } = req.body as { groupId?: string; raw?: string };

      if (!groupId || typeof raw !== "string") {
        res.status(400).json({ error: "groupId and raw are required." });
        return;
      }

      res.json(await saveThemeGroupConfig(settings.configRoot, groupId, raw));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/theme-group/create", async (req, res, next) => {
    try {
      const { groupId } = req.body as { groupId?: string };

      if (!groupId?.trim()) {
        res.status(400).json({ error: "groupId is required." });
        return;
      }

      res.json(await createThemeGroup(settings.configRoot, groupId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/theme-group/rename", async (req, res, next) => {
    try {
      const { groupId, nextGroupId } = req.body as { groupId?: string; nextGroupId?: string };

      if (!groupId || !nextGroupId?.trim()) {
        res.status(400).json({ error: "groupId and nextGroupId are required." });
        return;
      }

      res.json(await renameThemeGroup(settings.configRoot, groupId, nextGroupId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/theme-group/delete", async (req, res, next) => {
    try {
      const { groupId } = req.body as { groupId?: string };

      if (!groupId) {
        res.status(400).json({ error: "groupId is required." });
        return;
      }

      res.json(await deleteThemeGroup(settings.configRoot, groupId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/theme-asset", async (req, res, next) => {
    try {
      const groupId = String(req.query.group ?? "");
      const fileName = String(req.query.file ?? "");

      if (!groupId || !fileName) {
        res.status(400).json({ error: "group and file are required." });
        return;
      }

      res.json(await readThemeAsset(settings.configRoot, groupId, fileName));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/theme-asset", async (req, res, next) => {
    try {
      const { groupId, fileName, raw } = req.body as { groupId?: string; fileName?: string; raw?: string };

      if (!groupId || !fileName || typeof raw !== "string") {
        res.status(400).json({ error: "groupId, fileName, and raw are required." });
        return;
      }

      res.json(await saveThemeAsset(settings.configRoot, groupId, fileName, raw));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/theme-asset/create", async (req, res, next) => {
    try {
      const { adminPreview = false, colorMode, fileName, groupId, type } = req.body as {
        adminPreview?: boolean;
        colorMode?: "light" | "dark";
        fileName?: string;
        groupId?: string;
        type?: "css" | "js";
      };

      if (!groupId || !fileName?.trim() || (type !== "css" && type !== "js")) {
        res.status(400).json({ error: "groupId, fileName, and type are required." });
        return;
      }

      res.json(await createThemeAsset(
        settings.configRoot,
        groupId,
        fileName,
        type,
        adminPreview === true,
        colorMode === "dark" ? "dark" : colorMode === "light" ? "light" : undefined
      ));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/theme-asset/rename", async (req, res, next) => {
    try {
      const { fileName, groupId, nextFileName } = req.body as {
        fileName?: string;
        groupId?: string;
        nextFileName?: string;
      };

      if (!groupId || !fileName || !nextFileName?.trim()) {
        res.status(400).json({ error: "groupId, fileName, and nextFileName are required." });
        return;
      }

      res.json(await renameThemeAsset(settings.configRoot, groupId, fileName, nextFileName));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/theme-asset/delete", async (req, res, next) => {
    try {
      const { fileName, groupId } = req.body as { fileName?: string; groupId?: string };

      if (!groupId || !fileName) {
        res.status(400).json({ error: "groupId and fileName are required." });
        return;
      }

      res.json(await deleteThemeAsset(settings.configRoot, groupId, fileName));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/fs/create", async (req, res, next) => {
    try {
      const { parentPath = "", entryType, name, metadata, allowDuplicateTitle } = req.body as {
        parentPath?: string;
        entryType?: "file" | "directory";
        name?: string;
        metadata?: Record<string, unknown>;
        allowDuplicateTitle?: boolean;
      };

      if ((entryType !== "file" && entryType !== "directory") || !name?.trim()) {
        res.status(400).json({ error: "Valid parentPath, entryType, and name are required." });
        return;
      }

      res.json(
        await createFileSystemEntry(settings.contentRoot, parentPath, entryType, name, metadata, {
          allowDuplicateTitle
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/fs/rename", async (req, res, next) => {
    try {
      const { path: relativePath, nextName, title, allowDuplicateTitle } = req.body as {
        path?: string;
        nextName?: string;
        title?: string;
        allowDuplicateTitle?: boolean;
      };

      if (!relativePath || !nextName?.trim()) {
        res.status(400).json({ error: "path and nextName are required." });
        return;
      }

      res.json(
        await renameFileSystemEntry(settings.contentRoot, relativePath, nextName, {
          allowDuplicateTitle,
          title
        })
      );
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/fs/metadata", async (req, res, next) => {
    try {
      const relativePath = String(req.query.path ?? "");

      if (!relativePath) {
        res.status(400).json({ error: "path is required." });
        return;
      }

      res.json(await readFileSystemMetadata(settings.contentRoot, relativePath));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/fs/metadata", async (req, res, next) => {
    try {
      const { path: relativePath, metadata } = req.body as {
        path?: string;
        metadata?: Record<string, unknown>;
      };

      if (!relativePath || !metadata || typeof metadata !== "object") {
        res.status(400).json({ error: "path and metadata are required." });
        return;
      }

      res.json(await saveFileSystemMetadata(settings.contentRoot, relativePath, metadata));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/fs/delete", async (req, res, next) => {
    try {
      const { path: relativePath } = req.body as {
        path?: string;
      };

      if (!relativePath) {
        res.status(400).json({ error: "path is required." });
        return;
      }

      await deleteFileSystemEntry(settings.contentRoot, relativePath);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/fs/transfer", async (req, res, next) => {
    try {
      const { sourcePath, targetDirectoryPath, mode } = req.body as {
        sourcePath?: string;
        targetDirectoryPath?: string;
        mode?: "copy" | "move";
      };

      if (!sourcePath || typeof targetDirectoryPath !== "string" || (mode !== "copy" && mode !== "move")) {
        res.status(400).json({ error: "sourcePath, targetDirectoryPath, and mode are required." });
        return;
      }

      res.json(
        await transferFileSystemEntry(settings.contentRoot, sourcePath, targetDirectoryPath, mode)
      );
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/assets/paste-image", async (req, res, next) => {
    try {
      const { articlePath, images } = req.body as {
        articlePath?: string;
        images?: Array<{
          mimeType?: string;
          base64Data?: string;
          fileName?: string;
        }>;
      };

      if (!articlePath || !Array.isArray(images) || images.length === 0) {
        res.status(400).json({ error: "articlePath and at least one image are required." });
        return;
      }

      const invalidImage = images.find(
        (image) =>
          typeof image.mimeType !== "string" ||
          !image.mimeType.startsWith("image/") ||
          typeof image.base64Data !== "string" ||
          image.base64Data.length === 0
      );

      if (invalidImage) {
        res.status(400).json({ error: "Each pasted image must include mimeType and base64Data." });
        return;
      }

      const savedAssets = await savePastedImages(
        settings.assetsRoot,
        images as Array<{ mimeType: string; base64Data: string; fileName?: string }>
      );

      res.json({ assets: savedAssets });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media", async (_req, res, next) => {
    try {
      res.json({
        assets: await listMediaAssets(settings.assetsRoot)
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/media", async (req, res, next) => {
    try {
      const { images } = req.body as {
        images?: Array<{
          mimeType?: string;
          base64Data?: string;
          fileName?: string;
        }>;
      };

      if (!Array.isArray(images) || images.length === 0) {
        res.status(400).json({ error: "At least one image is required." });
        return;
      }

      const invalidImage = images.find(
        (image) =>
          typeof image.mimeType !== "string" ||
          !image.mimeType.startsWith("image/") ||
          typeof image.base64Data !== "string" ||
          image.base64Data.length === 0
      );

      if (invalidImage) {
        res.status(400).json({ error: "Each image must include mimeType and base64Data." });
        return;
      }

      const assets = await savePastedImages(
        settings.assetsRoot,
        images as Array<{ mimeType: string; base64Data: string; fileName?: string }>
      );
      res.json({ assets });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/publish", async (_req, res, next) => {
    try {
      res.json(await publishSite(settings));
    } catch (error) {
      // Surface PublishTargetError fields (target / phase / HTTP status) so the
      // admin toast can show e.g. "Publish failed (cloudflare/upload-assets):
      // 401 invalid token" instead of just "publish failed".
      const targetError = error as Error & {
        target?: string;
        phase?: string;
        status?: number;
        detail?: string;
      };
      if (targetError && (targetError.target || targetError.phase)) {
        res.status(500).json({
          error: targetError.message,
          target: targetError.target,
          phase: targetError.phase,
          status: targetError.status,
          detail: targetError.detail
        });
        return;
      }
      next(error);
    }
  });

  app.get("/api/git/status", async (_req, res, next) => {
    try {
      const overview = await getGitOverview(settings.workspaceRoot);
      res.json({
        files: overview.files,
        initialized: overview.initialized
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/git/history", async (_req, res, next) => {
    try {
      const overview = await getGitOverview(settings.workspaceRoot);
      res.json({
        commits: overview.commits,
        initialized: overview.initialized
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/git/commit", async (req, res, next) => {
    try {
      const { message } = req.body as { message?: string };

      if (!message?.trim()) {
        res.status(400).json({ error: "message is required." });
        return;
      }

      res.json(await createGitCommit(settings.workspaceRoot, message.trim()));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/git/push", async (_req, res, next) => {
    try {
      res.json(await pushGitChanges(settings.workspaceRoot));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/git/init", async (_req, res, next) => {
    try {
      res.json(await ensureGitRepository(settings.workspaceRoot));
    } catch (error) {
      next(error);
    }
  });

  // These static mounts serve raw content/theme/media to the authenticated
  // admin frontend (preview assets, theme preview, media library). They must
  // NOT be public: /content-files exposes raw article markdown, including the
  // frontmatter `password:` of protected articles, which would otherwise let
  // an unauthenticated reader defeat the runtime AES-GCM protection by simply
  // fetching the source. Gate them behind the session.
  app.use("/content-files", requireAuth, express.static(settings.contentRoot));
  app.use("/media", requireAuth, express.static(settings.assetsRoot));
  app.use("/theme-files", requireAuth, express.static(getThemeGroupsRoot(settings.configRoot)));

  app.get("/admin/*splat", async (_req, res, next) => {
    try {
      const indexPath = path.join(settings.adminDistDir, "index.html");
      await fs.access(indexPath);
      res.sendFile(indexPath);
    } catch (error) {
      next(error);
    }
  });

  app.use(express.static(settings.siteDistDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      next();
      return;
    }

    res.status(404).sendFile(path.join(settings.siteDistDir, "404.html"), (error) => {
      if (error) {
        next(error);
      }
    });
  });

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof DuplicateArticleTitleError) {
      res.status(409).json({
        code: error.code,
        conflicts: error.conflicts,
        error: error.message
      });
      return;
    }

    if (error instanceof MarkdownSearchError) {
      res.status(error.status).json({
        code: error.code,
        error: error.message
      });
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown server error.";
    res.status(500).json({ error: message });
  });

  return app;
}
