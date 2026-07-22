import { promises as fs } from "node:fs";
import path from "node:path";

export interface SiteConfig {
  backgroundImage?: string;
  enabledPlugins: string[];
  siteDescription: string;
  siteTitle: string;
}

export const defaultSiteConfig: SiteConfig = {
  backgroundImage: "",
  enabledPlugins: ["top-order", "home", "article-pages", "protected-content", "tags", "tree", "about", "search"],
  siteDescription: "A plugin-driven static site generated from local Markdown content.",
  siteTitle: "Knowledge Base"
};

export async function loadSiteConfig(configRoot: string): Promise<SiteConfig> {
  const configPath = path.join(configRoot, "site.json");
  let parsed: Partial<SiteConfig> = {};
  try {
    const raw = (await fs.readFile(configPath, "utf8")).replace(/^\uFEFF/, "");
    parsed = JSON.parse(raw) as Partial<SiteConfig>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // site.json 不存在时回退默认配置（init-workspace 不会创建该文件）
  }

  return {
    backgroundImage: parsed.backgroundImage?.trim() || "",
    enabledPlugins:
      parsed.enabledPlugins?.filter((pluginId): pluginId is string => typeof pluginId === "string" && pluginId.trim().length > 0) ??
      defaultSiteConfig.enabledPlugins,
    siteDescription: parsed.siteDescription?.trim() || defaultSiteConfig.siteDescription,
    siteTitle: parsed.siteTitle?.trim() || defaultSiteConfig.siteTitle
  };
}
