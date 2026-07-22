import {
  PROTECTED_CONTENT_PLUGIN_ID,
  PROTECTED_CONTENT_SCRIPT_RELATIVE_PATH,
  PROTECTED_CONTENT_STYLE_RELATIVE_PATH,
  buildProtectedContentRuntimeScript,
  buildProtectedContentRuntimeStyles
} from "../protected-content.js";
import type { SiteProtectedContentPluginDefinition } from "./types.js";

export const protectedContentPlugin: SiteProtectedContentPluginDefinition = {
  id: PROTECTED_CONTENT_PLUGIN_ID,
  kind: "protected-content",
  label: "Protected Content",
  async getAssets(context) {
    if (!context.hasProtectedContent) {
      return [];
    }

    return [
      {
        content: buildProtectedContentRuntimeStyles(),
        relativePath: PROTECTED_CONTENT_STYLE_RELATIVE_PATH,
        urlPath: `${context.basePrefix}/${PROTECTED_CONTENT_STYLE_RELATIVE_PATH}`.replace(/\/{2,}/g, "/")
      },
      {
        content: await buildProtectedContentRuntimeScript(),
        relativePath: PROTECTED_CONTENT_SCRIPT_RELATIVE_PATH,
        urlPath: `${context.basePrefix}/${PROTECTED_CONTENT_SCRIPT_RELATIVE_PATH}`.replace(/\/{2,}/g, "/")
      }
    ];
  }
};
