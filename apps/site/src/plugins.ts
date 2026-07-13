import {
  renderMarkdownWithKatex,
  resolveManagedMediaPath,
  rewriteManagedMediaUrls,
  rewriteRelativeAssetUrls,
  type ArticleRecord,
  type ArticleSummary,
  type HeadingItem
} from "@blog-system/content-core";
import {
  COMMUTATIVE_FENCE_LANGUAGE,
  commutativeCssText,
  renderCommutativeFence
} from "@blog-system/commutative";

import type {
  SiteBuildContext,
  SiteMarkdownPluginDefinition,
  SiteProtectedContentPluginDefinition,
  SitePluginDefinition,
  SiteThemePluginDefinition
} from "./runtime.js";
import {
  PROTECTED_CONTENT_META_DESCRIPTION,
  PROTECTED_CONTENT_PLUGIN_ID,
  PROTECTED_CONTENT_SCRIPT_RELATIVE_PATH,
  PROTECTED_CONTENT_STYLE_RELATIVE_PATH,
  buildProtectedContentRuntimeScript,
  buildProtectedContentRuntimeStyles,
  createProtectedContentStorageKey,
  encryptProtectedHtml,
  getProtectedArticlePassword,
  renderProtectedContentGate,
  sanitizeSiteDataForProtectedContent
} from "./protected-content.js";
import { escapeHtml } from "./escape.js";

const HOME_PAGE_SIZE = 12;
const COMMUTATIVE_SITE_PLUGIN_ID = "commutative";

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

function renderTagRow(article: ArticleSummary, basePath: string) {
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

function renderArticleMeta(article: ArticleSummary) {
  return [
    article.date ? `<span>${escapeHtml(article.date.slice(0, 10))}</span>` : "",
    article.directory ? `<span>${escapeHtml(article.directory)}</span>` : "<span>root</span>",
    article.top > 0 ? `<span>top ${article.top}</span>` : ""
  ]
    .filter(Boolean)
    .join("");
}

function renderArticleCard(article: ArticleSummary, basePath: string) {
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

function renderPageWithContext(
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

function chunkArticles(articles: ArticleSummary[], size: number) {
  const pages: ArticleSummary[][] = [];

  for (let index = 0; index < articles.length; index += size) {
    pages.push(articles.slice(index, index + size));
  }

  return pages.length > 0 ? pages : [[]];
}

function findPublicSummary(context: SiteBuildContext, articlePath: string) {
  return context.publicArticleSummaries.find((article) => article.path === articlePath);
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

async function renderArticleHtml(
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

const atlasTheme = {
  id: "atlas",
  label: "Atlas",
  renderPage({
    basePath,
    bodyClass,
    content,
    description,
    externalScripts = [],
    externalStylesheets = [],
    headerMode = "brand",
    navigation,
    siteDescription,
    siteStyleVariables = {},
    siteTitle,
    title
  }) {
    const siteStyleVariableCss = Object.entries(siteStyleVariables)
      .map(([key, value]) => `${key}: ${value};`)
      .join(" ");
    return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}">
    ${externalStylesheets.map((href) => `<link rel="stylesheet" href="${escapeHtml(href)}">`).join("\n    ")}
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.min.css">
    ${siteStyleVariableCss ? `<style>:root { ${siteStyleVariableCss} }</style>` : ""}
  </head>
  <body class="${bodyClass ?? ""}">
    <div class="paper-background">
      <div class="paper-background__grain"></div>
      <div class="paper-background__geometry"></div>
    </div>
    <div class="site-shell">
      <header class="site-header ${headerMode === "nav-only" ? "nav-only" : ""}">
        <a class="site-brand" href="${basePath}/">
          <span class="site-brand__mark">ED</span>
          <span class="site-brand__text">${escapeHtml(siteTitle)}</span>
        </a>
        <p class="site-intro">${escapeHtml(siteDescription)}</p>
        <nav class="site-nav">
          ${navigation.map((item) => `<a href="${item.href}">${escapeHtml(item.label)}</a>`).join("")}
        </nav>
      </header>
      <main class="page-shell">
        ${content}
      </main>
      <footer class="site-footer">
        <div class="site-footer__identity">
          <strong class="site-footer__brand">${escapeHtml(siteTitle)}</strong>
          <p>${escapeHtml(siteDescription)}</p>
        </div>
      </footer>
    </div>
    ${externalScripts.map((src) => `<script src="${escapeHtml(src)}"></script>`).join("\n    ")}
  </body>
</html>`;
  }
};

export const atlasThemePlugin: SiteThemePluginDefinition = {
  id: "atlas",
  kind: "theme",
  label: "Atlas Theme",
  theme: atlasTheme
};

export const topOrderPlugin: SitePluginDefinition = {
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

export const homePlugin: SitePluginDefinition = {
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

export const articlePagesPlugin: SitePluginDefinition = {
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

        await context.writeHtml(
          `${summary.urlPath.replace(context.basePrefix, "").replace(/^\/+/, "")}index.html`,
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

export const tagsPlugin: SitePluginDefinition = {
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
          `tags/${encodeURIComponent(tag.tag)}/index.html`,
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

function flattenDirectories(directories: typeof import("@blog-system/content-core").SiteDirectoryPage[]) {
  return directories.flatMap((directory) => [directory, ...flattenDirectories(directory.children)]);
}

function renderDirectoryTree(directories: typeof import("@blog-system/content-core").SiteDirectoryPage[]) {
  return `<ul class="tree-list">${directories
    .map(
      (directory) => `<li><a href="${directory.urlPath}">${escapeHtml(directory.name)}</a>${directory.children.length > 0 ? renderDirectoryTree(directory.children) : ""}</li>`
    )
    .join("")}</ul>`;
}

export const treePlugin: SitePluginDefinition = {
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

export const aboutPlugin: SitePluginDefinition = {
  id: "about",
  kind: "page",
  label: "About",
  getNavigationItem: (context) =>
    context.aboutArticle
      ? {
          href: `${context.basePrefix}/about/`,
          label: "About"
        }
      : null,
  async run(context) {
    if (!context.aboutArticle) {
      return;
    }

    const navigation = enabledNavigation(context);
    const publicSummary = findPublicSummary(context, context.aboutArticle.path);
    const title = publicSummary?.title ?? context.aboutArticle.title;
    let body = "";
    let description = publicSummary?.excerpt ?? context.aboutArticle.excerpt;

    if (context.aboutArticle.isProtected) {
      const rendered = await renderArticleHtml(context, context.aboutArticle);
      const encryptedPayload = await encryptProtectedHtml(
        `<section class="article-panel article-panel--single"><div class="prose">${rendered.html}</div></section>`,
        getProtectedArticlePassword(context.aboutArticle)
      );
      body = `<section class="subhero-panel"><h1>${escapeHtml(title)}</h1></section>
        ${renderProtectedContentGate({
          contentLabel: "page",
          payload: encryptedPayload,
          storageKey: createProtectedContentStorageKey(`${context.basePrefix}/about/`),
          title
        })}`;
      description = PROTECTED_CONTENT_META_DESCRIPTION;
    } else {
      const rendered = await renderArticleHtml(context, context.aboutArticle);
      body = `<section class="subhero-panel"><h1>${escapeHtml(title)}</h1></section>
        <section class="article-panel article-panel--single"><div class="prose">${rendered.html}</div></section>`;
    }

    await context.writeHtml(
      "about/index.html",
      renderPageWithContext(context, {
        basePath: context.basePrefix,
        content: body,
        description,
        navigation,
        siteDescription: context.config.siteDescription,
        siteTitle: context.config.siteTitle,
        title
      })
    );
  }
};

export const searchPlugin: SitePluginDefinition = {
  id: "search",
  kind: "page",
  label: "Search",
  getNavigationItem: (context) => ({
    href: `${context.basePrefix}/search/`,
    label: "Search"
  }),
  async run(context) {
    const navigation = enabledNavigation(context);
    const searchIndex = context.publicArticleSummaries
      .filter((article) => !article.isProtected)
      .map((article) => ({
        excerpt: article.excerpt,
        path: article.path,
        tags: article.tags,
        title: article.title,
        urlPath: article.urlPath
      }));
    const searchScript = `const input = document.querySelector('[data-search-input]'); const results = document.querySelector('[data-search-results]'); let index = []; fetch('${context.basePrefix}/assets/search-index.json').then((response) => response.json()).then((payload) => { index = payload; }); input?.addEventListener('input', () => { const query = (input.value || '').trim().toLowerCase(); const matches = query ? index.filter((item) => item.title.toLowerCase().includes(query) || item.path.toLowerCase().includes(query) || item.tags.some((tag) => tag.toLowerCase().includes(query)) || item.excerpt.toLowerCase().includes(query)) : []; results.innerHTML = matches.map((item) => '<article class="post-entry"><div class="entry-meta"><span>' + item.path + '</span></div><h2><a href="' + item.urlPath + '">' + item.title + '</a></h2><p>' + item.excerpt + '</p></article>').join('') || '<p>No matches.</p>'; });`;
    await context.writeTextAsset("assets/search-index.json", `${JSON.stringify(searchIndex, null, 2)}\n`);
    await context.writeTextAsset("assets/search.js", searchScript);

    const body = `<section class="subhero-panel"><h1>Search</h1><p>Look up titles, tags, and paths.</p></section>
      <section class="content-section">
        <input class="search-input" data-search-input placeholder="Search articles">
        <div class="post-list" data-search-results><p>Type to search.</p></div>
      </section>
      <script src="${context.basePrefix}/assets/search.js"></script>`;

    await context.writeHtml(
      "search/index.html",
      renderPageWithContext(context, {
        basePath: context.basePrefix,
        content: body,
        description: "Search the knowledge base.",
        navigation,
        siteDescription: context.config.siteDescription,
        siteTitle: context.config.siteTitle,
        title: "Search"
      })
    );
  }
};

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

export const protectedContentPlugin: SiteProtectedContentPluginDefinition = {
  id: PROTECTED_CONTENT_PLUGIN_ID,
  kind: "protected-content",
  label: "Protected Content",
  getAssets(context) {
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
        content: buildProtectedContentRuntimeScript(),
        relativePath: PROTECTED_CONTENT_SCRIPT_RELATIVE_PATH,
        urlPath: `${context.basePrefix}/${PROTECTED_CONTENT_SCRIPT_RELATIVE_PATH}`.replace(/\/{2,}/g, "/")
      }
    ];
  }
};

export const sitePlugins = [
  atlasThemePlugin,
  protectedContentPlugin,
  commutativePlugin,
  topOrderPlugin,
  homePlugin,
  articlePagesPlugin,
  tagsPlugin,
  treePlugin,
  aboutPlugin,
  searchPlugin
];

function enabledNavigation(context: Parameters<Exclude<SitePluginDefinition["getNavigationItem"], undefined>>[0]) {
  return sitePlugins
    .filter((plugin) => context.config.enabledPlugins.includes(plugin.id))
    .map((plugin) => plugin.getNavigationItem?.(context))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));
}
