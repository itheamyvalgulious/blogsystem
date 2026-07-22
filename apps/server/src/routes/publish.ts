import { Router } from "express";

import type { ServerSettings } from "../config.js";
import { publishSite } from "../publish-service.js";

export interface PublishRouterDeps {
  settings: ServerSettings;
}

export function createPublishRouter(deps: PublishRouterDeps) {
  const router = Router();

  router.post("/api/publish", async (_req, res, next) => {
    try {
      res.json(await publishSite(deps.settings));
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

  return router;
}
