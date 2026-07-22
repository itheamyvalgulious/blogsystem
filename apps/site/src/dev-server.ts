import express from "express";
import chokidar from "chokidar";

import { buildSite, getSiteSettings } from "./generator.js";
import { escapeHtml } from "./escape.js";

const settings = getSiteSettings();
const app = express();
const port = Number(process.env.SITE_PORT ?? 4173);

let lastBuildError: unknown = null;

function renderBuildErrorPage(error: unknown) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "Unknown build error.";

  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Site Build Error</title>
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace;
        background: #f7f2ea;
        color: #1f2937;
      }
      main {
        max-width: 900px;
        margin: 48px auto;
        padding: 0 20px;
      }
      .panel {
        border: 1px solid #d6c9b8;
        border-radius: 16px;
        padding: 24px;
        background: rgba(255, 252, 247, 0.96);
        box-shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
      }
      h1 {
        margin-top: 0;
        font-size: 1.6rem;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        padding: 16px;
        border-radius: 12px;
        background: #fff7ed;
        border: 1px solid #fed7aa;
      }
    </style>
  </head>
  <body>
    <main>
      <section class="panel">
        <h1>Site build failed</h1>
        <p>The dev server is running, but the latest static build did not succeed.</p>
        <pre>${escapeHtml(message)}</pre>
      </section>
    </main>
  </body>
</html>`;
}

async function runBuild() {
  try {
    await buildSite(settings);
    lastBuildError = null;
    return true;
  } catch (error) {
    lastBuildError = error;
    console.error(error);
    return false;
  }
}

await runBuild();

app.use((_req, res, next) => {
  if (lastBuildError) {
    res.status(500).type("html").send(renderBuildErrorPage(lastBuildError));
    return;
  }

  next();
});
app.use(express.static(settings.distDir));
app.use((_req, res) => {
  res.sendFile("404.html", { root: settings.distDir }, (error) => {
    if (!error || res.headersSent) {
      return;
    }

    res.status((error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500).type("text/plain").send(error.message);
  });
});

const watcher = chokidar.watch([settings.contentRoot, settings.assetsRoot, settings.configRoot], {
  ignoreInitial: true
});

let pendingBuild: Promise<unknown> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watcher.on("all", () => {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }

  debounceTimer = setTimeout(() => {
    debounceTimer = null;

    if (pendingBuild) {
      return;
    }

    pendingBuild = runBuild()
      .then((succeeded) => {
        if (succeeded) {
          console.log("Static site rebuilt after content change.");
        }
      })
      .finally(() => {
        pendingBuild = null;
      });
  }, 300);
});

app.listen(port, () => {
  console.log(`Static site preview on http://localhost:${port}`);
});
