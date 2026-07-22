/**
 * Themes module facade: exposes the built-in themes plus the theme-group
 * loading helpers (theme assets configured in the workspace config). Theme
 * implementations must not import plugin internals.
 */
export { atlasTheme } from "./atlas.js";
export { getThemeGroupsRoot, listEnabledThemeAssets } from "../theme-groups.js";
