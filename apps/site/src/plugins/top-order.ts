import type { ArticleSummary } from "@blog-system/content-core";

import type { SiteDataPluginDefinition } from "./types.js";

export const topOrderPlugin: SiteDataPluginDefinition = {
  id: "top-order",
  kind: "data",
  label: "Top Order",
  run(context) {
    const compare = (left: ArticleSummary, right: ArticleSummary) => {
      if (left.top !== right.top) {
        return right.top - left.top;
      }

      const leftDate = left.date ? Date.parse(left.date) : 0;
      const rightDate = right.date ? Date.parse(right.date) : 0;

      if (leftDate !== rightDate) {
        return rightDate - leftDate;
      }

      return left.path.localeCompare(right.path);
    };

    context.siteData.articles.sort(compare);
    context.publishedArticles.sort((left, right) => {
      if (left.top !== right.top) {
        return right.top - left.top;
      }

      const leftDate = left.date ? Date.parse(left.date) : 0;
      const rightDate = right.date ? Date.parse(right.date) : 0;

      if (leftDate !== rightDate) {
        return rightDate - leftDate;
      }

      return left.path.localeCompare(right.path);
    });
    for (const directory of context.siteData.directories) {
      directory.articles.sort(compare);
    }
  }
};
