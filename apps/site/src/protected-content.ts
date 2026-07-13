import { webcrypto } from "node:crypto";

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

export function buildProtectedContentRuntimeScript() {
  return `(() => {
  const storagePrefix = ${JSON.stringify(PROTECTED_CONTENT_STORAGE_PREFIX)};

  function decodeBase64(value) {
    const binary = window.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function parsePayload(root) {
    const payloadNode = root.querySelector("[data-protected-payload]");
    if (!payloadNode || !payloadNode.textContent) {
      throw new Error("Missing protected payload.");
    }
    return JSON.parse(payloadNode.textContent);
  }

  function readStoredPassword(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (_error) {
      return null;
    }
  }

  function persistPassword(key, password) {
    try {
      window.localStorage.setItem(key, password);
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  function clearStoredPassword(key) {
    try {
      window.localStorage.removeItem(key);
    } catch (_error) {
      // Ignore storage failures.
    }
  }

  function setStatus(root, message, tone) {
    const status = root.querySelector("[data-protected-status]");
    if (!status) {
      return;
    }

    status.textContent = message;
    if (tone) {
      status.dataset.tone = tone;
    } else {
      delete status.dataset.tone;
    }
  }

  function runEmbeddedScripts(container) {
    const scripts = Array.from(container.querySelectorAll("script"));
    for (const script of scripts) {
      const replacement = document.createElement("script");
      for (const attribute of script.attributes) {
        replacement.setAttribute(attribute.name, attribute.value);
      }
      replacement.textContent = script.textContent;
      script.replaceWith(replacement);
    }
  }

  async function deriveKey(password, salt, iterations, usages) {
    const encoder = new TextEncoder();
    const passwordKey = await window.crypto.subtle.importKey(
      "raw",
      encoder.encode(password),
      "PBKDF2",
      false,
      ["deriveKey"]
    );

    return window.crypto.subtle.deriveKey(
      {
        hash: "SHA-256",
        iterations,
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

  async function decryptPayload(password, payload) {
    if (!payload || payload.version !== ${String(PROTECTED_CONTENT_VERSION)}) {
      throw new Error("Unsupported protected content payload.");
    }

    const salt = decodeBase64(payload.salt);
    const iv = decodeBase64(payload.iv);
    const ciphertext = decodeBase64(payload.ciphertext);
    const key = await deriveKey(password, salt, payload.iterations, ["decrypt"]);
    const plaintext = await window.crypto.subtle.decrypt(
      {
        iv,
        name: "AES-GCM"
      },
      key,
      ciphertext
    );

    return new TextDecoder().decode(plaintext);
  }

  async function unlock(root, password, persist) {
    const payload = parsePayload(root);
    const mount = root.querySelector("[data-protected-mount]");
    if (!mount) {
      throw new Error("Missing protected content mount point.");
    }

    setStatus(root, "Decrypting...", "");
    const html = await decryptPayload(password, payload);
    mount.innerHTML = html;
    mount.hidden = false;
    runEmbeddedScripts(mount);
    root.dataset.state = "unlocked";
    setStatus(root, "", "");

    const storageKey = root.dataset.storageKey || storagePrefix + window.location.pathname;
    if (persist) {
      persistPassword(storageKey, password);
    }
  }

  function initProtectedRoot(root) {
    const supported =
      typeof window !== "undefined" &&
      Boolean(window.crypto && window.crypto.subtle && window.TextEncoder && window.TextDecoder);
    const form = root.querySelector("[data-protected-form]");
    const input = root.querySelector("[data-protected-input]");
    const submit = root.querySelector("[data-protected-submit]");
    const storageKey = root.dataset.storageKey || storagePrefix + window.location.pathname;

    if (!supported || !(form instanceof HTMLFormElement) || !(input instanceof HTMLInputElement)) {
      setStatus(root, "Your browser does not support Web Crypto required for protected content.", "error");
      if (form instanceof HTMLElement) {
        form.hidden = true;
      }
      return;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const password = input.value.trim();

      if (!password) {
        setStatus(root, "Enter a password first.", "error");
        input.focus();
        return;
      }

      if (submit instanceof HTMLButtonElement) {
        submit.disabled = true;
      }

      try {
        await unlock(root, password, true);
      } catch (_error) {
        clearStoredPassword(storageKey);
        setStatus(root, "Wrong password or corrupted payload.", "error");
      } finally {
        if (submit instanceof HTMLButtonElement) {
          submit.disabled = false;
        }
      }
    });

    const rememberedPassword = readStoredPassword(storageKey);
    if (!rememberedPassword) {
      return;
    }

    input.value = rememberedPassword;
    if (submit instanceof HTMLButtonElement) {
      submit.disabled = true;
    }

    unlock(root, rememberedPassword, true)
      .catch(() => {
        clearStoredPassword(storageKey);
        input.value = "";
        setStatus(root, "Stored password is no longer valid. Enter it again.", "error");
      })
      .finally(() => {
        if (submit instanceof HTMLButtonElement) {
          submit.disabled = false;
        }
      });
  }

  for (const root of document.querySelectorAll("[data-protected-content-root]")) {
    if (root instanceof HTMLElement) {
      initProtectedRoot(root);
    }
  }
})();`;
}
