import type { SiteBuildContext, SiteNavigationItem } from "../runtime.js";
import { aboutPlugin } from "./about.js";
import { articlePagesPlugin } from "./article-pages.js";
import { atlasThemePlugin } from "./atlas-theme.js";
import { commutativePlugin } from "./commutative.js";
import { homePlugin } from "./home.js";
import { protectedContentPlugin } from "./protected-content.js";
import { searchPlugin } from "./search.js";
import { tagsPlugin } from "./tags.js";
import { topOrderPlugin } from "./top-order.js";
import { treePlugin } from "./tree.js";
import type { SitePluginDefinition } from "./types.js";

export { aboutPlugin } from "./about.js";
export { articlePagesPlugin } from "./article-pages.js";
export { atlasThemePlugin } from "./atlas-theme.js";
export { commutativePlugin } from "./commutative.js";
export { homePlugin } from "./home.js";
export { protectedContentPlugin } from "./protected-content.js";
export { searchPlugin } from "./search.js";
export { tagsPlugin } from "./tags.js";
export { topOrderPlugin } from "./top-order.js";
export { treePlugin } from "./tree.js";
export type {
  SiteBaseExtensionDefinition,
  SiteDataPluginDefinition,
  SiteMarkdownPluginDefinition,
  SitePagePluginDefinition,
  SitePluginDefinition,
  SiteProtectedContentPluginDefinition,
  SiteThemePluginDefinition
} from "./types.js";

/**
 * Registry of all built-in static-site plugins, in execution order. The
 * generator resolves the theme/protected-content/markdown/page plugins from
 * this list; page plugins call `enabledNavigation` below at run time.
 */
export const sitePlugins: SitePluginDefinition[] = [
  atlasThemePlugin,
  protectedContentPlugin,
  commutativePlugin,
  topOrderPlugin,
  homePlugin,
  articlePagesPlugin,
  tagsPlugin,
  treePlugin,
  aboutPlugin,
  searchPlugin
];

export function enabledNavigation(context: SiteBuildContext): SiteNavigationItem[] {
  return sitePlugins
    .filter((plugin) => context.config.enabledPlugins.includes(plugin.id))
    .map((plugin) => ("getNavigationItem" in plugin ? plugin.getNavigationItem?.(context) : null))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}
