import { escapeHtml } from "../escape.js";
import {
  PROTECTED_CONTENT_META_DESCRIPTION,
  createProtectedContentStorageKey,
  encryptProtectedHtml,
  getProtectedArticlePassword,
  renderProtectedContentGate
} from "../protected-content.js";
import { enabledNavigation } from "./index.js";
import { findPublicSummary, renderArticleHtml, renderPageWithContext } from "./render-helpers.js";
import type { SitePagePluginDefinition } from "./types.js";

export const aboutPlugin: SitePagePluginDefinition = {
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
