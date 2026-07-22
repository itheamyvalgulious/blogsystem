import { Router } from "express";

import { loadAdminHomeConfig, saveAdminHomeConfig } from "../admin-home-config-service.js";
import {
  loadEditorConfig,
  saveEditorConfig,
  validateEditorConfigPayload
} from "../editor-config-service.js";
import { loadMarkdownBlockConfig, saveMarkdownBlockConfig } from "../markdown-block-config-service.js";
import { loadPublishConfig, savePublishConfig } from "../publish-config-service.js";
import { loadSiteConfig, saveSiteConfig } from "../site-config-service.js";
import { loadUsageStats, recordUsageStats } from "../usage-stats-service.js";

export interface ConfigsRouterDeps {
  configRoot: string;
  editorConfigDir: string;
}

export function createConfigsRouter(deps: ConfigsRouterDeps) {
  const router = Router();

  router.get("/api/editor-config", async (_req, res, next) => {
    try {
      const config = await loadEditorConfig(deps.editorConfigDir);
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

  router.put("/api/editor-config", async (req, res, next) => {
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
          deps.editorConfigDir,
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

  router.get("/api/site-config", async (_req, res, next) => {
    try {
      const config = await loadSiteConfig(deps.configRoot);
      res.json({
        raw: config.raw,
        value: config.value
      });
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/site-config", async (req, res, next) => {
    try {
      const { raw } = req.body as { raw?: string };

      if (typeof raw !== "string") {
        res.status(400).json({ error: "raw is required." });
        return;
      }

      res.json(await saveSiteConfig(deps.configRoot, raw));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/publish-config", async (_req, res, next) => {
    try {
      res.json(await loadPublishConfig(deps.configRoot));
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/publish-config", async (req, res, next) => {
    try {
      const { raw } = req.body as { raw?: string };

      if (typeof raw !== "string") {
        res.status(400).json({ error: "raw is required." });
        return;
      }

      res.json(await savePublishConfig(deps.configRoot, raw));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/markdown-block-config", async (_req, res, next) => {
    try {
      res.json(await loadMarkdownBlockConfig(deps.configRoot));
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/markdown-block-config", async (req, res, next) => {
    try {
      const { raw } = req.body as { raw?: string };

      if (typeof raw !== "string") {
        res.status(400).json({ error: "raw is required." });
        return;
      }

      res.json(await saveMarkdownBlockConfig(deps.configRoot, raw));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/admin-home-config", async (_req, res, next) => {
    try {
      res.json(await loadAdminHomeConfig(deps.configRoot));
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/admin-home-config", async (req, res, next) => {
    try {
      const { raw } = req.body as { raw?: string };

      if (typeof raw !== "string") {
        res.status(400).json({ error: "raw is required." });
        return;
      }

      res.json(await saveAdminHomeConfig(deps.configRoot, raw));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/usage-stats", async (_req, res, next) => {
    try {
      res.json(await loadUsageStats(deps.configRoot));
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/usage-stats", async (req, res, next) => {
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
        await recordUsageStats(deps.configRoot, {
          activeMilliseconds,
          documents: normalizedDocuments
        })
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
