import { dump, load } from "js-yaml";

import type { ArticleFrontmatter, ArticleRecord, ArticleStatus } from "./types.js";

const TITLE_HEADING_REGEX = /^#\s+(.+)$/m;

function normalizeLineEndings(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
}

export function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;")
    .replace(/\n/g, "&#10;");
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function hashText(value: string): string {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

export function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.md$/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function titleFromMarkdownBody(body: string, relativePath: string): string {
  const normalizedBody = normalizeLineEndings(body);
  const headingMatch = normalizedBody.match(TITLE_HEADING_REGEX);

  if (headingMatch?.[1]) {
    return headingMatch[1].trim();
  }

  const fileName = relativePath.split("/").pop() ?? relativePath;
  return titleFromFileName(fileName);
}

export function slugifySegment(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function createDefaultSlug(title: string, date?: string): string {
  const titleSlug = slugifySegment(title) || "untitled";
  const dateSegment = date ? date.slice(0, 10) : "";
  return dateSegment ? `${titleSlug}-${dateSegment}` : titleSlug;
}

export function getExcerpt(body: string, maxLength = 180): string {
  const plain = normalizeLineEndings(body)
    .replace(/^---[\s\S]*?---/g, "")
    .replace(/`{1,3}[^`]*`{1,3}/g, " ")
    .replace(/\$[^$]+\$/g, " ")
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/[#>*_-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (plain.length <= maxLength) {
    return plain;
  }

  return `${plain.slice(0, maxLength - 1).trim()}...`;
}

export function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item).trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

export function normalizeStatus(value: unknown): ArticleStatus {
  if (value === "published" || value === "working") {
    return value;
  }

  return "draft";
}

export function normalizeTop(value: unknown): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.trunc(parsed);
}

export function normalizePassword(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeFrontmatter(
  input: ArticleFrontmatter,
  body: string,
  relativePath: string
): ArticleFrontmatter {
  const { state: legacyState, ...rest } = input as ArticleFrontmatter & {
    state?: unknown;
  };
  const rawDate = rest.date as unknown;
  const normalizedDateValue =
    typeof rawDate === "string"
      ? rawDate.trim()
      : rawDate instanceof Date && Number.isFinite(rawDate.valueOf())
        ? rawDate.toISOString()
        : undefined;
  const title =
    typeof rest.title === "string" && rest.title.trim()
      ? rest.title.trim()
      : titleFromMarkdownBody(body, relativePath);
  const date = normalizedDateValue ? normalizedDateValue : undefined;
  const top = normalizeTop(rest.top);
  const slug =
    typeof rest.slug === "string" && rest.slug.trim() ? rest.slug.trim() : undefined;
  const password = normalizePassword(rest.password);
  const summary = normalizeOptionalText(rest.summary);
  const statusSource =
    typeof rest.status === "string" && rest.status.trim()
      ? rest.status
      : typeof legacyState === "string" && legacyState.trim()
        ? legacyState
        : undefined;

  return {
    ...rest,
    title,
    tags: normalizeTags(rest.tags),
    status: normalizeStatus(statusSource),
    top,
    date,
    summary,
    slug,
    password
  };
}

export function parseArticleSource(relativePath: string, rawContent: string): ArticleRecord {
  const normalizedPath = toPosixPath(relativePath);
  const normalizedRawContent = normalizeLineEndings(rawContent);
  const parsed = parseFrontmatterBlock(normalizedRawContent);
  const body = normalizeLineEndings(parsed.content).replace(/^\n+/, "");
  const frontmatter = normalizeFrontmatter(parsed.data, body, normalizedPath);
  const title = String(frontmatter.title ?? titleFromMarkdownBody(body, normalizedPath));
  const slug = frontmatter.slug ? String(frontmatter.slug) : createDefaultSlug(title, frontmatter.date);
  const directory = normalizedPath.includes("/")
    ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/"))
    : "";
  const fileName = normalizedPath.split("/").pop() ?? normalizedPath;

  return {
    path: normalizedPath,
    directory,
    fileName,
    rawContent: normalizedRawContent,
    body,
    frontmatter,
    title,
    slug,
    status: normalizeStatus(frontmatter.status),
    top: normalizeTop(frontmatter.top),
    date: frontmatter.date,
    summary: frontmatter.summary,
    tags: normalizeTags(frontmatter.tags),
    excerpt: frontmatter.summary ?? getExcerpt(body),
    isProtected: Boolean(normalizePassword(frontmatter.password))
  };
}

export function parseRawFrontmatter(rawContent: string): ArticleFrontmatter {
  return parseFrontmatterBlock(normalizeLineEndings(rawContent)).data;
}

export function serializeArticle(record: Pick<ArticleRecord, "frontmatter" | "body">): string {
  const body = normalizeLineEndings(record.body).replace(/\s+$/, "");
  const normalizedFrontmatter = Object.fromEntries(
    Object.entries(record.frontmatter).filter(([, value]) => value !== undefined)
  );
  const yaml = dump(normalizedFrontmatter, {
    lineWidth: 120,
    noRefs: true
  }).trimEnd();

  return `---\n${yaml}\n---\n\n${body}\n`;
}

export function normalizeArticleForSave(relativePath: string, rawContent: string): ArticleRecord {
  const record = parseArticleSource(relativePath, rawContent);
  const serialized = serializeArticle({
    frontmatter: record.frontmatter,
    body: record.body
  });

  return {
    ...record,
    rawContent: serialized
  };
}

function parseFrontmatterBlock(rawContent: string): {
  data: ArticleFrontmatter;
  content: string;
} {
  if (!rawContent.startsWith("---\n")) {
    return {
      data: {},
      content: rawContent
    };
  }

  const closingIndex = rawContent.indexOf("\n---\n", 4);

  if (closingIndex === -1) {
    return {
      data: {},
      content: rawContent
    };
  }

  const rawFrontmatter = rawContent.slice(4, closingIndex);
  const content = rawContent.slice(closingIndex + 5);
  const loaded = load(rawFrontmatter);

  return {
    data: loaded && typeof loaded === "object" ? (loaded as ArticleFrontmatter) : {},
    content
  };
}

export function toArticleSummary(record: ArticleRecord, basePath = "") {
  const directoryPrefix = record.directory
    ? `/${record.directory
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`
    : "";
  const normalizedBase = basePath ? `/${basePath.replace(/^\/+|\/+$/g, "")}` : "";
  const urlPath = `${normalizedBase}/posts${directoryPrefix}/${encodeURIComponent(record.slug)}/`
    .replace(/\/{2,}/g, "/");

  return {
    path: record.path,
    directory: record.directory,
    fileName: record.fileName,
    title: record.title,
    slug: record.slug,
    status: record.status,
    top: record.top,
    date: record.date,
    summary: record.summary,
    tags: record.tags,
    excerpt: record.excerpt,
    urlPath,
    isProtected: record.isProtected
  };
}
