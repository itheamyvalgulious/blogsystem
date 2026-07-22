import { Router } from "express";

import { readArticle } from "@blog-system/content-core/node";

import {
  createArticleFile,
  ensureContentRoot,
  getTreePayload,
  saveArticleContent,
  updateArticleStatus
} from "../content-service.js";

export interface ArticlesRouterDeps {
  contentRoot: string;
}

export function createArticlesRouter(deps: ArticlesRouterDeps) {
  const router = Router();

  router.get("/api/tree", async (_req, res, next) => {
    try {
      await ensureContentRoot(deps.contentRoot);
      res.json(await getTreePayload(deps.contentRoot));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/article", async (req, res, next) => {
    try {
      const relativePath = String(req.query.path ?? "");

      if (!relativePath) {
        res.status(400).json({ error: "path is required." });
        return;
      }

      res.json(await readArticle(deps.contentRoot, relativePath));
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/article", async (req, res, next) => {
    try {
      const { path: relativePath, rawContent } = req.body as {
        path?: string;
        rawContent?: string;
      };

      if (!relativePath || typeof rawContent !== "string") {
        res.status(400).json({ error: "Both path and rawContent are required." });
        return;
      }

      res.json(await saveArticleContent(deps.contentRoot, relativePath, rawContent));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/article/new", async (req, res, next) => {
    try {
      const { directoryPath = "", fileName } = req.body as {
        directoryPath?: string;
        fileName?: string;
      };

      if (!fileName) {
        res.status(400).json({ error: "fileName is required." });
        return;
      }

      res.json(await createArticleFile(deps.contentRoot, directoryPath, fileName));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/article/status", async (req, res, next) => {
    try {
      const { path: relativePath, status } = req.body as {
        path?: string;
        status?: "draft" | "working" | "published";
      };

      if (!relativePath || (status !== "draft" && status !== "working" && status !== "published")) {
        res.status(400).json({ error: "Valid path and status are required." });
        return;
      }

      res.json(await updateArticleStatus(deps.contentRoot, relativePath, status));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/tags", async (_req, res, next) => {
    try {
      const payload = await getTreePayload(deps.contentRoot);
      res.json(payload.tags);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
