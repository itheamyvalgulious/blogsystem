import { promises as fs } from "node:fs";
import path from "node:path";

import cors from "cors";
import express from "express";
import session from "express-session";

import type { ServerSettings } from "./config.js";
import { getDefaultSettings } from "./config.js";
import { errorHandler } from "./middleware/error-handler.js";
import { requireAuth } from "./middleware/require-auth.js";
import { createAiCompletionRouter } from "./routes/ai-completion.js";
import { createArticlesRouter } from "./routes/articles.js";
import { createAssetsRouter } from "./routes/assets.js";
import { createAuthRouter } from "./routes/auth.js";
import { createConfigsRouter } from "./routes/configs.js";
import { createFsRouter } from "./routes/fs.js";
import { createGitRouter } from "./routes/git.js";
import { createProjectsRouter } from "./routes/projects.js";
import { createPublishRouter } from "./routes/publish.js";
import { createSearchRouter } from "./routes/search.js";
import { createThemesRouter } from "./routes/themes.js";
import { getThemeGroupsRoot } from "./theme-group-service.js";

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

  app.use(createAuthRouter({
    adminPassword: settings.adminPassword,
    adminUsername: settings.adminUsername
  }));

  app.use("/api", requireAuth);

  app.use(createArticlesRouter({ contentRoot: settings.contentRoot }));
  app.use(createFsRouter({ contentRoot: settings.contentRoot }));
  app.use(createSearchRouter({ contentRoot: settings.contentRoot }));
  app.use(createAssetsRouter({ assetsRoot: settings.assetsRoot }));
  app.use(createConfigsRouter({
    configRoot: settings.configRoot,
    editorConfigDir: settings.editorConfigDir
  }));
  app.use(createAiCompletionRouter({ configRoot: settings.configRoot }));
  app.use(createProjectsRouter({ projectsRoot: settings.projectsRoot }));
  app.use(createThemesRouter({ configRoot: settings.configRoot }));
  app.use(createPublishRouter({ settings }));
  app.use(createGitRouter({ workspaceRoot: settings.workspaceRoot }));

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

  app.use(errorHandler);

  return app;
}
