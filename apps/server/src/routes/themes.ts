import { Router } from "express";

import {
  createThemeAsset,
  createThemeGroup,
  deleteThemeAsset,
  deleteThemeGroup,
  listThemeGroups,
  readThemeAsset,
  readThemeGroupConfig,
  renameThemeAsset,
  renameThemeGroup,
  saveThemeAsset,
  saveThemeGroupConfig
} from "../theme-group-service.js";

export interface ThemesRouterDeps {
  configRoot: string;
}

export function createThemesRouter(deps: ThemesRouterDeps) {
  const router = Router();

  router.get("/api/theme-groups", async (_req, res, next) => {
    try {
      res.json(await listThemeGroups(deps.configRoot));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/theme-group", async (req, res, next) => {
    try {
      const groupId = String(req.query.group ?? "");

      if (!groupId) {
        res.status(400).json({ error: "group is required." });
        return;
      }

      res.json(await readThemeGroupConfig(deps.configRoot, groupId));
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/theme-group", async (req, res, next) => {
    try {
      const { groupId, raw } = req.body as { groupId?: string; raw?: string };

      if (!groupId || typeof raw !== "string") {
        res.status(400).json({ error: "groupId and raw are required." });
        return;
      }

      res.json(await saveThemeGroupConfig(deps.configRoot, groupId, raw));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/theme-group/create", async (req, res, next) => {
    try {
      const { groupId } = req.body as { groupId?: string };

      if (!groupId?.trim()) {
        res.status(400).json({ error: "groupId is required." });
        return;
      }

      res.json(await createThemeGroup(deps.configRoot, groupId));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/theme-group/rename", async (req, res, next) => {
    try {
      const { groupId, nextGroupId } = req.body as { groupId?: string; nextGroupId?: string };

      if (!groupId || !nextGroupId?.trim()) {
        res.status(400).json({ error: "groupId and nextGroupId are required." });
        return;
      }

      res.json(await renameThemeGroup(deps.configRoot, groupId, nextGroupId));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/theme-group/delete", async (req, res, next) => {
    try {
      const { groupId } = req.body as { groupId?: string };

      if (!groupId) {
        res.status(400).json({ error: "groupId is required." });
        return;
      }

      res.json(await deleteThemeGroup(deps.configRoot, groupId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/theme-asset", async (req, res, next) => {
    try {
      const groupId = String(req.query.group ?? "");
      const fileName = String(req.query.file ?? "");

      if (!groupId || !fileName) {
        res.status(400).json({ error: "group and file are required." });
        return;
      }

      res.json(await readThemeAsset(deps.configRoot, groupId, fileName));
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/theme-asset", async (req, res, next) => {
    try {
      const { groupId, fileName, raw } = req.body as { groupId?: string; fileName?: string; raw?: string };

      if (!groupId || !fileName || typeof raw !== "string") {
        res.status(400).json({ error: "groupId, fileName, and raw are required." });
        return;
      }

      res.json(await saveThemeAsset(deps.configRoot, groupId, fileName, raw));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/theme-asset/create", async (req, res, next) => {
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
        deps.configRoot,
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

  router.post("/api/theme-asset/rename", async (req, res, next) => {
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

      res.json(await renameThemeAsset(deps.configRoot, groupId, fileName, nextFileName));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/theme-asset/delete", async (req, res, next) => {
    try {
      const { fileName, groupId } = req.body as { fileName?: string; groupId?: string };

      if (!groupId || !fileName) {
        res.status(400).json({ error: "groupId and fileName are required." });
        return;
      }

      res.json(await deleteThemeAsset(deps.configRoot, groupId, fileName));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
