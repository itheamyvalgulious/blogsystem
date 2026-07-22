import { promises as fs } from "node:fs";
import path from "node:path";

import { getErrorMessage, parseArticleSource } from "@blog-system/content-core";
import { hashText, resolveContentPath } from "@blog-system/content-core/node";

export type MarkdownSearchScope = "body" | "wholeFile";

export interface MarkdownSearchRequest {
  flags?: string;
  pattern: string;
  replace: string;
  scope: MarkdownSearchScope;
}

export interface MarkdownSearchMatch {
  column: number;
  endOffset: number;
  excerpt: string;
  key: string;
  lineNumber: number;
  matchIndex: number;
  matchedText: string;
  path: string;
  replacementPreview: string;
  startOffset: number;
}

export interface MarkdownSearchFileResult {
  matchCount: number;
  matches: MarkdownSearchMatch[];
  path: string;
}

export interface MarkdownSearchSkippedFile {
  path: string;
  reason: string;
}

export interface MarkdownSearchSummary {
  filesMatched: number;
  filesScanned: number;
  matchesFound: number;
  skippedCount: number;
}

export interface MarkdownSearchApplied {
  changedPaths: string[];
  nextSelectionKey: string | null;
  replacementsMade: number;
}

export interface MarkdownSearchResponse {
  applied?: MarkdownSearchApplied;
  results: MarkdownSearchFileResult[];
  skipped: MarkdownSearchSkippedFile[];
  summary: MarkdownSearchSummary;
}

export class MarkdownSearchError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

interface BodySearchSource {
  rawContent: string;
  scope: MarkdownSearchScope;
  searchSource: string;
  sourceEndOffset: number;
  sourceStartOffset: number;
}

interface InternalFileResult extends BodySearchSource {
  matches: MarkdownSearchMatch[];
  path: string;
}

interface InternalSearchResult {
  files: InternalFileResult[];
  flatMatches: MarkdownSearchMatch[];
  response: MarkdownSearchResponse;
}

interface SearchContext {
  contentRoot: string;
  input: Required<MarkdownSearchRequest> & { normalizedFlags: string };
  regex: RegExp;
}

const ALLOWED_FLAGS = new Set(["i", "m", "s", "u"]);

function normalizeLineEndings(value: string) {
  return value.replace(/\r\n/g, "\n");
}

function buildMatchKey(match: Pick<MarkdownSearchMatch, "endOffset" | "matchIndex" | "matchedText" | "path" | "startOffset">) {
  return [
    encodeURIComponent(match.path),
    match.startOffset,
    match.endOffset,
    match.matchIndex,
    hashText(match.matchedText)
  ].join(":");
}

function normalizeRequest(input: MarkdownSearchRequest) {
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    throw new MarkdownSearchError(400, "invalid_search_pattern", "pattern is required.");
  }

  if (typeof input.replace !== "string") {
    throw new MarkdownSearchError(400, "invalid_search_replace", "replace must be a string.");
  }

  if (input.scope !== "body" && input.scope !== "wholeFile") {
    throw new MarkdownSearchError(400, "invalid_search_scope", "scope must be either body or wholeFile.");
  }

  const rawFlags = typeof input.flags === "string" ? input.flags : "";
  const seenFlags = new Set<string>();
  for (const flag of rawFlags) {
    if (!ALLOWED_FLAGS.has(flag)) {
      throw new MarkdownSearchError(
        400,
        "invalid_search_flags",
        "flags may only include i, m, s, and u."
      );
    }

    if (seenFlags.has(flag)) {
      throw new MarkdownSearchError(400, "invalid_search_flags", `duplicate regex flag "${flag}" is not allowed.`);
    }

    seenFlags.add(flag);
  }

  const normalizedFlags = ["g", "i", "m", "s", "u"].filter(
    (flag) => flag === "g" || seenFlags.has(flag)
  ).join("");

  return {
    flags: rawFlags,
    normalizedFlags,
    pattern: input.pattern,
    replace: input.replace,
    scope: input.scope
  };
}

function createSearchContext(contentRoot: string, input: MarkdownSearchRequest): SearchContext {
  const normalized = normalizeRequest(input);

  try {
    return {
      contentRoot,
      input: normalized,
      regex: new RegExp(normalized.pattern, normalized.normalizedFlags)
    };
  } catch (error) {
    throw new MarkdownSearchError(400, "invalid_search_pattern", getErrorMessage(error));
  }
}

async function walkMarkdownFiles(rootDir: string, currentDir = ""): Promise<string[]> {
  const absoluteDir = path.join(rootDir, currentDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const relativePath = currentDir ? path.posix.join(currentDir, entry.name) : entry.name;

    if (entry.isDirectory()) {
      files.push(...(await walkMarkdownFiles(rootDir, relativePath)));
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(relativePath.replace(/\\/g, "/"));
    }
  }

  return files;
}

function advanceStringIndex(value: string, index: number, unicode: boolean) {
  if (!unicode || index + 1 >= value.length) {
    return index + 1;
  }

  const first = value.charCodeAt(index);
  if (first < 0xd800 || first > 0xdbff) {
    return index + 1;
  }

  const second = value.charCodeAt(index + 1);
  if (second < 0xdc00 || second > 0xdfff) {
    return index + 1;
  }

  return index + 2;
}

function buildLineStartOffsets(value: string) {
  const offsets = [0];

  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === "\n") {
      offsets.push(index + 1);
    }
  }

  return offsets;
}

function findLineIndex(lineStartOffsets: number[], offset: number) {
  let low = 0;
  let high = lineStartOffsets.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const current = lineStartOffsets[mid];
    const next = mid + 1 < lineStartOffsets.length ? lineStartOffsets[mid + 1] : Number.POSITIVE_INFINITY;

    if (offset < current) {
      high = mid - 1;
      continue;
    }

    if (offset >= next) {
      low = mid + 1;
      continue;
    }

    return mid;
  }

  return Math.max(0, lineStartOffsets.length - 1);
}

function getLineAndColumn(lineStartOffsets: number[], offset: number) {
  const lineIndex = findLineIndex(lineStartOffsets, offset);
  return {
    column: offset - lineStartOffsets[lineIndex] + 1,
    lineNumber: lineIndex + 1
  };
}

function buildExcerpt(value: string, startOffset: number, endOffset: number) {
  const lineStart = value.lastIndexOf("\n", Math.max(0, startOffset - 1)) + 1;
  const nextLineBreak = value.indexOf("\n", endOffset);
  const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
  const rawLine = value.slice(lineStart, lineEnd).trim();

  if (rawLine.length <= 220) {
    return rawLine;
  }

  const relativeMatchStart = Math.max(0, startOffset - lineStart);
  const sliceStart = Math.max(0, relativeMatchStart - 70);
  const sliceEnd = Math.min(rawLine.length, relativeMatchStart + 150);
  const prefix = sliceStart > 0 ? "..." : "";
  const suffix = sliceEnd < rawLine.length ? "..." : "";

  return `${prefix}${rawLine.slice(sliceStart, sliceEnd).trim()}${suffix}`;
}

function expandReplacement(
  template: string,
  match: RegExpExecArray,
  source: string,
  sourceIndex: number
) {
  let result = "";

  for (let index = 0; index < template.length; index += 1) {
    const character = template[index];
    if (character !== "$" || index === template.length - 1) {
      result += character;
      continue;
    }

    const next = template[index + 1];

    if (next === "$") {
      result += "$";
      index += 1;
      continue;
    }

    if (next === "&") {
      result += match[0];
      index += 1;
      continue;
    }

    if (next === "`") {
      result += source.slice(0, sourceIndex);
      index += 1;
      continue;
    }

    if (next === "'") {
      result += source.slice(sourceIndex + match[0].length);
      index += 1;
      continue;
    }

    if (next === "<") {
      const closingIndex = template.indexOf(">", index + 2);
      if (closingIndex !== -1) {
        const groupName = template.slice(index + 2, closingIndex);
        const groups = match.groups ?? {};

        if (Object.prototype.hasOwnProperty.call(groups, groupName)) {
          result += groups[groupName] ?? "";
          index = closingIndex;
          continue;
        }
      }
    }

    if (/\d/.test(next)) {
      if (next === "0") {
        result += "$0";
        index += 1;
        continue;
      }

      const firstDigit = Number(next);
      const secondDigit = /\d/.test(template[index + 2] ?? "") ? Number(template[index + 2]) : null;
      const twoDigitGroup =
        secondDigit === null ? null : Number(`${firstDigit}${secondDigit}`);
      const captureCount = match.length - 1;

      if (twoDigitGroup !== null && twoDigitGroup <= captureCount) {
        result += match[twoDigitGroup] ?? "";
        index += 2;
        continue;
      }

      if (firstDigit <= captureCount) {
        result += match[firstDigit] ?? "";
        index += 1;
        continue;
      }
    }

    result += "$";
  }

  return result;
}

function resolveBodySearchSource(relativePath: string, rawContent: string): BodySearchSource {
  const normalizedRawContent = normalizeLineEndings(rawContent);

  try {
    parseArticleSource(relativePath, normalizedRawContent);
  } catch (error) {
    throw new MarkdownSearchError(409, "invalid_markdown_frontmatter", getErrorMessage(error));
  }

  if (!normalizedRawContent.startsWith("---\n")) {
    return {
      rawContent: normalizedRawContent,
      scope: "body",
      searchSource: normalizedRawContent,
      sourceEndOffset: normalizedRawContent.length,
      sourceStartOffset: 0
    };
  }

  const closingIndex = normalizedRawContent.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    return {
      rawContent: normalizedRawContent,
      scope: "body",
      searchSource: normalizedRawContent,
      sourceEndOffset: normalizedRawContent.length,
      sourceStartOffset: 0
    };
  }

  const bodyStartOffset = closingIndex + 5;
  const leadingNewlines = normalizedRawContent.slice(bodyStartOffset).match(/^\n+/)?.[0].length ?? 0;
  const sourceStartOffset = bodyStartOffset + leadingNewlines;

  return {
    rawContent: normalizedRawContent,
    scope: "body",
    searchSource: normalizedRawContent.slice(sourceStartOffset),
    sourceEndOffset: normalizedRawContent.length,
    sourceStartOffset
  };
}

function resolveSearchSource(
  relativePath: string,
  rawContent: string,
  scope: MarkdownSearchScope
): BodySearchSource {
  if (scope === "body") {
    return resolveBodySearchSource(relativePath, rawContent);
  }

  const normalizedRawContent = normalizeLineEndings(rawContent);
  return {
    rawContent: normalizedRawContent,
    scope,
    searchSource: normalizedRawContent,
    sourceEndOffset: normalizedRawContent.length,
    sourceStartOffset: 0
  };
}

function collectMatches(
  relativePath: string,
  source: BodySearchSource,
  regex: RegExp,
  replacementTemplate: string
) {
  const searchRegex = new RegExp(regex.source, regex.flags);
  const lineStartOffsets = buildLineStartOffsets(source.rawContent);
  const matches: MarkdownSearchMatch[] = [];
  let currentMatch: RegExpExecArray | null;
  let matchIndex = 0;

  while ((currentMatch = searchRegex.exec(source.searchSource)) !== null) {
    const matchedText = currentMatch[0];
    const relativeStartOffset = currentMatch.index;
    const startOffset = source.sourceStartOffset + relativeStartOffset;
    const endOffset = startOffset + matchedText.length;
    const replacementPreview = expandReplacement(
      replacementTemplate,
      currentMatch,
      source.searchSource,
      relativeStartOffset
    );
    const lineAndColumn = getLineAndColumn(lineStartOffsets, startOffset);
    const match: MarkdownSearchMatch = {
      column: lineAndColumn.column,
      endOffset,
      excerpt: buildExcerpt(source.rawContent, startOffset, endOffset),
      key: "",
      lineNumber: lineAndColumn.lineNumber,
      matchIndex,
      matchedText,
      path: relativePath,
      replacementPreview,
      startOffset
    };
    match.key = buildMatchKey(match);
    matches.push(match);
    matchIndex += 1;

    if (matchedText.length === 0) {
      searchRegex.lastIndex = advanceStringIndex(
        source.searchSource,
        searchRegex.lastIndex,
        searchRegex.unicode
      );
    }
  }

  return matches;
}

async function buildSearchResult(context: SearchContext): Promise<InternalSearchResult> {
  const paths = await walkMarkdownFiles(context.contentRoot);
  const results: MarkdownSearchFileResult[] = [];
  const skipped: MarkdownSearchSkippedFile[] = [];
  const flatMatches: MarkdownSearchMatch[] = [];
  const files: InternalFileResult[] = [];

  for (const relativePath of paths) {
    const absolutePath = resolveContentPath(context.contentRoot, relativePath);
    const rawContent = await fs.readFile(absolutePath, "utf8");

    let source: BodySearchSource;
    try {
      source = resolveSearchSource(relativePath, rawContent, context.input.scope);
    } catch (error) {
      if (error instanceof MarkdownSearchError && context.input.scope === "body") {
        skipped.push({
          path: relativePath,
          reason: error.message
        });
        continue;
      }

      throw error;
    }

    const matches = collectMatches(relativePath, source, context.regex, context.input.replace);
    const file: InternalFileResult = {
      ...source,
      matches,
      path: relativePath
    };
    files.push(file);

    if (matches.length === 0) {
      continue;
    }

    flatMatches.push(...matches);
    results.push({
      matchCount: matches.length,
      matches,
      path: relativePath
    });
  }

  return {
    files,
    flatMatches,
    response: {
      results,
      skipped,
      summary: {
        filesMatched: results.length,
        filesScanned: paths.length,
        matchesFound: flatMatches.length,
        skippedCount: skipped.length
      }
    }
  };
}

function replaceSourceRange(
  source: BodySearchSource,
  startOffset: number,
  endOffset: number,
  replacementText: string
) {
  const relativeStartOffset = startOffset - source.sourceStartOffset;
  const relativeEndOffset = endOffset - source.sourceStartOffset;
  const nextSearchSource =
    source.searchSource.slice(0, relativeStartOffset) +
    replacementText +
    source.searchSource.slice(relativeEndOffset);

  return (
    source.rawContent.slice(0, source.sourceStartOffset) +
    nextSearchSource +
    source.rawContent.slice(source.sourceEndOffset)
  );
}

function replaceAllSearchSource(
  source: BodySearchSource,
  regex: RegExp,
  replacementTemplate: string
) {
  const nextSearchSource = source.searchSource.replace(regex, replacementTemplate);

  return (
    source.rawContent.slice(0, source.sourceStartOffset) +
    nextSearchSource +
    source.rawContent.slice(source.sourceEndOffset)
  );
}

function validateNextRawContent(relativePath: string, rawContent: string) {
  parseArticleSource(relativePath, rawContent);
}

export async function previewMarkdownSearch(
  contentRoot: string,
  input: MarkdownSearchRequest
): Promise<MarkdownSearchResponse> {
  const context = createSearchContext(contentRoot, input);
  const result = await buildSearchResult(context);
  return result.response;
}

export async function replaceNextMarkdownSearch(
  contentRoot: string,
  input: MarkdownSearchRequest,
  matchKey: string
): Promise<MarkdownSearchResponse> {
  if (typeof matchKey !== "string" || matchKey.length === 0) {
    throw new MarkdownSearchError(400, "invalid_search_match", "matchKey is required.");
  }

  const context = createSearchContext(contentRoot, input);
  const current = await buildSearchResult(context);
  const selectedIndex = current.flatMatches.findIndex((match) => match.key === matchKey);

  if (selectedIndex === -1) {
    throw new MarkdownSearchError(409, "search_match_stale", "The selected match is no longer current.");
  }

  const selectedMatch = current.flatMatches[selectedIndex];
  const selectedFile = current.files.find((file) => file.path === selectedMatch.path);

  if (!selectedFile) {
    throw new MarkdownSearchError(409, "search_match_stale", "The selected match file is no longer current.");
  }

  const nextRawContent = replaceSourceRange(
    selectedFile,
    selectedMatch.startOffset,
    selectedMatch.endOffset,
    selectedMatch.replacementPreview
  );

  try {
    validateNextRawContent(selectedFile.path, nextRawContent);
  } catch (error) {
    throw new MarkdownSearchError(
      409,
      "search_replace_validation_failed",
      `Replacing the selected match would make ${selectedFile.path} invalid: ${getErrorMessage(error)}`
    );
  }

  const absolutePath = resolveContentPath(contentRoot, selectedFile.path);
  await fs.writeFile(absolutePath, nextRawContent, "utf8");

  const updated = await buildSearchResult(context);
  const nextSelection = updated.flatMatches[Math.min(selectedIndex, Math.max(0, updated.flatMatches.length - 1))] ?? null;

  return {
    ...updated.response,
    applied: {
      changedPaths: [selectedFile.path],
      nextSelectionKey: nextSelection?.key ?? null,
      replacementsMade: 1
    }
  };
}

export async function replaceAllMarkdownSearch(
  contentRoot: string,
  input: MarkdownSearchRequest
): Promise<MarkdownSearchResponse> {
  const context = createSearchContext(contentRoot, input);
  const current = await buildSearchResult(context);
  const changedPaths: string[] = [];
  const skipped = [...current.response.skipped];
  let replacementsMade = 0;

  for (const file of current.files) {
    if (file.matches.length === 0) {
      continue;
    }

    const nextRawContent = replaceAllSearchSource(file, context.regex, context.input.replace);

    try {
      validateNextRawContent(file.path, nextRawContent);
    } catch (error) {
      skipped.push({
        path: file.path,
        reason: `Replacement skipped: ${getErrorMessage(error)}`
      });
      continue;
    }

    replacementsMade += file.matches.length;

    if (nextRawContent === file.rawContent) {
      continue;
    }

    const absolutePath = resolveContentPath(contentRoot, file.path);
    await fs.writeFile(absolutePath, nextRawContent, "utf8");
    changedPaths.push(file.path);
  }

  const updated = await buildSearchResult(context);

  return {
    ...updated.response,
    skipped: [...updated.response.skipped, ...skipped.filter((entry) => !updated.response.skipped.some((next) => next.path === entry.path && next.reason === entry.reason))],
    summary: {
      ...updated.response.summary,
      skippedCount:
        updated.response.skipped.length +
        skipped.filter((entry) => !updated.response.skipped.some((next) => next.path === entry.path && next.reason === entry.reason)).length
    },
    applied: {
      changedPaths,
      nextSelectionKey: updated.flatMatches[0]?.key ?? null,
      replacementsMade
    }
  };
}
