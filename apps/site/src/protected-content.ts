import { webcrypto } from "node:crypto";
import { promises as fs } from "node:fs";

import type {
  ArticleRecord,
  ArticleSummary,
  ContentTreeNode,
  SiteData,
  SiteDirectoryPage,
  TagInfo
} from "@blog-system/content-core";
import { escapeHtml } from "./escape.js";

const textEncoder = new TextEncoder();
const PROTECTED_CONTENT_VERSION = 1;
const PROTECTED_CONTENT_ITERATIONS = 200_000;
const PROTECTED_CONTENT_SALT_BYTES = 16;
const PROTECTED_CONTENT_IV_BYTES = 12;
const PROTECTED_CONTENT_STORAGE_PREFIX = "blog-system-protected-content:";

export const PROTECTED_CONTENT_PLUGIN_ID = "protected-content";
export const PROTECTED_CONTENT_SCRIPT_RELATIVE_PATH = "assets/protected-content.js";
export const PROTECTED_CONTENT_STYLE_RELATIVE_PATH = "assets/protected-content.css";
export const PROTECTED_CONTENT_META_DESCRIPTION =
  "This article is protected. Enter the password to decrypt the content in your browser.";

export interface ProtectedContentPayload {
  ciphertext: string;
  iterations: number;
  iv: string;
  salt: string;
  version: number;
}

function cloneProtectedSummary(article: ArticleSummary): ArticleSummary {
  if (!article.isProtected) {
    return article;
  }

  // Only hide the excerpt — keep tags and summary visible so protected
  // articles still appear in tag listings (password guards the body,
  // not discoverability).
  return article;
}

function cloneProtectedTree(nodes: ContentTreeNode[]): ContentTreeNode[] {
  return nodes.map((node) => {
    if (node.type === "article" && node.article) {
      return {
        ...node,
        article: cloneProtectedSummary(node.article)
      };
    }

    if (node.type === "directory" && node.children) {
      return {
        ...node,
        children: cloneProtectedTree(node.children)
      };
    }

    return node;
  });
}

function cloneProtectedDirectory(directory: SiteDirectoryPage): SiteDirectoryPage {
  return {
    ...directory,
    articles: directory.articles.map(cloneProtectedSummary),
    children: directory.children.map(cloneProtectedDirectory)
  };
}

function collectPublicTags(articles: ArticleSummary[]): TagInfo[] {
  const tagMap = new Map<string, TagInfo>();

  for (const article of articles) {
    for (const tag of article.tags) {
      const existing = tagMap.get(tag) ?? {
        count: 0,
        draftCount: 0,
        publishedCount: 0,
        tag
      };
      existing.count += 1;
      if (article.status === "published") {
        existing.publishedCount += 1;
      } else {
        existing.draftCount += 1;
      }
      tagMap.set(tag, existing);
    }
  }

  return [...tagMap.values()].sort((left, right) => left.tag.localeCompare(right.tag));
}

function toBase64(bytes: Uint8Array) {
  return Buffer.from(bytes).toString("base64");
}

function trimPassword(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim();
}

async function deriveAesKey(
  password: string,
  salt: Uint8Array,
  usages: KeyUsage[]
) {
  const passwordKey = await webcrypto.subtle.importKey(
    "raw",
    textEncoder.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return webcrypto.subtle.deriveKey(
    {
      hash: "SHA-256",
      iterations: PROTECTED_CONTENT_ITERATIONS,
      name: "PBKDF2",
      salt
    },
    passwordKey,
    {
      length: 256,
      name: "AES-GCM"
    },
    false,
    usages
  );
}

export function hasProtectedArticles(records: ArticleRecord[]) {
  return records.some((record) => record.isProtected);
}

export function getProtectedArticlePassword(record: ArticleRecord) {
  const password = trimPassword(record.frontmatter.password);

  if (!password) {
    throw new Error(`Protected article ${record.path} is missing a usable password.`);
  }

  return password;
}

export function createProtectedContentStorageKey(urlPath: string) {
  return `${PROTECTED_CONTENT_STORAGE_PREFIX}${urlPath}`;
}

export async function encryptProtectedHtml(
  html: string,
  password: string
): Promise<ProtectedContentPayload> {
  const salt = webcrypto.getRandomValues(new Uint8Array(PROTECTED_CONTENT_SALT_BYTES));
  const iv = webcrypto.getRandomValues(new Uint8Array(PROTECTED_CONTENT_IV_BYTES));
  const key = await deriveAesKey(password, salt, ["encrypt"]);
  const ciphertext = await webcrypto.subtle.encrypt(
    {
      iv,
      name: "AES-GCM"
    },
    key,
    textEncoder.encode(html)
  );

  return {
    ciphertext: toBase64(new Uint8Array(ciphertext)),
    iterations: PROTECTED_CONTENT_ITERATIONS,
    iv: toBase64(iv),
    salt: toBase64(salt),
    version: PROTECTED_CONTENT_VERSION
  };
}

export function sanitizeSiteDataForProtectedContent(siteData: SiteData): SiteData {
  const articles = siteData.articles.map(cloneProtectedSummary);

  return {
    ...siteData,
    articles,
    directories: siteData.directories.map(cloneProtectedDirectory),
    tags: collectPublicTags(articles),
    tree: cloneProtectedTree(siteData.tree)
  };
}

export function renderProtectedContentGate(args: {
  contentLabel: string;
  payload: ProtectedContentPayload;
  storageKey: string;
  title: string;
}) {
  const payloadJson = JSON.stringify(args.payload).replace(/</g, "\\u003c");
  const contentLabel = escapeHtml(args.contentLabel);

  return `<section class="protected-gate" data-protected-content-root data-state="locked" data-storage-key="${escapeHtml(args.storageKey)}">
    <div class="protected-gate__card" data-protected-card>
      <p class="protected-gate__eyebrow">Protected content</p>
      <h2>Unlock this ${contentLabel}</h2>
      <p class="protected-gate__copy">"${escapeHtml(args.title)}" is encrypted in the generated site. Enter the password to decrypt it in your browser.</p>
      <form class="protected-gate__form" data-protected-form>
        <label class="protected-gate__field">
          <span>Password</span>
          <input type="password" autocomplete="current-password" data-protected-input placeholder="Enter password">
        </label>
        <button type="submit" data-protected-submit>Unlock</button>
      </form>
      <p class="protected-gate__status" data-protected-status aria-live="polite"></p>
      <noscript><p class="protected-gate__status" data-tone="error">JavaScript is required to decrypt protected content.</p></noscript>
    </div>
    <script type="application/json" data-protected-payload>${payloadJson}</script>
    <div data-protected-mount hidden></div>
  </section>`;
}

export function buildProtectedContentRuntimeStyles() {
  return `.entry-protected-note {
  color: var(--muted, #52606d);
  font-style: italic;
}

.tag-row--suppressed {
  display: none;
}

.protected-gate {
  display: grid;
  gap: 24px;
}

.protected-gate__card {
  display: grid;
  gap: 18px;
  padding: 28px;
  border: 1px dashed color-mix(in srgb, var(--stroke, #1f2937) 28%, transparent);
  border-radius: 24px;
  background: color-mix(in srgb, var(--paper, rgba(255, 251, 245, 0.94)) 92%, white 8%);
  box-shadow: var(--shadow, 0 20px 50px rgba(15, 23, 42, 0.12));
}

.protected-gate__eyebrow {
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  font-size: 0.78rem;
  color: var(--accent, #c2410c);
}

.protected-gate__card h2,
.protected-gate__copy,
.protected-gate__status {
  margin: 0;
}

.protected-gate__copy {
  color: var(--muted, #52606d);
  line-height: 1.7;
}

.protected-gate__form {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: end;
}

.protected-gate__field {
  display: grid;
  gap: 8px;
  flex: 1 1 280px;
}

.protected-gate__field span {
  font-size: 0.92rem;
  font-weight: 600;
}

.protected-gate__field input {
  width: 100%;
  min-height: 48px;
  padding: 12px 14px;
  border-radius: 14px;
  border: 1px solid color-mix(in srgb, var(--stroke, #1f2937) 24%, transparent);
  background: color-mix(in srgb, var(--paper, #fff) 86%, white 14%);
  color: inherit;
  font: inherit;
}

.protected-gate__form button {
  min-height: 48px;
  padding: 0 18px;
  border: 0;
  border-radius: 14px;
  background: var(--accent, #c2410c);
  color: #fff;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

.protected-gate__form button[disabled] {
  cursor: wait;
  opacity: 0.72;
}

.protected-gate__status {
  min-height: 1.4em;
  color: var(--muted, #52606d);
}

.protected-gate__status[data-tone="error"] {
  color: #b91c1c;
}

.protected-gate[data-state="unlocked"] .protected-gate__card {
  display: none;
}

@media (max-width: 720px) {
  .protected-gate__card {
    padding: 22px;
  }

  .protected-gate__form {
    flex-direction: column;
    align-items: stretch;
  }
}`;
}

const PROTECTED_CONTENT_RUNTIME_ASSET_URL = new URL(
  "./assets/protected-content-runtime.js",
  import.meta.url
);
const STORAGE_PREFIX_TOKEN = '"__PROTECTED_CONTENT_STORAGE_PREFIX__"';
const VERSION_TOKEN = "__PROTECTED_CONTENT_VERSION__";

/**
 * Loads the browser runtime from src/assets/protected-content-runtime.js and
 * bakes in the storage prefix / payload version so the shipped script matches
 * the values used by the encryption helpers above. The asset is read at site
 * build time and written out as a static site asset by the protected-content
 * plugin; keeping it as a plain .js file lets editors highlight/lint it.
 */
export async function buildProtectedContentRuntimeScript() {
  const template = (await fs.readFile(PROTECTED_CONTENT_RUNTIME_ASSET_URL, "utf8")).replace(/\n$/, "");

  if (!template.includes(STORAGE_PREFIX_TOKEN) || !template.includes(VERSION_TOKEN)) {
    throw new Error(
      "assets/protected-content-runtime.js is missing the protected-content replacement tokens."
    );
  }

  return template
    .replace(STORAGE_PREFIX_TOKEN, JSON.stringify(PROTECTED_CONTENT_STORAGE_PREFIX))
    .replace(VERSION_TOKEN, String(PROTECTED_CONTENT_VERSION));
}
