import { enabledNavigation } from "./index.js";
import { renderPageWithContext } from "./render-helpers.js";
import type { SitePagePluginDefinition } from "./types.js";

/**
 * The search results script is written to assets/search.js and runs in the
 * browser. Article titles/excerpts/paths come from frontmatter (i.e. admin
 * input via import/git), so result nodes are built with DOM APIs and
 * textContent — never string-concatenated into innerHTML — matching the
 * escapeHtml discipline used for server-rendered markup.
 */
const SEARCH_RUNTIME_SCRIPT = `const input = document.querySelector('[data-search-input]');
const results = document.querySelector('[data-search-results]');
let index = [];
fetch('__BASE_PREFIX__/assets/search-index.json').then((response) => response.json()).then((payload) => { index = payload; });
function renderMatch(item) {
  const entry = document.createElement('article');
  entry.className = 'post-entry';
  const meta = document.createElement('div');
  meta.className = 'entry-meta';
  const pathLabel = document.createElement('span');
  pathLabel.textContent = item.path;
  meta.appendChild(pathLabel);
  const heading = document.createElement('h2');
  const link = document.createElement('a');
  link.href = item.urlPath;
  link.textContent = item.title;
  heading.appendChild(link);
  const excerpt = document.createElement('p');
  excerpt.textContent = item.excerpt;
  entry.appendChild(meta);
  entry.appendChild(heading);
  entry.appendChild(excerpt);
  return entry;
}
input?.addEventListener('input', () => {
  const query = (input.value || '').trim().toLowerCase();
  const matches = query ? index.filter((item) => item.title.toLowerCase().includes(query) || item.path.toLowerCase().includes(query) || item.tags.some((tag) => tag.toLowerCase().includes(query)) || item.excerpt.toLowerCase().includes(query)) : [];
  results.replaceChildren(...matches.map(renderMatch));
  if (matches.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'No matches.';
    results.appendChild(empty);
  }
});`;

export const searchPlugin: SitePagePluginDefinition = {
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
    const searchScript = SEARCH_RUNTIME_SCRIPT.replaceAll("__BASE_PREFIX__", () => context.basePrefix);
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
