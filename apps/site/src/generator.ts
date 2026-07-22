import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rewriteManagedMediaTextReferences, type ThemeAssetConfig } from "@blog-system/content-core";
import type { ArticleRecord } from "@blog-system/content-core";
import { loadWorkspacePaths } from "@blog-system/content-core/node";
import { loadSiteData, scanArticles } from "@blog-system/content-core/node";

import { enabledNavigation, sitePlugins } from "./plugins/index.js";
import type {
  SiteDataPluginDefinition,
  SiteMarkdownPluginDefinition,
  SitePagePluginDefinition
} from "./plugins/index.js";
import { sanitizeSiteDataForProtectedContent } from "./protected-content.js";
import { loadMarkdownBlockConfig } from "./markdown-block-config.js";
import { createWriteHtml, createWriteTextAsset, normalizeBasePath, type SiteBuildContext } from "./runtime.js";
import { loadSiteConfig } from "./site-config.js";
import { getThemeGroupsRoot, listEnabledThemeAssets } from "./themes/index.js";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const projectRoot = path.resolve(currentDir, "../../..");
const workspacePaths = loadWorkspacePaths(projectRoot);

export interface SiteBuildSettings {
  assetsRoot: string;
  configRoot: string;
  contentRoot: string;
  distDir: string;
  projectRoot: string;
  workspaceRoot: string;
  basePath: string;
}

export function getSiteSettings(): SiteBuildSettings {
  return {
    assetsRoot: workspacePaths.assetsRoot,
    configRoot: workspacePaths.configRoot,
    contentRoot: workspacePaths.contentRoot,
    distDir: path.resolve(path.join(projectRoot, "apps", "site", "dist")),
    projectRoot,
    workspaceRoot: workspacePaths.workspaceRoot,
    basePath: process.env.SITE_BASE_PATH ?? ""
  };
}

async function copyContentAssets(contentRoot: string, distDir: string) {
  const targetRoot = path.join(distDir, "content");

  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });

  async function walk(sourceDir: string, relativeDir = ""): Promise<void> {
    const entries = await fs.readdir(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name;
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetRoot, relativePath);

      if (entry.isDirectory()) {
        await fs.mkdir(targetPath, { recursive: true });
        await walk(sourcePath, relativePath);
      } else if (!entry.name.toLowerCase().endsWith(".md") && !entry.name.startsWith(".blog-system-folder")) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.copyFile(sourcePath, targetPath);
      }
    }
  }

  await walk(contentRoot);
}

async function copyMediaLibrary(assetsRoot: string, distDir: string) {
  const sourceRoot = assetsRoot;
  const targetRoot = path.join(distDir, "media");

  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });

  try {
    await fs.access(sourceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }

  const entries = await fs.readdir(sourceRoot, { withFileTypes: true });
  for (const entry of entries) {
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);

    if (entry.isDirectory()) {
      await fs.cp(sourcePath, targetPath, { recursive: true });
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function copyEnabledThemeAssets(
  configRoot: string,
  distDir: string,
  assets: Array<ThemeAssetConfig & { assetPath: string }>,
  basePrefix: string
) {
  const sourceRoot = getThemeGroupsRoot(configRoot);
  const targetRoot = path.join(distDir, "theme");

  await fs.rm(targetRoot, { recursive: true, force: true });
  await fs.mkdir(targetRoot, { recursive: true });

  for (const asset of assets) {
    const assetPath = asset.assetPath;
    const sourcePath = path.join(sourceRoot, assetPath);
    const targetPath = path.join(targetRoot, assetPath);

    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    if (asset.type === "css" || asset.type === "js") {
      const raw = await fs.readFile(sourcePath, "utf8");
      await fs.writeFile(
        targetPath,
        rewriteManagedMediaTextReferences(raw, `${basePrefix}/media`),
        "utf8"
      );
    } else {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

async function buildNotFoundPage(context: SiteBuildContext) {
  const navigation = enabledNavigation(context);

  const html = context.theme.renderPage({
    basePath: context.basePrefix,
    content: `<section class="subhero-panel"><h1>404</h1><p>The page could not be found.</p></section>`,
    description: "The page could not be found.",
    externalStylesheets: context.externalStylesheets,
    navigation,
    siteDescription: context.config.siteDescription,
    siteTitle: context.config.siteTitle,
    title: "404 - Not Found"
  });

  await context.writeHtml("404.html", html);
}

function resolveAboutArticle(publishedArticles: ArticleRecord[]) {
  const matches = publishedArticles.filter(
    (article) => article.title.trim().toLowerCase() === "about"
  );

  if (matches.length > 1) {
    throw new Error(
      `Multiple published articles use the title "about": ${matches.map((article) => article.path).join(", ")}`
    );
  }

  return matches[0] ?? null;
}

export async function buildSite(customSettings?: Partial<SiteBuildSettings>) {
  const settings = {
    ...getSiteSettings(),
    ...customSettings
  };
  const config = await loadSiteConfig(settings.configRoot);
  const themePlugin = sitePlugins.find((candidate) => candidate.kind === "theme");
  const protectedContentPlugin = sitePlugins.find(
    (candidate) => candidate.kind === "protected-content"
  );

  if (!themePlugin || themePlugin.kind !== "theme") {
    throw new Error("No site layout theme plugin could be resolved.");
  }

  const theme = themePlugin.theme;
  const basePrefix = normalizeBasePath(settings.basePath);
  const markdownBlockConfig = await loadMarkdownBlockConfig(settings.configRoot);
  const enabledThemeAssets = await listEnabledThemeAssets(settings.configRoot);
  const enabledMarkdownPlugins = sitePlugins.filter(
    (candidate): candidate is SiteMarkdownPluginDefinition =>
      candidate.kind === "markdown" && config.enabledPlugins.includes(candidate.id)
  );

  const siteData = await loadSiteData(settings.contentRoot, basePrefix);
  const publishedArticles = (await scanArticles(settings.contentRoot)).filter((article) => article.status === "published" || article.status === "working");
  const aboutArticle = resolveAboutArticle(publishedArticles);
  const hasProtectedContent = publishedArticles.some((article) => article.isProtected);

  if (hasProtectedContent && !config.enabledPlugins.includes("protected-content")) {
    throw new Error('Protected articles require the "protected-content" site plugin to remain enabled.');
  }

  await fs.rm(settings.distDir, { recursive: true, force: true });
  await fs.mkdir(path.join(settings.distDir, "assets"), { recursive: true });
  await copyContentAssets(settings.contentRoot, settings.distDir);
  await copyMediaLibrary(settings.assetsRoot, settings.distDir);
  await copyEnabledThemeAssets(
    settings.configRoot,
    settings.distDir,
    enabledThemeAssets,
    basePrefix
  );
  const writeTextAsset = createWriteTextAsset(settings);
  const initialContext: SiteBuildContext = {
    aboutArticle,
    basePrefix,
    config,
    externalScripts: enabledThemeAssets
      .filter((asset) => asset.type === "js")
      .map((asset) => `${basePrefix}/theme/${asset.assetPath}`.replace(/\/{2,}/g, "/")),
    externalStylesheets: enabledThemeAssets
      .filter((asset) => asset.type === "css")
      .map((asset) => `${basePrefix}/theme/${asset.assetPath}`.replace(/\/{2,}/g, "/")),
    hasProtectedContent,
    markdownFenceRenderers: [],
    markdownBlockConfig,
    projectRoot: settings.projectRoot,
    publishedArticles,
    publicArticleSummaries: siteData.articles,
    settings,
    siteData,
    theme,
    writeHtml: createWriteHtml(settings),
    writeTextAsset
  };

  if (protectedContentPlugin?.kind === "protected-content") {
    await protectedContentPlugin.assertEnabled?.(initialContext);
    const protectedAssets = hasProtectedContent ? await protectedContentPlugin.getAssets?.(initialContext) ?? [] : [];
    for (const asset of protectedAssets) {
      await writeTextAsset(asset.relativePath, asset.content);
    }

    initialContext.externalScripts.push(
      ...protectedAssets
        .filter((asset) => asset.relativePath.endsWith(".js"))
        .map((asset) => asset.urlPath ?? `${basePrefix}/${asset.relativePath}`.replace(/\/{2,}/g, "/"))
    );
    initialContext.externalStylesheets.push(
      ...protectedAssets
        .filter((asset) => asset.relativePath.endsWith(".css"))
        .map((asset) => asset.urlPath ?? `${basePrefix}/${asset.relativePath}`.replace(/\/{2,}/g, "/"))
    );
  }

  const markdownFenceRenderers = enabledMarkdownPlugins.flatMap((plugin) => plugin.getFenceRenderers?.({
    ...initialContext,
    markdownFenceRenderers: []
  }) ?? []);
  const markdownStylesheets = enabledMarkdownPlugins.flatMap((plugin) => plugin.getStylesheets?.({
    ...initialContext,
    markdownFenceRenderers: []
  }) ?? []);

  for (const stylesheet of markdownStylesheets) {
    await writeTextAsset(stylesheet.relativePath, stylesheet.content);
  }

  const context: SiteBuildContext = {
    ...initialContext,
    markdownFenceRenderers,
    siteData: initialContext.siteData,
    publicArticleSummaries: initialContext.publicArticleSummaries
  };

  context.externalStylesheets.push(
    ...markdownStylesheets.map((asset) =>
      (asset.urlPath ?? `${basePrefix}/${asset.relativePath}`.replace(/\/{2,}/g, "/"))
    )
  );

  for (const plugin of sitePlugins.filter((candidate): candidate is SiteDataPluginDefinition => candidate.kind === "data" && config.enabledPlugins.includes(candidate.id))) {
    await plugin.run(context);
  }

  if (hasProtectedContent) {
    const sanitizedSiteData = sanitizeSiteDataForProtectedContent(context.siteData);
    context.siteData = sanitizedSiteData;
    context.publicArticleSummaries = sanitizedSiteData.articles;
  }

  await fs.writeFile(
    path.join(settings.distDir, "assets", "favicon.svg"),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" fill="none"><rect width="64" height="64" rx="16" fill="#1f2937"/><path d="M18 16h18c7.732 0 14 6.268 14 14s-6.268 14-14 14H26v8H18V16z" fill="#c2410c"/><path d="M26 24v12h10c3.314 0 6-2.686 6-6s-2.686-6-6-6H26z" fill="#fff7ed"/></svg>\n`,
    "utf8"
  );

  for (const plugin of sitePlugins.filter((candidate): candidate is SitePagePluginDefinition => candidate.kind === "page" && config.enabledPlugins.includes(candidate.id))) {
    await plugin.run(context);
  }

  await buildNotFoundPage(context);

  return settings.distDir;
}
