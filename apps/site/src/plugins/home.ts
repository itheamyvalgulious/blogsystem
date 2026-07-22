import type { ArticleSummary } from "@blog-system/content-core";

import { escapeHtml } from "../escape.js";
import { enabledNavigation } from "./index.js";
import { renderArticleCard, renderPageWithContext } from "./render-helpers.js";
import type { SitePagePluginDefinition } from "./types.js";

const HOME_PAGE_SIZE = 12;

function chunkArticles(articles: ArticleSummary[], size: number) {
  const pages: ArticleSummary[][] = [];

  for (let index = 0; index < articles.length; index += size) {
    pages.push(articles.slice(index, index + size));
  }

  return pages.length > 0 ? pages : [[]];
}

function renderPagination(basePrefix: string, currentPage: number, totalPages: number) {
  if (totalPages <= 1) {
    return "";
  }

  const hrefForPage = (pageNumber: number) =>
    pageNumber === 1 ? `${basePrefix}/` : `${basePrefix}/page/${pageNumber}/`;

  return `<nav class="pagination" aria-label="Pagination">
    <a class="pagination-link ${currentPage === 1 ? "is-disabled" : ""}" ${currentPage === 1 ? "aria-disabled=\"true\"" : `href="${hrefForPage(currentPage - 1)}"`}>Previous</a>
    <div class="pagination-pages">
      ${Array.from({ length: totalPages }, (_, index) => {
        const pageNumber = index + 1;
        return `<a class="pagination-page ${pageNumber === currentPage ? "is-active" : ""}" href="${hrefForPage(pageNumber)}">${pageNumber}</a>`;
      }).join("")}
    </div>
    <a class="pagination-link ${currentPage === totalPages ? "is-disabled" : ""}" ${currentPage === totalPages ? "aria-disabled=\"true\"" : `href="${hrefForPage(currentPage + 1)}"`}>Next</a>
  </nav>`;
}

export const homePlugin: SitePagePluginDefinition = {
  id: "home",
  kind: "page",
  label: "Home",
  getNavigationItem: (context) => ({
    href: `${context.basePrefix}/`,
    label: "Home"
  }),
  async run(context) {
    const navigation = enabledNavigation(context);
    const pages = chunkArticles(context.siteData.articles, HOME_PAGE_SIZE);

    await Promise.all(
      pages.map(async (articles, index) => {
        const pageNumber = index + 1;
        const body = `${pageNumber === 1
          ? `<section class="hero-notebook">
              <div class="hero-notebook__lead">
                <h1>${escapeHtml(context.config.siteTitle)}</h1>
                <p>${escapeHtml(context.config.siteDescription)}</p>
              </div>
              <div class="hero-notebook__metrics">
                <span><strong>${context.siteData.articles.length}</strong> articles</span>
                <span><strong>${context.siteData.tags.length}</strong> tags</span>
              </div>
            </section>`
          : `<section class="subhero-panel">
              <h1>Page ${pageNumber}</h1>
              <p>${escapeHtml(context.config.siteDescription)}</p>
            </section>`}
          <section class="feed-section">
            <div class="feed-section__header">
              <h2>Recent notes</h2>
              <p>${pageNumber === 1 ? "Newest entries." : `Page ${pageNumber} of ${pages.length}.`}</p>
            </div>
            <div class="post-list">
              ${articles.map((article) => renderArticleCard(article, context.basePrefix)).join("") || "<p>No published articles yet.</p>"}
            </div>
            ${renderPagination(context.basePrefix, pageNumber, pages.length)}
          </section>`;

        await context.writeHtml(
          pageNumber === 1 ? "index.html" : `page/${pageNumber}/index.html`,
          renderPageWithContext(context, {
            basePath: context.basePrefix,
            content: body,
            description: context.config.siteDescription,
            headerMode: pageNumber === 1 ? "brand" : "nav-only",
            navigation,
            siteDescription: context.config.siteDescription,
            siteTitle: context.config.siteTitle,
            title: pageNumber === 1 ? context.config.siteTitle : `${context.config.siteTitle} - Page ${pageNumber}`
          })
        );
      })
    );
  }
};
