import {
  extractMarkdownBlocks,
  getErrorMessage,
  highlightThemeCss,
  parseArticleSource
} from "@blog-system/content-core";
import katexCssRaw from "katex/dist/katex.min.css?raw";

import type { MarkdownBlockConfigPayload } from "../api";
import { hashText } from "../utils";
import type { WorkbenchDocument } from "./types";

export interface PreviewSourceParseResult {
  body: string;
  directory: string;
  frontmatterError: string | null;
  lineOffset: number;
}

export interface ParsedPreviewBlock {
  hash: string;
  source: string;
  startLine: number;
  endLine: number;
}

export interface RenderedPreviewBlock {
  id: string;
  hash: string;
  startLine: number;
  endLine: number;
  element: HTMLElement;
}

export const PREVIEW_SHADOW_BASE_CSS = `
html,
body {
  margin: 0;
  padding: 0;
}

body {
  color: var(--wb-foreground);
  font-family: "Georgia", serif;
  line-height: 1.8;
  background: transparent;
}

a {
  color: var(--wb-accent);
}

img {
  max-width: 100%;
  display: block;
  border-radius: 14px;
  border: 1px solid var(--wb-border);
}

pre {
  overflow: auto;
  padding: 16px;
  border-radius: 12px;
  background: #172028;
  border: 1px solid var(--wb-border);
  color: #d8e1eb;
}

code:not(pre code) {
  padding: 0.18em 0.38em;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  font-family: "Cascadia Code", "Fira Code", monospace;
  font-size: 0.92em;
}

pre code {
  font-family: "Cascadia Code", "Fira Code", monospace;
}

table {
  width: 100%;
  border-collapse: collapse;
}

th,
td {
  border: 1px solid var(--wb-border);
  padding: 8px 10px;
  text-align: left;
}

blockquote {
  margin: 0;
  padding-left: 16px;
  border-left: 3px solid var(--wb-accent);
  color: var(--wb-foreground-muted);
}

hr {
  border: none;
  border-top: 1px solid var(--wb-border);
}

.preview-prose {
  line-height: 1.8;
}

.preview-block {
  scroll-margin-block: 35vh;
}

.preview-prose h1,
.preview-prose h2,
.preview-prose h3 {
  font-family: "Georgia", serif;
}

${highlightThemeCss}
${katexCssRaw}
`;

export function parsePreviewBlocks(
  markdown: string,
  markdownBlockConfig: MarkdownBlockConfigPayload["value"] | null
): ParsedPreviewBlock[] {
  return extractMarkdownBlocks(markdown, markdownBlockConfig).map((block) => ({
    hash: `${hashText(block.source)}:${block.source.length}`,
    source: block.source,
    startLine: block.startLine,
    endLine: block.endLine
  }));
}

export function computeBodyLineOffset(rawContent: string) {
  const normalized = rawContent.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return 0;
  }

  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex === -1) {
    return 0;
  }

  const bodyStartIndex = closingIndex + 5;
  const linesBeforeBody = normalized.slice(0, bodyStartIndex).split("\n").length - 1;
  const rawBodyWithLeadingNewlines = normalized.slice(bodyStartIndex);
  const leadingNewlineCount = rawBodyWithLeadingNewlines.match(/^\n+/)?.[0].length ?? 0;

  return linesBeforeBody + leadingNewlineCount;
}

export function findPreviewBlockByLine(blocks: RenderedPreviewBlock[], lineNumber: number) {
  for (const block of blocks) {
    if (lineNumber >= block.startLine && lineNumber <= block.endLine) {
      return block;
    }
  }

  return blocks.find((block) => block.startLine > lineNumber) ?? blocks[blocks.length - 1] ?? null;
}

export function findPreviewAnchorElement(
  blockElement: HTMLElement,
  lineRatio: number,
  viewportHeight: number
) {
  const maxHeight = Math.max(viewportHeight / 10, 48);
  let currentElement = blockElement;
  let currentRatio = Math.min(1, Math.max(0, Number.isFinite(lineRatio) ? lineRatio : 0));

  while (currentElement.offsetHeight > maxHeight) {
    const childElements = Array.from(currentElement.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.offsetHeight > 0
    );

    if (childElements.length === 0) {
      break;
    }

    const totalHeight = childElements.reduce((sum, child) => sum + child.offsetHeight, 0);
    if (totalHeight <= 0) {
      break;
    }

    const targetHeight = totalHeight * currentRatio;
    let consumedHeight = 0;
    let nextElement = childElements[childElements.length - 1];

    for (const childElement of childElements) {
      const nextConsumedHeight = consumedHeight + childElement.offsetHeight;

      if (targetHeight <= nextConsumedHeight) {
        nextElement = childElement;
        currentRatio =
          childElement.offsetHeight > 0
            ? Math.min(1, Math.max(0, (targetHeight - consumedHeight) / childElement.offsetHeight))
            : 0;
        break;
      }

      consumedHeight = nextConsumedHeight;
    }

    if (nextElement === currentElement) {
      break;
    }

    currentElement = nextElement;
  }

  return currentElement;
}

export function parsePreviewSource(articlePath: string, rawContent: string): PreviewSourceParseResult {
  try {
    const parsed = parseArticleSource(articlePath, rawContent);
    return {
      body: parsed.body,
      directory: parsed.directory,
      frontmatterError: null,
      lineOffset: computeBodyLineOffset(rawContent)
    };
  } catch (error) {
    const normalizedPath = articlePath.replace(/\\/g, "/");
    const directory = normalizedPath.includes("/") ? normalizedPath.slice(0, normalizedPath.lastIndexOf("/")) : "";
    const normalizedRawContent = rawContent.replace(/\r\n/g, "\n");
    const closingIndex = normalizedRawContent.startsWith("---\n")
      ? normalizedRawContent.indexOf("\n---\n", 4)
      : -1;
    const body =
      closingIndex === -1
        ? normalizedRawContent
        : normalizedRawContent.slice(closingIndex + 5).replace(/^\n+/, "");

    return {
      body,
      directory,
      frontmatterError: getErrorMessage(error),
      lineOffset: computeBodyLineOffset(rawContent)
    };
  }
}

export function parsePlainPreviewSource(rawContent: string, directory: string): PreviewSourceParseResult {
  return {
    body: rawContent.replace(/\r\n/g, "\n"),
    directory,
    frontmatterError: null,
    lineOffset: 0
  };
}

export function parsePreviewSourceForDocument(
  document: WorkbenchDocument,
  rawContent: string
): PreviewSourceParseResult | null {
  if (document.kind === "article") {
    return parsePreviewSource(document.articlePath, rawContent);
  }

  if (document.kind === "projectTask") {
    return parsePlainPreviewSource(rawContent, `projects/${document.projectId}/tasks`);
  }

  if (document.kind === "projectLog") {
    return parsePlainPreviewSource(rawContent, `projects/${document.projectId}/logs`);
  }

  if (document.kind === "project") {
    return parsePlainPreviewSource(rawContent, `projects/${document.projectId}`);
  }

  return null;
}

export function buildPreviewRootCompatCss(rawCss: string) {
  return rawCss.replace(/(^|,)\s*:root\b/gm, "$1 :host, html");
}
