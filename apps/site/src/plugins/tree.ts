import type { SiteDirectoryPage } from "@blog-system/content-core";

import { escapeHtml } from "../escape.js";
import { enabledNavigation } from "./index.js";
import { renderArticleCard, renderPageWithContext } from "./render-helpers.js";
import type { SitePagePluginDefinition } from "./types.js";

function flattenDirectories(directories: SiteDirectoryPage[]): SiteDirectoryPage[] {
  return directories.flatMap((directory) => [directory, ...flattenDirectories(directory.children)]);
}

function renderDirectoryTree(directories: SiteDirectoryPage[]): string {
  return `<ul class="tree-list">${directories
    .map(
      (directory) => `<li><a href="${directory.urlPath}">${escapeHtml(directory.name)}</a>${directory.children.length > 0 ? renderDirectoryTree(directory.children) : ""}</li>`
    )
    .join("")}</ul>`;
}

export const treePlugin: SitePagePluginDefinition = {
  id: "tree",
  kind: "page",
  label: "Directory Tree",
  getNavigationItem: (context) => ({
    href: `${context.basePrefix}/tree/`,
    label: "Tree"
  }),
  async run(context) {
    const navigation = enabledNavigation(context);
    await context.writeHtml(
      "tree/index.html",
      renderPageWithContext(context, {
        basePath: context.basePrefix,
        content: `<section class="subhero-panel"><h1>Directory Tree</h1><p>Trace the notebook structure.</p></section><section class="content-section">${renderDirectoryTree(context.siteData.directories)}</section>`,
        description: "Browse the content tree.",
        navigation,
        siteDescription: context.config.siteDescription,
        siteTitle: context.config.siteTitle,
        title: "Directory Tree"
      })
    );

    await Promise.all(
      flattenDirectories(context.siteData.directories).map(async (directory) => {
        const body = `<section class="subhero-panel"><h1>${escapeHtml(directory.path)}</h1></section>
          <section class="content-section"><div class="post-list">${directory.articles
            .map((article) => renderArticleCard(article, context.basePrefix))
            .join("") || "<p>No published articles here yet.</p>"}</div></section>`;
        await context.writeHtml(
          `tree/${directory.path}/index.html`,
          renderPageWithContext(context, {
            basePath: context.basePrefix,
            content: body,
            description: `Directory ${directory.path}.`,
            navigation,
            siteDescription: context.config.siteDescription,
            siteTitle: context.config.siteTitle,
            title: directory.path
          })
        );
      })
    );
  }
};
