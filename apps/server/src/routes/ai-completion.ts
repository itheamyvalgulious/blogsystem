import { Router } from "express";

import {
  completeAiInline,
  loadAiCompletionConfig,
  resolveAiCompletionStatus,
  saveAiCompletionConfig
} from "../ai-completion-service.js";

export interface AiCompletionRouterDeps {
  configRoot: string;
}

export function createAiCompletionRouter(deps: AiCompletionRouterDeps) {
  const router = Router();

  router.post("/api/ai/completion", async (req, res, next) => {
    try {
      const { prefix, suffix, language } = req.body as {
        prefix?: unknown;
        suffix?: unknown;
        language?: unknown;
      };

      if (typeof prefix !== "string" || typeof suffix !== "string") {
        res.status(400).json({ error: "prefix and suffix are required." });
        return;
      }

      if (language !== "markdown" && language !== "latex") {
        res.status(400).json({ error: 'language must be "markdown" or "latex".' });
        return;
      }

      res.json(await completeAiInline(deps.configRoot, { prefix, suffix, language }));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/ai/completion-config", async (_req, res, next) => {
    try {
      const { raw, value } = await loadAiCompletionConfig(deps.configRoot);
      const status = await resolveAiCompletionStatus(deps.configRoot);
      res.json({ raw, value, status });
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/ai/completion-config", async (req, res, next) => {
    try {
      const { raw } = req.body as { raw?: unknown };

      if (typeof raw !== "string") {
        res.status(400).json({ error: "raw is required." });
        return;
      }

      const { raw: savedRaw, value } = await saveAiCompletionConfig(deps.configRoot, raw);
      const status = await resolveAiCompletionStatus(deps.configRoot);
      res.json({ raw: savedRaw, value, status });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
