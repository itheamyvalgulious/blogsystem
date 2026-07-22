import { Router } from "express";

import {
  createGitCommit,
  ensureGitRepository,
  getGitOverview,
  pushGitChanges
} from "../git-service.js";

export interface GitRouterDeps {
  workspaceRoot: string;
}

export function createGitRouter(deps: GitRouterDeps) {
  const router = Router();

  router.get("/api/git/status", async (_req, res, next) => {
    try {
      const overview = await getGitOverview(deps.workspaceRoot);
      res.json({
        files: overview.files,
        initialized: overview.initialized
      });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/git/history", async (_req, res, next) => {
    try {
      const overview = await getGitOverview(deps.workspaceRoot);
      res.json({
        commits: overview.commits,
        initialized: overview.initialized
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/git/commit", async (req, res, next) => {
    try {
      const { message } = req.body as { message?: string };

      if (!message?.trim()) {
        res.status(400).json({ error: "message is required." });
        return;
      }

      res.json(await createGitCommit(deps.workspaceRoot, message.trim()));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/git/push", async (_req, res, next) => {
    try {
      res.json(await pushGitChanges(deps.workspaceRoot));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/git/init", async (_req, res, next) => {
    try {
      res.json(await ensureGitRepository(deps.workspaceRoot));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
