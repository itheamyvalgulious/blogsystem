import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  ArticleFrontmatter,
  ArticleRecord,
  ArticleSummary,
  ContentTreeNode,
  FileSystemNode,
  SiteData,
  SiteDirectoryPage,
  TagInfo
} from "./types.js";
import {
  normalizeArticleForSave,
  normalizePassword,
  normalizeStatus,
  normalizeTags,
  normalizeTop,
  parseArticleSource,
  serializeArticle,
  toArticleSummary,
  toPosixPath
} from "./utils.js";

const DIRECTORY_METADATA_FILE_NAME = ".blog-system-folder.json";

async function walkDirectory(rootDir: string, currentDir = ""): Promise<string[]> {
  const absoluteDir = path.join(rootDir, currentDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const relativePath = currentDir ? path.join(currentDir, entry.name) : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await walkDirectory(rootDir, relativePath)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(toPosixPath(relativePath));
    }
  }

  return files;
}

export async function loadDirectoryMetadata(contentRoot: string, relativeDirectoryPath: string) {
  const normalizedDirectoryPath = toPosixPath(relativeDirectoryPath).replace(/\/+$/g, "");
  const segments = normalizedDirectoryPath ? normalizedDirectoryPath.split("/") : [];
  const merged: Record<string, unknown> = {};

  for (let index = 0; index <= segments.length; index += 1) {
    const candidateDirectory = segments.slice(0, index).join("/");
    const metadataPath = resolveContentPath(
      contentRoot,
      candidateDirectory
        ? path.posix.join(candidateDirectory, DIRECTORY_METADATA_FILE_NAME)
        : DIRECTORY_METADATA_FILE_NAME
    );

    try {
      const rawMetadata = await fs.readFile(metadataPath, "utf8");
      const parsed = JSON.parse(rawMetadata) as Record<string, unknown>;

      for (const [key, value] of Object.entries(parsed)) {
        if (value !== undefined && value !== null) {
          merged[key] = value;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }

      throw error;
    }
  }

  return merged;
}

async function loadDirectoryMetadataTags(contentRoot: string, relativeDirectoryPath: string) {
  const merged = await loadDirectoryMetadata(contentRoot, relativeDirectoryPath);
  return normalizeTags(merged.tags);
}

async function walkFileSystemTree(
  rootDir: string,
  articleMap: Map<string, ArticleRecord>,
  basePath = "",
  currentDir = ""
): Promise<FileSystemNode[]> {
  const absoluteDir = path.join(rootDir, currentDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const nodes: FileSystemNode[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const relativePath = toPosixPath(currentDir ? path.join(currentDir, entry.name) : entry.name);

    if (entry.isDirectory()) {
      const metadataPath = path.join(absoluteDir, entry.name, DIRECTORY_METADATA_FILE_NAME);
      let hasMetadata = false;
      try {
        // The indicator should reflect meaningful content, not mere file
        // existence: a leftover empty "{}" file (e.g. from a prior clear) must
        // not keep the dot lit.
        const raw = await fs.readFile(metadataPath, "utf8");
        const parsed = JSON.parse(raw);
        hasMetadata =
          parsed !== null &&
          typeof parsed === "object" &&
          !Array.isArray(parsed) &&
          Object.keys(parsed).length > 0;
      } catch (error) {
        // ENOENT (no file) or a malformed JSON file: no indicator. Saving via
        // the folder metadata dialog repairs the file either way.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          hasMetadata = false;
        }
      }

      nodes.push({
        type: "directory",
        name: entry.name,
        path: relativePath,
        children: await walkFileSystemTree(rootDir, articleMap, basePath, relativePath),
        hasMetadata
      });
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const article = articleMap.get(relativePath);
    nodes.push({
      type: "file",
      name: entry.name,
      path: relativePath,
      extension: path.posix.extname(relativePath).toLowerCase(),
      fileKind: article ? "article" : "asset",
      article: article ? toArticleSummary(article, basePath) : undefined
    });
  }

  return nodes;
}

export function sortArticles(records: ArticleRecord[]): ArticleRecord[] {
  return [...records].sort((left, right) => {
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
}

export async function readArticle(contentRoot: string, relativePath: string): Promise<ArticleRecord> {
  const absolutePath = resolveContentPath(contentRoot, relativePath);
  const rawContent = await fs.readFile(absolutePath, "utf8");
  const parsed = parseArticleSource(relativePath, rawContent);
  const inheritedMetadata = await loadDirectoryMetadata(contentRoot, parsed.directory);

  const inheritedTags = normalizeTags(inheritedMetadata.tags);
  const mergedTags = [...inheritedTags, ...parsed.tags].filter(
    (tag, index, tags) => tags.indexOf(tag) === index
  );

  const inheritedFrontmatter: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inheritedMetadata)) {
    if (key === "tags") continue;
    if (parsed.frontmatter[key] === undefined || parsed.frontmatter[key] === null) {
      inheritedFrontmatter[key] = value;
    }
  }

  const hasInheritedTags = mergedTags.length !== parsed.tags.length || !mergedTags.every((tag, index) => tag === parsed.tags[index]);
  const hasInheritedKeys = Object.keys(inheritedFrontmatter).length > 0;

  if (!hasInheritedTags && !hasInheritedKeys) {
    return parsed;
  }

  const cleanParsedFrontmatter: Record<string, unknown> = Object.fromEntries(
    Object.entries(parsed.frontmatter).filter(([, v]) => v !== undefined)
  );
  const frontmatter: Record<string, unknown> = {
    ...inheritedFrontmatter,
    ...cleanParsedFrontmatter,
    tags: mergedTags
  };

  const fm = frontmatter as ArticleFrontmatter;
  const title = String(fm.title ?? parsed.title);
  const slug = fm.slug ? String(fm.slug) : parsed.slug;

  return {
    ...parsed,
    frontmatter: fm,
    title,
    slug,
    tags: mergedTags,
    status: normalizeStatus(fm.status),
    top: normalizeTop(fm.top),
    date: fm.date,
    isProtected: Boolean(normalizePassword(fm.password)),
    // Preserve the file's original source for editor round-trips. Effective
    // inherited metadata lives on the computed fields above, not in rawContent.
    rawContent
  };
}

export async function scanArticles(contentRoot: string): Promise<ArticleRecord[]> {
  const markdownPaths = await walkDirectory(contentRoot);
  const records = await Promise.all(markdownPaths.map((relativePath) => readArticle(contentRoot, relativePath)));
  return sortArticles(records);
}

export async function buildFileSystemTree(
  contentRoot: string,
  articles?: ArticleRecord[],
  basePath = ""
): Promise<FileSystemNode[]> {
  const resolvedArticles = articles ?? (await scanArticles(contentRoot));
  const articleMap = new Map(resolvedArticles.map((article) => [article.path, article]));
  return walkFileSystemTree(contentRoot, articleMap, basePath);
}

export function buildContentTree(articles: ArticleRecord[], basePath = ""): ContentTreeNode[] {
  const root: ContentTreeNode[] = [];

  for (const article of articles) {
    const segments = article.directory ? article.directory.split("/") : [];
    let cursor = root;
    let currentPath = "";

    for (const segment of segments) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      let nextNode = cursor.find(
        (node) => node.type === "directory" && node.path === currentPath
      );

      if (!nextNode) {
        nextNode = {
          type: "directory",
          name: segment,
          path: currentPath,
          children: []
        };
        cursor.push(nextNode);
      }

      cursor = nextNode.children ?? [];
      nextNode.children = cursor;
    }

    cursor.push({
      type: "article",
      name: article.title,
      path: article.path,
      article: toArticleSummary(article, basePath)
    });
  }

  return root;
}

export function collectTags(articles: ArticleRecord[]): TagInfo[] {
  const tagMap = new Map<string, TagInfo>();

  for (const article of articles) {
    for (const tag of article.tags) {
      const existing = tagMap.get(tag) ?? {
        tag,
        count: 0,
        draftCount: 0,
        publishedCount: 0
      };
      existing.count += 1;
      if (article.status === "published") {
        existing.publishedCount += 1;
      } else if (article.status === "working") {
        existing.publishedCount += 1;
      } else {
        existing.draftCount += 1;
      }
      tagMap.set(tag, existing);
    }
  }

  return [...tagMap.values()].sort((left, right) => left.tag.localeCompare(right.tag));
}

function buildDirectoryPages(
  treeNodes: ContentTreeNode[],
  basePath = "",
  currentPath = ""
): SiteDirectoryPage[] {
  const normalizedBase = basePath ? `/${basePath.replace(/^\/+|\/+$/g, "")}` : "";

  return treeNodes
    .filter((node): node is ContentTreeNode & { type: "directory"; children: ContentTreeNode[] } => node.type === "directory")
    .map((node) => {
      const articles = (node.children ?? [])
        .filter((child): child is ContentTreeNode & { type: "article"; article: ArticleSummary } => child.type === "article" && Boolean(child.article))
        .map((child) => child.article as ArticleSummary);
      const nextPath = currentPath ? `${currentPath}/${node.name}` : node.name;
      return {
        path: nextPath,
        name: node.name,
        articles,
        children: buildDirectoryPages(node.children ?? [], basePath, nextPath),
        urlPath: `${normalizedBase}/tree/${nextPath
          .split("/")
          .map((segment) => encodeURIComponent(segment))
          .join("/")}/`.replace(/\/{2,}/g, "/")
      };
    });
}

export async function loadSiteData(contentRoot: string, basePath = ""): Promise<SiteData> {
  const allArticles = await scanArticles(contentRoot);
  const visibleArticles = allArticles.filter((article) => article.status === "published" || article.status === "working");
  const tree = buildContentTree(visibleArticles, basePath);

  return {
    articles: visibleArticles.map((article) => toArticleSummary(article, basePath)),
    tags: collectTags(visibleArticles),
    tree,
    directories: buildDirectoryPages(tree, basePath)
  };
}

export async function saveArticle(
  contentRoot: string,
  relativePath: string,
  rawContent: string
): Promise<ArticleRecord> {
  const normalized = normalizeArticleForSave(relativePath, rawContent);
  const absolutePath = resolveContentPath(contentRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, normalized.rawContent, "utf8");
  return normalized;
}

export async function createArticle(
  contentRoot: string,
  relativeDirectory: string,
  fileName: string,
  templateContent: string
): Promise<ArticleRecord> {
  const safeFileName = fileName.endsWith(".md") ? fileName : `${fileName}.md`;
  const relativePath = toPosixPath(path.posix.join(relativeDirectory, safeFileName));
  const absolutePath = resolveContentPath(contentRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, templateContent, "utf8");
  return readArticle(contentRoot, relativePath);
}

export function resolveContentPath(contentRoot: string, relativePath: string): string {
  const absoluteRoot = path.resolve(contentRoot);
  const resolved = path.resolve(absoluteRoot, relativePath);

  // Separator-aware containment. A bare startsWith(absoluteRoot) is bypassable
  // by a sibling directory whose name extends the root's basename, e.g.
  // contentRoot=".../content" and relativePath="../content-evil/secret" resolves
  // to ".../content-evil/secret", which still startsWith ".../content". Require
  // either an exact match (the root itself) or that the resolved path continues
  // with a path separator right after the root prefix.
  if (resolved !== absoluteRoot && !resolved.startsWith(absoluteRoot + path.sep)) {
    throw new Error("Path escapes the content root.");
  }

  return resolved;
}
