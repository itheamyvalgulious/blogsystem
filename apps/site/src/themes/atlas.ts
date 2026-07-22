import { escapeHtml } from "../escape.js";
import type { SiteThemeDefinition } from "../runtime.js";

/**
 * Built-in Atlas theme. Themes only depend on the shared runtime types and
 * must not import plugin internals; the plugin wrapper that registers this
 * theme lives in plugins/atlas-theme.ts.
 */
export const atlasTheme: SiteThemeDefinition = {
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
