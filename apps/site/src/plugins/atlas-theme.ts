import { atlasTheme } from "../themes/index.js";
import type { SiteThemePluginDefinition } from "./types.js";

/**
 * Registers the Atlas theme (from the themes module) as a site plugin. Only
 * the themes module's public facade is imported here — never theme internals.
 */
export const atlasThemePlugin: SiteThemePluginDefinition = {
  id: "atlas",
  kind: "theme",
  label: "Atlas Theme",
  theme: atlasTheme
};
