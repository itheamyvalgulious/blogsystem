import { promises as fs } from "node:fs";
import path from "node:path";

import {
  buildContentTree,
  buildFileSystemTree,
  collectTags,
  createArticle,
  readArticle,
  resolveContentPath,
  scanArticles
} from "@blog-system/content-core/node";
import {
  normalizeArticleForSave,
  normalizeOptionalText,
  normalizePassword,
  parseRawFrontmatter,
  normalizeStatus,
  normalizeTags,
  normalizeTop,
  parseArticleSource,
  serializeArticle,
  titleFromFileName,
  toPosixPath,
  toArticleSummary,
  type ArticleRecord
} from "@blog-system/content-core";
import { assertPathExists, assertTargetAvailable } from "./fs-utils.js";
import { ApiError } from "./errors.js";

const DIRECTORY_METADATA_FILE_NAME = ".blog-system-folder.json";

interface FileSystemMetadataPayload {
  date?: string;
  password?: string;
  slug?: string;
  status?: "draft" | "working" | "published";
  summary?: string;
  tags?: string[];
  title?: string;
  top?: number;
}

export interface DuplicateArticleTitleConflict {
  path: string;
  title: string;
}

export class DuplicateArticleTitleError extends Error {
  readonly code = "duplicate_article_title";
  readonly conflicts: DuplicateArticleTitleConflict[];

  constructor(title: string, conflicts: DuplicateArticleTitleConflict[]) {
    super(`Article title "${title}" already exists in this folder.`);
    this.conflicts = conflicts;
  }
}

function buildArticleTemplate(
  fileName: string,
  options?: {
    title?: string;
    tags?: string[];
    top?: number;
  }
) {
  const guessedTitle =
    options?.title?.trim() ||
    fileName
      .replace(/\.md$/i, "")
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  const tags = options?.tags ?? [];
  const top = Number.isFinite(options?.top) ? Math.trunc(options?.top ?? 0) : 0;

  return serializeArticle({
    frontmatter: {
      title: guessedTitle,
      tags,
      status: "draft",
      top
    },
    body: `# ${guessedTitle}\n`
  });
}

export async function getTreePayload(contentRoot: string, basePath = "") {
  const articles = await scanArticles(contentRoot);
  return {
    articles: articles.map((article) => toArticleSummary(article, basePath)),
    tree: buildContentTree(articles, basePath),
    fileTree: await buildFileSystemTree(contentRoot, articles, basePath),
    tags: collectTags(articles)
  };
}

async function applyPublishTransitionDate(
  contentRoot: string,
  nextRecord: ArticleRecord
): Promise<ArticleRecord> {
  try {
    const previous = await readArticle(contentRoot, nextRecord.path);

    if (previous.status === "draft" && (nextRecord.status === "published" || nextRecord.status === "working")) {
      const nextDate =
        typeof nextRecord.frontmatter.date === "string" && nextRecord.frontmatter.date.trim()
          ? nextRecord.frontmatter.date.trim()
          : new Date().toISOString();
      const frontmatter = {
        ...nextRecord.frontmatter,
        date: nextDate,
        status: "published" as const
      };

      return {
        ...nextRecord,
        frontmatter,
        date: frontmatter.date,
        slug: frontmatter.slug ?? nextRecord.slug,
        rawContent: serializeArticle({
          frontmatter,
          body: nextRecord.body
        })
      };
    }

    return nextRecord;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return nextRecord;
    }
    throw error;
  }
}

export async function saveArticleContent(
  contentRoot: string,
  relativePath: string,
  rawContent: string
): Promise<ArticleRecord> {
  const normalized = normalizeArticleForSave(relativePath, rawContent);
  const updatedRecord = await applyPublishTransitionDate(contentRoot, normalized);
  const absolutePath = resolveContentPath(contentRoot, relativePath);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  await fs.writeFile(absolutePath, updatedRecord.rawContent, "utf8");
  return readArticle(contentRoot, relativePath);
}

export async function updateArticleStatus(
  contentRoot: string,
  relativePath: string,
  status: "draft" | "working" | "published"
): Promise<ArticleRecord> {
  // Use parseArticleSource to avoid baking inherited directory metadata
  // into the article's own frontmatter on save.
  const normalizedPath = normalizeRelativeEntryPath(relativePath);
  const absolutePath = resolveContentPath(contentRoot, normalizedPath);
  const rawContent = await fs.readFile(absolutePath, "utf8");
  const parsed = parseArticleSource(normalizedPath, rawContent);
  const shouldSetDate =
    (status === "published" || status === "working") &&
    parsed.status === "draft" &&
    !parsed.frontmatter.date;
  const nextFrontmatter = {
    ...parsed.frontmatter,
    status,
    date: shouldSetDate ? new Date().toISOString() : parsed.frontmatter.date
  };
  const serialized = serializeArticle({
    frontmatter: nextFrontmatter,
    body: parsed.body
  });
  return saveArticleContent(contentRoot, relativePath, serialized);
}

export async function createArticleFile(
  contentRoot: string,
  relativeDirectory: string,
  fileName: string,
  options?: {
    title?: string;
    tags?: string[];
    top?: number;
  }
) {
  const template = buildArticleTemplate(fileName, options);
  return createArticle(contentRoot, relativeDirectory, fileName, template);
}

function normalizeRelativeEntryPath(relativePath = "") {
  const normalized = toPosixPath(relativePath).replace(/\/+$/g, "");

  if (normalized === "." || normalized === "") {
    return "";
  }

  // Defense in depth alongside resolveContentPath: no legitimate caller needs a
  // ".." segment, and rejecting them here stops crafted input (e.g.
  // "../sibling/secret") before it reaches path resolution — even if the
  // containment check in resolveContentPath is ever weakened later.
  if (normalized.split("/").includes("..")) {
    throw new ApiError(400, "Path must not escape the content root.");
  }

  return normalized;
}

function isNonEmptyMetadataValue(value: unknown) {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === "string") {
    return value.trim() !== "";
  }

  return true;
}

async function writeDirectoryMetadata(
  contentRoot: string,
  relativeDirectoryPath: string,
  metadata: Record<string, unknown>
) {
  const normalizedDirectoryPath = normalizeRelativeEntryPath(relativeDirectoryPath);
  const metadataPath = resolveContentPath(
    contentRoot,
    normalizedDirectoryPath
      ? path.posix.join(normalizedDirectoryPath, DIRECTORY_METADATA_FILE_NAME)
      : DIRECTORY_METADATA_FILE_NAME
  );
  // An empty metadata object is semantically equivalent to having no local
  // metadata file. Remove it so the folder no longer reports a metadata
  // indicator (hasMetadata is derived from file existence in the file tree).
  if (Object.keys(metadata).length === 0) {
    await fs.rm(metadataPath, { force: true });
    return;
  }
  await fs.writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function readLocalDirectoryMetadata(
  contentRoot: string,
  relativeDirectoryPath: string
): Promise<Record<string, unknown>> {
  const normalizedDirectoryPath = normalizeRelativeEntryPath(relativeDirectoryPath);
  const metadataPath = resolveContentPath(
    contentRoot,
    normalizedDirectoryPath
      ? path.posix.join(normalizedDirectoryPath, DIRECTORY_METADATA_FILE_NAME)
      : DIRECTORY_METADATA_FILE_NAME
  );

  try {
    const raw = await fs.readFile(metadataPath, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

export async function readFileSystemMetadata(contentRoot: string, relativePath: string) {
  const normalizedPath = normalizeRelativeEntryPath(relativePath);
  const absolutePath = resolveContentPath(contentRoot, normalizedPath);
  const stats = await fs.stat(absolutePath);

  if (stats.isDirectory()) {
    const localMetadata = await readLocalDirectoryMetadata(contentRoot, normalizedPath);
    return {
      type: "directory" as const,
      metadata: {
        ...localMetadata,
        tags: normalizeTags(localMetadata.tags)
      }
    };
  }

  if (normalizedPath.toLowerCase().endsWith(".md")) {
    const rawContent = await fs.readFile(absolutePath, "utf8");
    const article = parseArticleSource(normalizedPath, rawContent);
    return {
      type: "file" as const,
      metadata: {
        title: article.title,
        status: article.status,
        date: article.date,
        summary: article.summary,
        slug: article.frontmatter.slug,
        password: normalizePassword(article.frontmatter.password),
        tags: normalizeTags(article.frontmatter.tags),
        top: normalizeTop(article.frontmatter.top)
      }
    };
  }

  return {
    type: "file" as const,
    metadata: {}
  };
}

export async function saveFileSystemMetadata(
  contentRoot: string,
  relativePath: string,
  metadata: FileSystemMetadataPayload
) {
  const normalizedPath = normalizeRelativeEntryPath(relativePath);
  const absolutePath = resolveContentPath(contentRoot, normalizedPath);
  const stats = await fs.stat(absolutePath);

  if (stats.isDirectory()) {
    const dirMetadata: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (key === "tags") {
        // Accept both array and comma-separated string forms so callers that
        // surface tags as a text input (e.g. the rename dialog) can save without
        // a separate conversion step.
        const tags = normalizeTags(value);
        if (tags.length > 0) dirMetadata.tags = tags;
        continue;
      }

      if (key === "top") {
        if (value !== undefined && value !== null && value !== "") {
          dirMetadata.top = normalizeTop(value);
        }
        continue;
      }

      if (key === "status") {
        // Treat a blank status as "no override" so that clearing the metadata
        // dialog can fully empty the folder's metadata file. normalizeStatus
        // would otherwise coerce "" into the "draft" default.
        if (value !== undefined && value !== null && value !== "") {
          dirMetadata.status = normalizeStatus(value);
        }
        continue;
      }

      if (key === "password") {
        if (value !== undefined) {
          const password = normalizePassword(value);
          if (password !== undefined) {
            dirMetadata.password = password;
          }
        }
        continue;
      }

      if (key === "title" || key === "date" || key === "summary" || key === "slug") {
        if (value !== undefined) {
          const normalized = normalizeOptionalText(value);
          if (normalized !== undefined) {
            dirMetadata[key] = normalized;
          }
        }
        continue;
      }

      if (value !== undefined) {
        if (isNonEmptyMetadataValue(value)) {
          dirMetadata[key] = value;
        }
      }
    }
    // Only write to the folder's .blog-system-folder.json file.
    // Do NOT propagate to descendant files/folders.
    await writeDirectoryMetadata(contentRoot, normalizedPath, dirMetadata);

    return { type: "directory" as const };
  }

  if (!normalizedPath.toLowerCase().endsWith(".md")) {
    return { type: "file" as const };
  }

  // Use parseArticleSource (not readArticle) to get the article's own
  // frontmatter without inherited directory metadata, so that inherited
  // values are not baked into the file on save.
  const rawContent = await fs.readFile(absolutePath, "utf8");
  const parsed = parseArticleSource(normalizedPath, rawContent);
  const rawFrontmatter = parseRawFrontmatter(rawContent) as Record<string, unknown>;
  const nextFrontmatter = {
    ...rawFrontmatter,
    title:
      typeof metadata.title === "string" && metadata.title.trim()
        ? metadata.title.trim()
        : ((rawFrontmatter.title as string | undefined) ?? parsed.title),
    status:
      metadata.status !== undefined
        ? normalizeStatus(metadata.status)
        : typeof rawFrontmatter.status === "string" && rawFrontmatter.status.trim()
          ? normalizeStatus(rawFrontmatter.status)
          : parsed.status,
    date:
      metadata.date !== undefined
        ? normalizeOptionalText(metadata.date)
        : normalizeOptionalText(rawFrontmatter.date),
    summary:
      metadata.summary !== undefined
        ? normalizeOptionalText(metadata.summary)
        : normalizeOptionalText(rawFrontmatter.summary),
    slug:
      metadata.slug !== undefined
        ? normalizeOptionalText(metadata.slug)
        : normalizeOptionalText(rawFrontmatter.slug),
    password:
      metadata.password !== undefined
        ? normalizePassword(metadata.password)
        : normalizePassword(rawFrontmatter.password),
    tags:
      metadata.tags !== undefined
        ? normalizeTags(metadata.tags)
        : normalizeTags(rawFrontmatter.tags),
    top:
      metadata.top !== undefined
        ? normalizeTop(metadata.top)
        : rawFrontmatter.top !== undefined && rawFrontmatter.top !== null
          ? normalizeTop(rawFrontmatter.top)
          : normalizeTop(parsed.top)
  };

  const serialized = serializeArticle({
    frontmatter: nextFrontmatter,
    body: parsed.body
  });

  await fs.writeFile(absolutePath, serialized, "utf8");
  return { type: "file" as const };
}
function joinRelativePath(parentPath: string, name: string) {
  const normalizedName = name.trim().replace(/^\/+/, "");

  if (!normalizedName) {
    throw new ApiError(400, "Name is required.");
  }

  return normalizeRelativeEntryPath(path.posix.join(parentPath, normalizedName));
}

function normalizeComparableTitle(title: string) {
  return title.trim().toLowerCase();
}

async function findDuplicateArticleTitleConflicts(
  contentRoot: string,
  title: string,
  options?: { directory?: string; excludePath?: string }
) {
  const comparableTitle = normalizeComparableTitle(title);

  if (!comparableTitle) {
    return [];
  }

  const normalizedDirectory = options?.directory
    ? normalizeRelativeEntryPath(options.directory)
    : "";
  const normalizedExcludePath = options?.excludePath ? normalizeRelativeEntryPath(options.excludePath) : null;
  const articles = await scanArticles(contentRoot);

  return articles
    .filter(
      (article) =>
        normalizeComparableTitle(article.title) === comparableTitle &&
        article.directory === normalizedDirectory &&
        article.path !== normalizedExcludePath
    )
    .map((article) => ({
      path: article.path,
      title: article.title
    }));
}

async function assertNoDuplicateArticleTitle(
  contentRoot: string,
  title: string,
  options?: {
    allowDuplicateTitle?: boolean;
    directory?: string;
    excludePath?: string;
  }
) {
  if (options?.allowDuplicateTitle) {
    return;
  }

  const conflicts = await findDuplicateArticleTitleConflicts(contentRoot, title, {
    directory: options?.directory,
    excludePath: options?.excludePath
  });

  if (conflicts.length > 0) {
    throw new DuplicateArticleTitleError(title, conflicts);
  }
}

function resolveArticleTitleForCreate(name: string, metadata?: Record<string, unknown>) {
  if (typeof metadata?.title === "string" && metadata.title.trim()) {
    return metadata.title.trim();
  }

  return titleFromFileName(name);
}

async function isDirectory(absolutePath: string) {
  const stats = await fs.stat(absolutePath);
  return stats.isDirectory();
}

export async function createFileSystemEntry(
  contentRoot: string,
  parentPath: string,
  entryType: "file" | "directory",
  name: string,
  metadata?: Record<string, unknown>,
  options?: {
    allowDuplicateTitle?: boolean;
  }
) {
  const normalizedParentPath = normalizeRelativeEntryPath(parentPath);
  const relativePath = joinRelativePath(normalizedParentPath, name);
  const absolutePath = resolveContentPath(contentRoot, relativePath);
  const absoluteParentPath = resolveContentPath(contentRoot, normalizedParentPath);

  await assertPathExists(absoluteParentPath);
  if (!(await isDirectory(absoluteParentPath))) {
    throw new ApiError(400, "Parent path must be a directory.");
  }

  await assertTargetAvailable(absolutePath);

  if (entryType === "directory") {
    await fs.mkdir(absolutePath, { recursive: false });
    const directoryTags = normalizeTags(metadata?.tags);

    if (directoryTags.length > 0) {
      await writeDirectoryMetadata(contentRoot, relativePath, { tags: directoryTags });
    }

    return { path: relativePath };
  }

  if (relativePath.toLowerCase().endsWith(".md")) {
    await assertNoDuplicateArticleTitle(
      contentRoot,
      resolveArticleTitleForCreate(name, metadata),
      {
        allowDuplicateTitle: options?.allowDuplicateTitle,
        directory: normalizedParentPath
      }
    );
  }

  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  // Don't bake inherited folder metadata into new article files.
  // Inheritance happens at read time via loadDirectoryMetadata.
  const initialContent = relativePath.toLowerCase().endsWith(".md")
    ? buildArticleTemplate(name, {
        title: typeof metadata?.title === "string" ? metadata.title : undefined,
        tags: normalizeTags(metadata?.tags),
        top: normalizeTop(metadata?.top)
      })
    : "";
  await fs.writeFile(absolutePath, initialContent, "utf8");
  return { path: relativePath };
}

export async function renameFileSystemEntry(
  contentRoot: string,
  relativePath: string,
  nextName: string,
  options?: {
    allowDuplicateTitle?: boolean;
    title?: string;
  }
) {
  const normalizedSourcePath = normalizeRelativeEntryPath(relativePath);
  const sourceAbsolutePath = resolveContentPath(contentRoot, normalizedSourcePath);
  await assertPathExists(sourceAbsolutePath);

  const parentPath = path.posix.dirname(normalizedSourcePath);
  const normalizedParentPath = parentPath === "." ? "" : parentPath;
  const nextRelativePath = joinRelativePath(normalizedParentPath, nextName);
  const nextAbsolutePath = resolveContentPath(contentRoot, nextRelativePath);

  if (normalizedSourcePath.toLowerCase().endsWith(".md")) {
    const currentArticle = await readArticle(contentRoot, normalizedSourcePath);
    const nextTitle =
      typeof options?.title === "string" && options.title.trim()
        ? options.title.trim()
        : currentArticle.title;

    await assertNoDuplicateArticleTitle(contentRoot, nextTitle, {
      allowDuplicateTitle: options?.allowDuplicateTitle,
      directory: normalizedParentPath,
      excludePath: normalizedSourcePath
    });
  }

  if (normalizedSourcePath === nextRelativePath) {
    return { path: normalizedSourcePath };
  }

  await assertTargetAvailable(nextAbsolutePath);
  await fs.rename(sourceAbsolutePath, nextAbsolutePath);
  return { path: nextRelativePath };
}

export async function deleteFileSystemEntry(contentRoot: string, relativePath: string) {
  const normalizedPath = normalizeRelativeEntryPath(relativePath);

  if (!normalizedPath) {
    throw new ApiError(400, "The content root cannot be deleted.");
  }

  const absolutePath = resolveContentPath(contentRoot, normalizedPath);
  await assertPathExists(absolutePath);
  await fs.rm(absolutePath, { recursive: true, force: false });
}

export async function transferFileSystemEntry(
  contentRoot: string,
  sourcePath: string,
  targetDirectoryPath: string,
  mode: "copy" | "move"
) {
  const normalizedSourcePath = normalizeRelativeEntryPath(sourcePath);
  const normalizedTargetDirectory = normalizeRelativeEntryPath(targetDirectoryPath);
  const sourceAbsolutePath = resolveContentPath(contentRoot, normalizedSourcePath);
  const targetDirectoryAbsolutePath = resolveContentPath(contentRoot, normalizedTargetDirectory);

  await assertPathExists(sourceAbsolutePath);
  await assertPathExists(targetDirectoryAbsolutePath);

  if (!(await isDirectory(targetDirectoryAbsolutePath))) {
    throw new ApiError(400, "Paste target must be a directory.");
  }

  const targetRelativePath = joinRelativePath(
    normalizedTargetDirectory,
    path.posix.basename(normalizedSourcePath)
  );

  if (targetRelativePath === normalizedSourcePath) {
    throw new ApiError(400, `Cannot ${mode} an entry onto itself.`);
  }

  if (
    mode === "move" &&
    targetRelativePath.startsWith(`${normalizedSourcePath}/`)
  ) {
    throw new ApiError(400, "Cannot move a directory into one of its descendants.");
  }

  const targetAbsolutePath = resolveContentPath(contentRoot, targetRelativePath);
  await assertTargetAvailable(targetAbsolutePath);

  if (mode === "copy") {
    await fs.cp(sourceAbsolutePath, targetAbsolutePath, {
      errorOnExist: true,
      force: false,
      recursive: true
    });
  } else {
    await fs.rename(sourceAbsolutePath, targetAbsolutePath);
  }

  return { path: targetRelativePath };
}

export async function ensureContentRoot(contentRoot: string) {
  await fs.mkdir(contentRoot, { recursive: true });
}
