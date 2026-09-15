import { escapeHtml } from "../escape.js";
import { enabledNavigation } from "./index.js";
import { renderArticleCard, renderPageWithContext } from "./render-helpers.js";
import type { SitePagePluginDefinition } from "./types.js";

export const tagsPlugin: SitePagePluginDefinition = {
  id: "tags",
  kind: "page",
  label: "Tags",
  getNavigationItem: (context) => ({
    href: `${context.basePrefix}/tags/`,
    label: "Tags"
  }),
  async run(context) {
    const navigation = enabledNavigation(context);
    const tagIndexBody = `<section class="subhero-panel"><h1>Tags</h1><p>Browse notes by subject marker.</p></section>
      <section class="content-section"><div class="tag-sheet">${context.siteData.tags
        .map(
          (tag) =>
            `<a class="tag-chip" href="${context.basePrefix}/tags/${encodeURIComponent(tag.tag)}/">${escapeHtml(tag.tag)} (${tag.count})</a>`
        )
        .join("")}</div></section>`;
    await context.writeHtml(
      "tags/index.html",
      renderPageWithContext(context, {
        basePath: context.basePrefix,
        content: tagIndexBody,
        description: "Browse articles by tag.",
        navigation,
        siteDescription: context.config.siteDescription,
        siteTitle: context.config.siteTitle,
        title: "Tags"
      })
    );

    await Promise.all(
      context.siteData.tags.map(async (tag) => {
        const matchingArticles = context.publicArticleSummaries.filter((article) => article.tags.includes(tag.tag));
        const body = `<section class="subhero-panel"><h1># ${escapeHtml(tag.tag)}</h1></section>
          <section class="content-section"><div class="post-list">${matchingArticles
            .map((article) => renderArticleCard(article, context.basePrefix))
            .join("")}</div></section>`;
        await context.writeHtml(
          `tags/${tag.tag}/index.html`,
          renderPageWithContext(context, {
            basePath: context.basePrefix,
            content: body,
            description: `Articles tagged with ${tag.tag}.`,
            navigation,
            siteDescription: context.config.siteDescription,
            siteTitle: context.config.siteTitle,
            title: `Tag: ${tag.tag}`
          })
        );
      })
    );
  }
};
