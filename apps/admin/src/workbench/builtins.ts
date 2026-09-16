import type { PluginDefinition } from "./types";
import { clipboardImagePlugin } from "./plugins/clipboard-image-plugin";
import { commandPalettePlugin } from "./plugins/command-palette-plugin";
import { commutativePlugin } from "./plugins/commutative-plugin";
import { createMetadataPlugin } from "./plugins/create-metadata-plugin";
import { editorConveniencePlugin } from "./plugins/editor-convenience-plugin";
import { gitPlugin } from "./plugins/git-plugin";
import { globalSearchReplacePlugin } from "./plugins/global-search-replace-plugin";
import { coreWorkbenchPlugin } from "./plugins/core-workbench-plugin";
import { mediaLibraryPlugin } from "./plugins/media-library-plugin";
import { markdownOutlinePlugin } from "./plugins/markdown-outline-plugin";
import { projectPlugin } from "./plugins/project-plugin";
import { snippetActionsPlugin } from "./plugins/snippet-actions-plugin";
import { themePlugin } from "./plugins/theme-plugin";
import { topFrontmatterPlugin } from "./plugins/top-frontmatter-plugin";
import { usageStatsPlugin } from "./plugins/usage-stats-plugin";

export const builtInPlugins: PluginDefinition[] = [
  coreWorkbenchPlugin,
  snippetActionsPlugin,
  editorConveniencePlugin,
  commandPalettePlugin,
  commutativePlugin,
  themePlugin,
  clipboardImagePlugin,
  createMetadataPlugin,
  markdownOutlinePlugin,
  projectPlugin,
  topFrontmatterPlugin,
  mediaLibraryPlugin,
  globalSearchReplacePlugin,
  gitPlugin,
  usageStatsPlugin
];
