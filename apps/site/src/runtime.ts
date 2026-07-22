import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ArticleRecord,
  ArticleSummary,
  MarkdownBlockConfig,
  MarkdownFenceRendererDefinition,
  SiteData
} from "@blog-system/content-core";

import type { SiteBuildSettings } from "./generator.js";
import type { SiteConfig } from "./site-config.js";

/**
 * Shared types for the site build: the build context passed to plugins, the
 * theme contract, and the dist write helpers. Plugins (src/plugins/) and
 * themes (src/themes/) both depend on this module; plugin definition
 * interfaces live in src/plugins/types.ts.
 */

export interface SiteNavigationItem {
  href: string;
  label: string;
}

export interface SiteThemeRenderArgs {
  basePath: string;
  bodyClass?: string;
  content: string;
  description: string;
  externalScripts?: string[];
  externalStylesheets?: string[];
  headerMode?: "brand" | "nav-only";
  navigation: SiteNavigationItem[];
  siteDescription: string;
  siteStyleVariables?: Record<string, string>;
  siteTitle: string;
  title: string;
}

export interface SiteThemeDefinition {
  id: string;
  label: string;
  renderPage: (args: SiteThemeRenderArgs) => string;
}

export interface SiteBuildContext {
  aboutArticle: ArticleRecord | null;
  basePrefix: string;
  config: SiteConfig;
  externalScripts: string[];
  externalStylesheets: string[];
  hasProtectedContent: boolean;
  markdownFenceRenderers: MarkdownFenceRendererDefinition[];
  markdownBlockConfig: MarkdownBlockConfig;
  projectRoot: string;
  publishedArticles: ArticleRecord[];
  publicArticleSummaries: ArticleSummary[];
  settings: SiteBuildSettings;
  siteData: SiteData;
  theme: SiteThemeDefinition;
  writeHtml: (relativePath: string, html: string) => Promise<void>;
  writeTextAsset: (relativePath: string, content: string) => Promise<void>;
}

export function normalizeBasePath(basePath: string) {
  return basePath ? `/${basePath.replace(/^\/+|\/+$/g, "")}` : "";
}

export function createWriteHtml(settings: SiteBuildSettings) {
  return async (relativePath: string, html: string) => {
    const targetPath = path.join(settings.distDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, html, "utf8");
  };
}

export function createWriteTextAsset(settings: SiteBuildSettings) {
  return async (relativePath: string, content: string) => {
    const targetPath = path.join(settings.distDir, relativePath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, content, "utf8");
  };
}
