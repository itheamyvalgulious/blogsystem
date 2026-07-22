import {
  COMMUTATIVE_FENCE_LANGUAGE,
  commutativeCssText,
  renderCommutativeFence
} from "@blog-system/commutative";

import type { SiteMarkdownPluginDefinition } from "./types.js";

const COMMUTATIVE_SITE_PLUGIN_ID = "commutative";

export const commutativePlugin: SiteMarkdownPluginDefinition = {
  id: COMMUTATIVE_SITE_PLUGIN_ID,
  kind: "markdown",
  label: "Commutative",
  getFenceRenderers() {
    return [
      {
        language: COMMUTATIVE_FENCE_LANGUAGE,
        name: "commutative",
        render(context) {
          // Use the unified fence renderer that parses tikzcd LaTeX instead of
          // the old base64 format. `renderCommutativeFence` never throws — on
          // parse failure it returns a `commutative--error` placeholder.
          const output = renderCommutativeFence(context.content, context.meta);
          return output;
        }
      }
    ];
  },
  getStylesheets(context) {
    return [
      {
        content: commutativeCssText,
        relativePath: "assets/commutative.css",
        urlPath: `${context.basePrefix}/assets/commutative.css`.replace(/\/{2,}/g, "/")
      }
    ];
  }
};
