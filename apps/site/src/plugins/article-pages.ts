import type { ArticleSummary, HeadingItem } from "@blog-system/content-core";

import { escapeHtml } from "../escape.js";
import type { SiteBuildContext } from "../runtime.js";
import {
  PROTECTED_CONTENT_META_DESCRIPTION,
  createProtectedContentStorageKey,
  encryptProtectedHtml,
  getProtectedArticlePassword,
  renderProtectedContentGate
} from "../protected-content.js";
import { enabledNavigation } from "./index.js";
import {
  findPublicSummary,
  renderArticleHtml,
  renderArticleMeta,
  renderPageWithContext,
  renderTagRow
} from "./render-helpers.js";
import type { SitePagePluginDefinition } from "./types.js";

function buildTocTreeHtml(headings: HeadingItem[]): string {
  if (!headings.length) return "";
  const minDepth = headings[0].depth;
  let html = "";
  let depth = minDepth;
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    if (i === 0) {
      for (let d = 0; d < h.depth - minDepth + 1; d++) html += "<ul>";
      depth = h.depth;
    } else if (h.depth > depth) {
      while (h.depth > depth) { html += "<ul>"; depth++; }
    } else if (h.depth === depth) {
      html += "</li>";
    } else {
      html += "</li>";
      while (h.depth < depth) { html += "</ul></li>"; depth--; }
    }
    html += `<li><a href="#${escapeHtml(h.id)}">${escapeHtml(h.text)}</a>`;
  }
  html += "</li>";
  while (depth > minDepth) { html += "</ul></li>"; depth--; }
  html += "</ul>";
  return html;
}

function findPublishedSummary(context: SiteBuildContext, articlePath: string) {
  return context.siteData.articles.find((article) => article.path === articlePath);
}

function buildArticleHero(summary: ArticleSummary, basePath: string) {
  return `<section class="article-hero">
    <span class="hero-note">${summary.date ? escapeHtml(summary.date.slice(0, 10)) : escapeHtml(summary.path)}</span>
    <h1>${escapeHtml(summary.title)}</h1>
    <div class="entry-meta article-hero__meta">${renderArticleMeta(summary)}</div>
    <div class="tag-row">${renderTagRow(summary, basePath)}</div>
  </section>`;
}

function buildArticlePager(previous: ArticleSummary | null, next: ArticleSummary | null) {
  return `<div class="pager-row">
    ${previous ? `<a href="${previous.urlPath}"><span>Older</span><strong>${escapeHtml(previous.title)}</strong></a>` : `<span class="pager-row__empty"></span>`}
    ${next ? `<a href="${next.urlPath}"><span>Newer</span><strong>${escapeHtml(next.title)}</strong></a>` : `<span class="pager-row__empty"></span>`}
  </div>`;
}

export const articlePagesPlugin: SitePagePluginDefinition = {
  id: "article-pages",
  kind: "page",
  label: "Article Pages",
  async run(context) {
    const navigation = enabledNavigation(context);

    await Promise.all(
      context.publishedArticles.map(async (record) => {
        const summary = findPublicSummary(context, record.path)!;
        const publishedSummary = findPublishedSummary(context, record.path) ?? summary;
        const index = context.siteData.articles.findIndex((article) => article.path === summary.path);
        const previous = index >= 0 ? context.siteData.articles[index + 1] ?? null : null;
        const next = index >= 0 ? context.siteData.articles[index - 1] ?? null : null;
        let body = "";
        let description = summary.excerpt;

        if (record.isProtected) {
          const rendered = await renderArticleHtml(context, record);
          const encryptedPayload = await encryptProtectedHtml(
            `<section class="article-layout">
              <article class="article-panel">
                <div class="prose">${rendered.html}</div>
                ${buildArticlePager(previous, next)}
              </article>
              <aside class="side-panel">
                <h3>On This Page</h3>
                ${buildTocTreeHtml(rendered.headings)}
              </aside>
            </section>`,
            getProtectedArticlePassword(record)
          );

          body = `${buildArticleHero(summary, context.basePrefix)}
            ${renderProtectedContentGate({
              contentLabel: "article",
              payload: encryptedPayload,
              storageKey: createProtectedContentStorageKey(publishedSummary.urlPath),
              title: summary.title
            })}`;
          description = PROTECTED_CONTENT_META_DESCRIPTION;
        } else {
          const rendered = await renderArticleHtml(context, record);
          body = `${buildArticleHero(summary, context.basePrefix)}
            <section class="article-layout">
              <article class="article-panel">
                <div class="prose">${rendered.html}</div>
                ${buildArticlePager(previous, next)}
              </article>
              <aside class="side-panel">
                <h3>On This Page</h3>
                ${buildTocTreeHtml(rendered.headings)}
              </aside>
            </section>`;
        }

        const relativeArticlePath = decodeURIComponent(
          `${summary.urlPath.replace(context.basePrefix, "").replace(/^\/+/, "")}index.html`
        );

        await context.writeHtml(
          relativeArticlePath,
          renderPageWithContext(context, {
            basePath: context.basePrefix,
            content: body,
            description,
            navigation,
            siteDescription: context.config.siteDescription,
            siteTitle: context.config.siteTitle,
            title: summary.title
          })
        );
      })
    );
  }
};
