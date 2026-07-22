import {
  renderMarkdownWithKatex,
  resolveManagedMediaPath,
  rewriteManagedMediaUrls,
  rewriteRelativeAssetUrls,
  type ArticleRecord,
  type ArticleSummary
} from "@blog-system/content-core";

import { escapeHtml } from "../escape.js";
import type { SiteBuildContext } from "../runtime.js";

/**
 * HTML building blocks shared by the page plugins (home, tags, tree, article
 * pages, about, search). Everything admin-authored goes through escapeHtml.
 */
export function renderTagRow(article: ArticleSummary, basePath: string) {
  if (article.tags.length === 0) {
    return "";
  }

  return article.tags
    .map(
      (tag) =>
        `<a class="tag-chip" href="${basePath}/tags/${encodeURIComponent(tag)}/">${escapeHtml(tag)}</a>`
    )
    .join("");
}

export function renderArticleMeta(article: ArticleSummary) {
  return [
    article.date ? `<span>${escapeHtml(article.date.slice(0, 10))}</span>` : "",
    article.directory ? `<span>${escapeHtml(article.directory)}</span>` : "<span>root</span>",
    article.top > 0 ? `<span>top ${article.top}</span>` : ""
  ]
    .filter(Boolean)
    .join("");
}

export function renderArticleCard(article: ArticleSummary, basePath: string) {
  const summaryText = article.summary ?? article.excerpt;
  const protectedNote = article.isProtected
    ? `<p class="entry-protected-note">Protected article. Unlock on the article page.</p>`
    : "";

  return `<article class="post-entry">
    <div class="entry-pencil-line" aria-hidden="true"></div>
    <div class="entry-meta">${renderArticleMeta(article)}</div>
    <h2><a href="${article.urlPath}">${escapeHtml(article.title)}</a></h2>
    ${summaryText ? `<p>${escapeHtml(summaryText)}</p>` : protectedNote}
    <div class="entry-footer">
      <span class="entry-path">${escapeHtml(article.path)}</span>
      <div class="tag-row">${renderTagRow(article, basePath)}</div>
    </div>
  </article>`;
}

export function renderPageWithContext(
  context: SiteBuildContext,
  args: Omit<
    Parameters<SiteBuildContext["theme"]["renderPage"]>[0],
    "externalScripts" | "externalStylesheets" | "siteStyleVariables"
  >
) {
  return context.theme.renderPage({
    ...args,
    externalScripts: context.externalScripts,
    externalStylesheets: context.externalStylesheets,
    siteStyleVariables: context.config.backgroundImage
      ? {
          "--site-background-image": `url("${resolveManagedMediaPath(context.config.backgroundImage, `${context.basePrefix}/media`)}")`
        }
      : undefined
  });
}

export function findPublicSummary(context: SiteBuildContext, articlePath: string) {
  return context.publicArticleSummaries.find((article) => article.path === articlePath);
}

export async function renderArticleHtml(
  context: SiteBuildContext,
  record: ArticleRecord
) {
  const rendered = await renderMarkdownWithKatex(
    record.body,
    context.markdownBlockConfig,
    context.markdownFenceRenderers
  );

  if ((rendered.errors?.length ?? 0) > 0) {
    throw new Error(
      `Failed to render markdown fences in ${record.path}: ${rendered.errors
        ?.map((error) => `[${error.fenceLanguage ?? "unknown"}] ${error.message}`)
        .join("; ")}`
    );
  }

  return {
    headings: rendered.headings,
    html: rewriteManagedMediaUrls(
      rewriteRelativeAssetUrls(rendered.html, record.directory, `${context.basePrefix}/content`),
      `${context.basePrefix}/media`
    )
  };
}
