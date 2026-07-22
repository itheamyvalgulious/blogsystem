import { Router } from "express";

import {
  createFileSystemEntry,
  deleteFileSystemEntry,
  renameFileSystemEntry,
  readFileSystemMetadata,
  saveFileSystemMetadata,
  transferFileSystemEntry
} from "../content-service.js";

export interface FsRouterDeps {
  contentRoot: string;
}

export function createFsRouter(deps: FsRouterDeps) {
  const router = Router();

  router.post("/api/fs/create", async (req, res, next) => {
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
        await createFileSystemEntry(deps.contentRoot, parentPath, entryType, name, metadata, {
          allowDuplicateTitle
        })
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/fs/rename", async (req, res, next) => {
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
        await renameFileSystemEntry(deps.contentRoot, relativePath, nextName, {
          allowDuplicateTitle,
          title
        })
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/fs/metadata", async (req, res, next) => {
    try {
      const relativePath = String(req.query.path ?? "");

      if (!relativePath) {
        res.status(400).json({ error: "path is required." });
        return;
      }

      res.json(await readFileSystemMetadata(deps.contentRoot, relativePath));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/fs/metadata", async (req, res, next) => {
    try {
      const { path: relativePath, metadata } = req.body as {
        path?: string;
        metadata?: Record<string, unknown>;
      };

      if (!relativePath || !metadata || typeof metadata !== "object") {
        res.status(400).json({ error: "path and metadata are required." });
        return;
      }

      res.json(await saveFileSystemMetadata(deps.contentRoot, relativePath, metadata));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/fs/delete", async (req, res, next) => {
    try {
      const { path: relativePath } = req.body as {
        path?: string;
      };

      if (!relativePath) {
        res.status(400).json({ error: "path is required." });
        return;
      }

      await deleteFileSystemEntry(deps.contentRoot, relativePath);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/fs/transfer", async (req, res, next) => {
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
        await transferFileSystemEntry(deps.contentRoot, sourcePath, targetDirectoryPath, mode)
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
