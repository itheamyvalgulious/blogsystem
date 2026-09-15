import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildSite } from "./generator.js";

async function createWorkspaceFixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "blog-system-site-"));
  const workspaceRoot = path.join(root, "workspace");
  const contentRoot = path.join(workspaceRoot, "content");
  const configRoot = path.join(workspaceRoot, "config");
  const assetsRoot = path.join(workspaceRoot, "assets");

  await fs.mkdir(contentRoot, { recursive: true });
  await fs.mkdir(configRoot, { recursive: true });
  await fs.mkdir(assetsRoot, { recursive: true });
  await fs.mkdir(path.join(configRoot, "theme", "atlas"), { recursive: true });
  await fs.writeFile(
    path.join(configRoot, "theme", "atlas", "theme.json"),
    JSON.stringify({ enable: true, files: [], label: "Atlas", mode: "light" }, null, 2),
    "utf8"
  );
  await fs.writeFile(
    path.join(configRoot, "site.json"),
    JSON.stringify(
      {
        backgroundImage: "",
        enabledPlugins: [
          "top-order",
          "home",
          "article-pages",
          "protected-content",
          "tags",
          "tree",
          "about",
          "search"
        ],
        siteDescription: "Fixture site",
        siteTitle: "Fixture"
      },
      null,
      2
    ),
    "utf8"
  );
  await fs.writeFile(
    path.join(contentRoot, "public.md"),
    `---
title: Public Post
tags:
  - math
status: published
---

# Public Post

Public body.`,
    "utf8"
  );
  await fs.writeFile(
    path.join(contentRoot, "secret.md"),
    `---
title: Secret Post
summary: Public summary for protected post.
tags:
  - hidden
  - visible-tag
status: published
password: open-sesame
---

# Secret Post

Secret body with a [link](./asset.txt).

## Locked Heading

- one
- two`,
    "utf8"
  );
  await fs.writeFile(
    path.join(contentRoot, "secret-auto.md"),
    `---
title: Secret Auto Summary
tags:
  - hidden
status: published
password: hidden-auto
---

# Secret Auto Summary

This protected article has no explicit summary, so the static site should show this generated excerpt in listings.`,
    "utf8"
  );
  await fs.writeFile(path.join(contentRoot, "asset.txt"), "asset", "utf8");
  await fs.writeFile(
    path.join(contentRoot, "about.md"),
    `---
title: About
status: published
password: about-secret
---

# About

About body.`,
    "utf8"
  );

  return { assetsRoot, configRoot, contentRoot, root, workspaceRoot };
}

test("buildSite encrypts protected articles and excludes them from public search data", async () => {
  const fixture = await createWorkspaceFixture();
  const distDir = path.join(fixture.root, "dist");

  await buildSite({
    assetsRoot: fixture.assetsRoot,
    configRoot: fixture.configRoot,
    contentRoot: fixture.contentRoot,
    distDir,
    projectRoot: fixture.root,
    workspaceRoot: fixture.workspaceRoot,
    basePath: ""
  });

  const protectedHtml = await fs.readFile(path.join(distDir, "posts", "secret-post", "index.html"), "utf8");
  const protectedAutoHtml = await fs.readFile(path.join(distDir, "posts", "secret-auto-summary", "index.html"), "utf8");
  const homeHtml = await fs.readFile(path.join(distDir, "index.html"), "utf8");
  const tagHtml = await fs.readFile(path.join(distDir, "tags", "hidden", "index.html"), "utf8");
  const searchIndex = JSON.parse(await fs.readFile(path.join(distDir, "assets", "search-index.json"), "utf8")) as Array<{
    excerpt: string;
    path: string;
    tags: string[];
    title: string;
    urlPath: string;
  }>;
  const protectedRuntime = await fs.readFile(path.join(distDir, "assets", "protected-content.js"), "utf8");
  const protectedCss = await fs.readFile(path.join(distDir, "assets", "protected-content.css"), "utf8");

  assert.match(protectedHtml, /data-protected-content-root/);
  assert.match(protectedHtml, /application\/json/);
  assert.doesNotMatch(protectedHtml, /Secret body/);
  assert.doesNotMatch(protectedHtml, /Locked Heading/);
  assert.match(protectedHtml, /This article is protected/);
  assert.doesNotMatch(protectedAutoHtml, /This protected article has no explicit summary/);
  assert.match(homeHtml, /Secret Post/);
  assert.match(homeHtml, /Public summary for protected post\./);
  assert.match(homeHtml, /This protected article has no explicit summary, so the static site should show this generated excerpt in listings\./);
  assert.match(homeHtml, /\/tags\/hidden\//);
  assert.match(homeHtml, /\/tags\/visible-tag\//);
  assert.match(tagHtml, /Public summary for protected post\./);
  assert.match(tagHtml, /This protected article has no explicit summary, so the static site should show this generated excerpt in listings\./);
  assert.ok(!searchIndex.some((entry) => entry.path === "secret.md"));
  assert.ok(!searchIndex.some((entry) => entry.path === "secret-auto.md"));
  assert.match(protectedRuntime, /blog-system-protected-content:/);
  assert.match(protectedCss, /protected-gate/);

  await fs.rm(fixture.root, { recursive: true, force: true });
});

test("buildSite generates a search script that cannot inject markup from article fields", async () => {
  const fixture = await createWorkspaceFixture();
  const distDir = path.join(fixture.root, "dist");
  const xssTitle = `<img src=x onerror=alert(1)> "quoted" & 'apos'`;

  await fs.writeFile(
    path.join(fixture.contentRoot, "xss.md"),
    `---
title: ${xssTitle}
tags:
  - web
status: published
---

# XSS attempt

Body with <script>alert(2)</script> markup.`,
    "utf8"
  );

  await buildSite({
    assetsRoot: fixture.assetsRoot,
    configRoot: fixture.configRoot,
    contentRoot: fixture.contentRoot,
    distDir,
    projectRoot: fixture.root,
    workspaceRoot: fixture.workspaceRoot,
    basePath: ""
  });

  const searchScript = await fs.readFile(path.join(distDir, "assets", "search.js"), "utf8");
  const searchIndex = JSON.parse(await fs.readFile(path.join(distDir, "assets", "search-index.json"), "utf8")) as Array<{
    excerpt: string;
    path: string;
    tags: string[];
    title: string;
    urlPath: string;
  }>;

  // The malicious title is data inside search-index.json...
  const xssEntry = searchIndex.find((entry) => entry.path === "xss.md");
  assert.ok(xssEntry);
  assert.equal(xssEntry.title, xssTitle);

  // ...and the runtime script must render it via DOM APIs (textContent),
  // never by concatenating raw fields into innerHTML.
  assert.match(searchScript, /document\.createElement/);
  assert.match(searchScript, /\.textContent = item\.(title|path|excerpt)/);
  assert.doesNotMatch(searchScript, /innerHTML/);
  assert.doesNotMatch(searchScript, /' \+ item\.|item\.\w+ \+ '/);

  await fs.rm(fixture.root, { recursive: true, force: true });
});

test("buildSite writes article and tag pages under decoded directory names", async () => {
  const fixture = await createWorkspaceFixture();
  const distDir = path.join(fixture.root, "dist");

  await fs.mkdir(path.join(fixture.contentRoot, "math analysis 3"), { recursive: true });
  await fs.writeFile(
    path.join(fixture.contentRoot, "math analysis 3", "ma3-homework-1.md"),
    `---
title: Math Analysis 3 Homework 1
tags:
  - spaced tag
status: published
---

# Math Analysis 3 Homework 1

Body.`,
    "utf8"
  );

  await buildSite({
    assetsRoot: fixture.assetsRoot,
    configRoot: fixture.configRoot,
    contentRoot: fixture.contentRoot,
    distDir,
    projectRoot: fixture.root,
    workspaceRoot: fixture.workspaceRoot,
    basePath: ""
  });

  const articleHtml = await fs.readFile(
    path.join(distDir, "posts", "math analysis 3", "math-analysis-3-homework-1", "index.html"),
    "utf8"
  );
  const homeHtml = await fs.readFile(path.join(distDir, "index.html"), "utf8");
  const tagHtml = await fs.readFile(path.join(distDir, "tags", "spaced tag", "index.html"), "utf8");
  const treeHtml = await fs.readFile(path.join(distDir, "tree", "math analysis 3", "index.html"), "utf8");

  assert.match(articleHtml, /Math Analysis 3 Homework 1/);
  assert.match(homeHtml, /\/posts\/math%20analysis%203\/math-analysis-3-homework-1\//);
  assert.match(homeHtml, /\/tags\/spaced%20tag\//);
  assert.match(tagHtml, /Math Analysis 3 Homework 1/);
  assert.match(treeHtml, /Math Analysis 3 Homework 1/);
  await assert.rejects(
    fs.access(path.join(distDir, "posts", "math%20analysis%203")),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT"
  );

  await fs.rm(fixture.root, { recursive: true, force: true });
});

test("buildSite rejects protected articles when protected-content is omitted from enabledPlugins", async () => {
  const fixture = await createWorkspaceFixture();
  const distDir = path.join(fixture.root, "dist");
  const siteConfigPath = path.join(fixture.configRoot, "site.json");
  const config = JSON.parse(await fs.readFile(siteConfigPath, "utf8")) as Record<string, unknown>;
  config.enabledPlugins = ["top-order", "home", "article-pages", "tags", "tree", "about", "search"];
  await fs.writeFile(siteConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  await assert.rejects(
    buildSite({
      assetsRoot: fixture.assetsRoot,
      configRoot: fixture.configRoot,
      contentRoot: fixture.contentRoot,
      distDir,
      projectRoot: fixture.root,
      workspaceRoot: fixture.workspaceRoot,
      basePath: ""
    }),
    /protected-content/
  );

  await fs.rm(fixture.root, { recursive: true, force: true });
});

test("buildSite keeps existing dist output when protected-content is omitted from enabledPlugins", async () => {
  const fixture = await createWorkspaceFixture();
  const distDir = path.join(fixture.root, "dist");
  const siteConfigPath = path.join(fixture.configRoot, "site.json");
  const config = JSON.parse(await fs.readFile(siteConfigPath, "utf8")) as Record<string, unknown>;
  const sentinelPath = path.join(distDir, "sentinel.txt");

  await fs.mkdir(distDir, { recursive: true });
  await fs.writeFile(sentinelPath, "keep-me", "utf8");

  config.enabledPlugins = ["top-order", "home", "article-pages", "tags", "tree", "about", "search"];
  await fs.writeFile(siteConfigPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  await assert.rejects(
    buildSite({
      assetsRoot: fixture.assetsRoot,
      configRoot: fixture.configRoot,
      contentRoot: fixture.contentRoot,
      distDir,
      projectRoot: fixture.root,
      workspaceRoot: fixture.workspaceRoot,
      basePath: ""
    }),
    /protected-content/
  );

  assert.equal(await fs.readFile(sentinelPath, "utf8"), "keep-me");

  await fs.rm(fixture.root, { recursive: true, force: true });
});
