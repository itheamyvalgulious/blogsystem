import type { MarkdownFenceRendererDefinition, SiteData } from "@blog-system/content-core";

import type { ProtectedContentPayload } from "../protected-content.js";
import type {
  SiteBuildContext,
  SiteNavigationItem,
  SiteThemeDefinition
} from "../runtime.js";

/**
 * Plugin contract for static-site plugins. Implementations live one file per
 * plugin under src/plugins/; the registry is exported from plugins/index.ts.
 */
export interface SiteBaseExtensionDefinition {
  id: string;
  label: string;
}

export interface SiteDataPluginDefinition extends SiteBaseExtensionDefinition {
  kind: "data";
  run: (context: SiteBuildContext) => Promise<void> | void;
}

export interface SitePagePluginDefinition extends SiteBaseExtensionDefinition {
  kind: "page";
  getNavigationItem?: (context: SiteBuildContext) => SiteNavigationItem | null;
  run: (context: SiteBuildContext) => Promise<void> | void;
}

export interface SiteMarkdownPluginDefinition extends SiteBaseExtensionDefinition {
  kind: "markdown";
  getFenceRenderers?: (context: SiteBuildContext) => MarkdownFenceRendererDefinition[];
  getStylesheets?: (context: SiteBuildContext) => Array<{
    content: string;
    relativePath: string;
    urlPath?: string;
  }>;
}

export interface SiteProtectedContentPluginDefinition extends SiteBaseExtensionDefinition {
  kind: "protected-content";
  assertEnabled?: (context: SiteBuildContext) => Promise<void> | void;
  getAssets?: (context: SiteBuildContext) =>
    | Array<{
        content: string;
        relativePath: string;
        urlPath?: string;
      }>
    | Promise<
        Array<{
          content: string;
          relativePath: string;
          urlPath?: string;
        }>
      >;
  sanitizeSiteData?: (siteData: SiteData) => SiteData;
  encryptHtml?: (html: string, password: string) => Promise<ProtectedContentPayload>;
}

export interface SiteThemePluginDefinition extends SiteBaseExtensionDefinition {
  kind: "theme";
  theme: SiteThemeDefinition;
}

export type SitePluginDefinition =
  | SiteDataPluginDefinition
  | SiteProtectedContentPluginDefinition
  | SiteMarkdownPluginDefinition
  | SitePagePluginDefinition
  | SiteThemePluginDefinition;
