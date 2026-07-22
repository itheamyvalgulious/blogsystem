import { Router } from "express";

import { listMediaAssets, savePastedImages } from "../asset-service.js";

export interface AssetsRouterDeps {
  assetsRoot: string;
}

interface PastedImagePayload {
  mimeType?: string;
  base64Data?: string;
  fileName?: string;
}

function findInvalidImage(images: PastedImagePayload[]) {
  return images.find(
    (image) =>
      typeof image.mimeType !== "string" ||
      !image.mimeType.startsWith("image/") ||
      typeof image.base64Data !== "string" ||
      image.base64Data.length === 0
  );
}

export function createAssetsRouter(deps: AssetsRouterDeps) {
  const router = Router();

  router.post("/api/assets/paste-image", async (req, res, next) => {
    try {
      const { articlePath, images } = req.body as {
        articlePath?: string;
        images?: PastedImagePayload[];
      };

      if (!articlePath || !Array.isArray(images) || images.length === 0) {
        res.status(400).json({ error: "articlePath and at least one image are required." });
        return;
      }

      if (findInvalidImage(images)) {
        res.status(400).json({ error: "Each pasted image must include mimeType and base64Data." });
        return;
      }

      const savedAssets = await savePastedImages(
        deps.assetsRoot,
        images as Array<{ mimeType: string; base64Data: string; fileName?: string }>
      );

      res.json({ assets: savedAssets });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/media", async (_req, res, next) => {
    try {
      res.json({
        assets: await listMediaAssets(deps.assetsRoot)
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/media", async (req, res, next) => {
    try {
      const { images } = req.body as {
        images?: PastedImagePayload[];
      };

      if (!Array.isArray(images) || images.length === 0) {
        res.status(400).json({ error: "At least one image is required." });
        return;
      }

      if (findInvalidImage(images)) {
        res.status(400).json({ error: "Each image must include mimeType and base64Data." });
        return;
      }

      const assets = await savePastedImages(
        deps.assetsRoot,
        images as Array<{ mimeType: string; base64Data: string; fileName?: string }>
      );
      res.json({ assets });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
