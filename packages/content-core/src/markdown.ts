import GithubSlugger from "github-slugger";
import { toString } from "mdast-util-to-string";
import rehypeHighlight from "rehype-highlight";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSlug from "rehype-slug";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { visit } from "unist-util-visit";

import type { MarkdownBlockConfig, MarkdownBlockRule } from "./markdown-block-config.js";
import { applyMarkdownBlockRules } from "./markdown-block-config.js";
import type {
  ArticleRenderResult,
  HeadingItem,
  MarkdownBlock,
  MarkdownFenceRendererDefinition,
  MarkdownRenderError
} from "./types.js";
import { escapeHtmlAttribute } from "./utils.js";

interface HtmlTagBoundary {
  kind: "opening" | "closing";
  tagName: string;
}

function hasUnclosedMathDelimiter(markdown: string) {
  let inCodeFence: { character: "`" | "~"; length: number } | null = null;
  let inlineCodeTicks = 0;
  let inInlineMath = false;
  let inBlockMath = false;
  const lines = markdown.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trimStart();
    const fenceMatch = /^([`~]{3,})/.exec(trimmed);

    if (inlineCodeTicks === 0 && fenceMatch) {
      const fence = fenceMatch[1];
      const character = fence[0] as "`" | "~";
      const length = fence.length;

      if (inCodeFence && inCodeFence.character === character && length >= inCodeFence.length) {
        inCodeFence = null;
      } else if (!inCodeFence) {
        inCodeFence = { character, length };
      }

      continue;
    }

    if (inCodeFence) {
      continue;
    }

    for (let index = 0; index < line.length; index += 1) {
      const character = line[index];

      if (character === "\\") {
        index += 1;
        continue;
      }

      if (character === "`") {
        let tickCount = 1;
        while (line[index + tickCount] === "`") {
          tickCount += 1;
        }

        if (inlineCodeTicks === 0) {
          inlineCodeTicks = tickCount;
        } else if (tickCount === inlineCodeTicks) {
          inlineCodeTicks = 0;
        }

        index += tickCount - 1;
        continue;
      }

      if (inlineCodeTicks > 0 || character !== "$") {
        continue;
      }

      const isDoubleDollar = line[index + 1] === "$";
      if (isDoubleDollar) {
        if (!inInlineMath) {
          inBlockMath = !inBlockMath;
          index += 1;
        }
        continue;
      }

      if (!inBlockMath) {
        inInlineMath = !inInlineMath;
      }
    }

    inlineCodeTicks = 0;
  }

  return inInlineMath || inBlockMath;
}

function createRemarkParser(markdown: string) {
  const processor = unified().use(remarkParse).use(remarkGfm);

  // While the user is still typing an unfinished math delimiter, skip
  // remark-math so preview rendering stays responsive.
  if (!hasUnclosedMathDelimiter(markdown)) {
    processor.use(remarkMath);
  }

  return processor;
}

function remarkMathPlaceholders() {
  return (tree: any) => {
    visit(tree, ["inlineMath", "math"], (node: any, index?: number, parent?: any) => {
      if (!parent || index === undefined) {
        return;
      }

      const tex = typeof node.value === "string" ? node.value : "";
      const escapedTex = escapeHtmlAttribute(tex);
      parent.children[index] = {
        type: "html",
        value:
          node.type === "inlineMath"
            ? `<span class="math-placeholder inline" data-tex="${escapedTex}"></span>`
            : `<div class="math-placeholder block" data-tex="${escapedTex}"></div>`
      };
    });
  };
}

function isExternalResource(url: string): boolean {
  return /^(?:@media\/|[a-z]+:|#|\/)/i.test(url);
}

function normalizeBasePath(basePath: string) {
  return basePath.replace(/\/+$/g, "");
}

function classifyHtmlTagBoundary(value: unknown): HtmlTagBoundary | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed.startsWith("<") || trimmed.startsWith("<!--") || trimmed.startsWith("<!") || trimmed.startsWith("<?")) {
    return null;
  }

  const closingMatch = /^<\/([A-Za-z][A-Za-z0-9:-]*)\s*>$/.exec(trimmed);
  if (closingMatch) {
    return {
      kind: "closing",
      tagName: closingMatch[1].toLowerCase()
    };
  }

  if (trimmed.startsWith("</")) {
    return null;
  }

  const tagNameMatch = /^<([A-Za-z][A-Za-z0-9:-]*)/.exec(trimmed);
  if (!tagNameMatch) {
    return null;
  }

  const tagName = tagNameMatch[1].toLowerCase();
  let quote: "\"" | "'" | null = null;

  for (let index = tagNameMatch[0].length; index < trimmed.length; index += 1) {
    const character = trimmed[index];

    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }

    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }

    if (character === "<") {
      return null;
    }

    if (character === ">") {
      const beforeClose = trimmed.slice(0, index).trimEnd();
      const afterClose = trimmed.slice(index + 1).trim();

      if (afterClose.length > 0 || beforeClose.endsWith("/")) {
        return null;
      }

      return {
        kind: "opening",
        tagName
      };
    }
  }

  return null;
}

function createMarkdownBlock(
  markdown: string,
  startOffsetValue: unknown,
  endOffsetValue: unknown,
  startLineValue: unknown,
  endLineValue: unknown
): MarkdownBlock | null {
  if (!Number.isFinite(startOffsetValue) || !Number.isFinite(endOffsetValue)) {
    return null;
  }

  const startOffset = Math.max(0, Number(startOffsetValue));
  const endOffset = Math.max(startOffset, Number(endOffsetValue));
  if (endOffset <= startOffset) {
    return null;
  }

  const source = markdown.slice(startOffset, endOffset);
  if (!source.trim()) {
    return null;
  }

  return {
    startLine: Number.isFinite(startLineValue) ? Number(startLineValue) : 1,
    endLine: Number.isFinite(endLineValue) ? Number(endLineValue) : Number.isFinite(startLineValue) ? Number(startLineValue) : 1,
    startOffset,
    endOffset,
    source
  };
}

export function extractHeadings(markdown: string): HeadingItem[] {
  const tree = createRemarkParser(markdown).parse(markdown);
  const slugger = new GithubSlugger();
  const headings: HeadingItem[] = [];

  visit(tree, "heading", (node: any) => {
    const text = toString(node).trim();

    if (!text) {
      return;
    }

    headings.push({
      depth: node.depth,
      text,
      id: slugger.slug(text),
      lineNumber: Number(node.position?.start?.line ?? 1)
    });
  });

  return headings;
}

async function renderMarkdownInternal(
  markdown: string,
  options: {
    fenceRenderers?: MarkdownFenceRendererDefinition[];
    hydrateMathOnServer: boolean;
    includeHeadings?: boolean;
    markdownBlockConfig?: MarkdownBlockConfig | MarkdownBlockRule[] | null;
  }
): Promise<ArticleRenderResult> {
  const preparedMarkdown = applyMarkdownBlockRules(markdown, options.markdownBlockConfig);
  const headings = options.includeHeadings === false ? [] : extractHeadings(preparedMarkdown);
  const errors: MarkdownRenderError[] = [];
  const renderedCss = new Set<string>();

  const fenceRendererMap = new Map(
    (options.fenceRenderers ?? []).map((renderer) => [renderer.language, renderer] as const)
  );
  const remarkProcessor = createRemarkParser(preparedMarkdown);
  const processorWithRemarkPlugins = remarkProcessor
    .use(() => (tree: any) => {
      visit(tree, "code", (node: any, index?: number, parent?: any) => {
        if (!parent || index === undefined) {
          return;
        }

        const language = typeof node.lang === "string" ? node.lang.trim() : "";
        if (!language) {
          return;
        }

        const renderer = fenceRendererMap.get(language);
        if (!renderer) {
          return;
        }

        try {
          const output = renderer.render({
            content: typeof node.value === "string" ? node.value : "",
            language,
            meta: typeof node.meta === "string" ? node.meta : undefined,
            position: {
              endLine: Number(node.position?.end?.line ?? NaN),
              startLine: Number(node.position?.start?.line ?? NaN)
            }
          });

          if (output.cssText?.trim()) {
            renderedCss.add(output.cssText.trim());
          }

          parent.children[index] = {
            type: "html",
            value: output.html
          };
        } catch (error) {
          const normalizedError = error as Error & { code?: string };
          errors.push({
            code: normalizedError.code ?? "fence-render-error",
            endLine: Number.isFinite(node.position?.end?.line) ? Number(node.position.end.line) : undefined,
            fenceLanguage: language,
            message: normalizedError.message,
            rendererName: renderer.name,
            startLine: Number.isFinite(node.position?.start?.line) ? Number(node.position.start.line) : undefined
          });
        }
      });
    })
    .use(options.hydrateMathOnServer ? () => undefined : remarkMathPlaceholders)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSlug);

  if (options.hydrateMathOnServer && !hasUnclosedMathDelimiter(preparedMarkdown)) {
    processorWithRemarkPlugins.use(rehypeKatex, { strict: "ignore" });
  }

  const processed = await processorWithRemarkPlugins
    .use(rehypeHighlight)
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(preparedMarkdown);

  return {
    errors,
    html: `${renderedCss.size > 0 ? `<style data-markdown-fence-renderers>${[...renderedCss].join("\n")}</style>` : ""}${String(processed)}`,
    headings
  };
}

export async function renderMarkdownWithMathPlaceholders(
  markdown: string,
  markdownBlockConfig?: MarkdownBlockConfig | MarkdownBlockRule[] | null,
  fenceRenderers?: MarkdownFenceRendererDefinition[]
): Promise<ArticleRenderResult> {
  return renderMarkdownInternal(markdown, {
    fenceRenderers,
    hydrateMathOnServer: false,
    includeHeadings: true,
    markdownBlockConfig
  });
}

export async function renderMarkdownWithKatex(
  markdown: string,
  markdownBlockConfig?: MarkdownBlockConfig | MarkdownBlockRule[] | null,
  fenceRenderers?: MarkdownFenceRendererDefinition[]
): Promise<ArticleRenderResult> {
  return renderMarkdownInternal(markdown, {
    fenceRenderers,
    hydrateMathOnServer: true,
    includeHeadings: true,
    markdownBlockConfig
  });
}

export async function renderMarkdownFragmentWithKatex(
  markdown: string,
  markdownBlockConfig?: MarkdownBlockConfig | MarkdownBlockRule[] | null,
  fenceRenderers?: MarkdownFenceRendererDefinition[]
): Promise<string> {
  const rendered = await renderMarkdownInternal(markdown, {
    fenceRenderers,
    hydrateMathOnServer: true,
    includeHeadings: false,
    markdownBlockConfig
  });

  return rendered.html;
}

export function extractMarkdownBlocks(
  markdown: string,
  markdownBlockConfig?: MarkdownBlockConfig | MarkdownBlockRule[] | null
): MarkdownBlock[] {
  const preparedMarkdown = applyMarkdownBlockRules(markdown, markdownBlockConfig);
  const tree = createRemarkParser(preparedMarkdown).parse(preparedMarkdown) as any;
  const children = Array.isArray(tree.children) ? tree.children : [];
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < children.length) {
    const child = children[index];
    const htmlBoundary = child?.type === "html" ? classifyHtmlTagBoundary(child.value) : null;

    if (htmlBoundary?.kind === "opening") {
      const tagStack = [htmlBoundary.tagName];
      let matchIndex = -1;

      for (let scanIndex = index + 1; scanIndex < children.length; scanIndex += 1) {
        const nextChild = children[scanIndex];
        const nextBoundary = nextChild?.type === "html" ? classifyHtmlTagBoundary(nextChild.value) : null;

        if (!nextBoundary) {
          continue;
        }

        if (nextBoundary.kind === "opening") {
          tagStack.push(nextBoundary.tagName);
          continue;
        }

        const expectedTagName = tagStack[tagStack.length - 1];
        if (nextBoundary.tagName !== expectedTagName) {
          matchIndex = -1;
          break;
        }

        tagStack.pop();
        if (tagStack.length === 0) {
          matchIndex = scanIndex;
          break;
        }
      }

      if (matchIndex !== -1) {
        const mergedBlock = createMarkdownBlock(
          preparedMarkdown,
          child?.position?.start?.offset,
          children[matchIndex]?.position?.end?.offset,
          child?.position?.start?.line,
          children[matchIndex]?.position?.end?.line
        );

        if (mergedBlock) {
          blocks.push(mergedBlock);
          index = matchIndex + 1;
          continue;
        }
      }
    }

    const block = createMarkdownBlock(
      preparedMarkdown,
      child?.position?.start?.offset,
      child?.position?.end?.offset,
      child?.position?.start?.line,
      child?.position?.end?.line
    );

    if (block) {
      blocks.push(block);
    }

    index += 1;
  }

  if (blocks.length === 0 && preparedMarkdown.trim().length > 0) {
    const lineCount = preparedMarkdown.split(/\r?\n/).length;
    blocks.push({
      startLine: 1,
      endLine: lineCount,
      startOffset: 0,
      endOffset: preparedMarkdown.length,
      source: preparedMarkdown
    });
  }

  return blocks;
}

export async function renderMarkdown(
  markdown: string,
  markdownBlockConfig?: MarkdownBlockConfig | MarkdownBlockRule[] | null,
  fenceRenderers?: MarkdownFenceRendererDefinition[]
): Promise<ArticleRenderResult> {
  return renderMarkdownWithMathPlaceholders(markdown, markdownBlockConfig, fenceRenderers);
}

export function rewriteRelativeAssetUrls(
  html: string,
  articleDirectory: string,
  assetBasePath: string
): string {
  const normalizedDir = articleDirectory.replace(/^\/+|\/+$/g, "");
  const normalizedBase = assetBasePath.replace(/\/+$/g, "");

  return html.replace(
    /(src|href)=("([^"]+)"|'([^']+)')/g,
    (match, attribute, quotedValue, doubleQuoted, singleQuoted) => {
      const original = doubleQuoted ?? singleQuoted ?? "";

      if (!original || isExternalResource(original)) {
        return match;
      }

      const rewritten = `${normalizedBase}/${normalizedDir ? `${normalizedDir}/` : ""}${original}`
        .replace(/\/{2,}/g, "/")
        .replace(":/", "://");
      const quote = quotedValue.startsWith("'") ? "'" : "\"";
      return `${attribute}=${quote}${rewritten}${quote}`;
    }
  );
}

export function rewriteManagedMediaUrls(html: string, mediaBasePath: string) {
  const normalizedBase = normalizeBasePath(mediaBasePath);

  return html.replace(
    /(src|href)=("([^"]+)"|'([^']+)')/g,
    (match, attribute, quotedValue, doubleQuoted, singleQuoted) => {
      const original = doubleQuoted ?? singleQuoted ?? "";

      if (!original.startsWith("@media/")) {
        return match;
      }

      const rewritten = `${normalizedBase}/${original.slice("@media/".length)}`.replace(/\/{2,}/g, "/");
      const quote = quotedValue.startsWith("'") ? "'" : "\"";
      return `${attribute}=${quote}${rewritten}${quote}`;
    }
  );
}

export function resolveManagedMediaPath(value: string, mediaBasePath: string) {
  if (!value.startsWith("@media/")) {
    return value;
  }

  return `${normalizeBasePath(mediaBasePath)}/${value.slice("@media/".length)}`.replace(/\/{2,}/g, "/");
}

export function rewriteManagedMediaTextReferences(content: string, mediaBasePath: string) {
  const normalizedBase = normalizeBasePath(mediaBasePath);
  return content.replace(/@media\/([A-Za-z0-9._/-]+)/g, (_match, assetPath: string) =>
    `${normalizedBase}/${assetPath}`.replace(/\/{2,}/g, "/")
  );
}
