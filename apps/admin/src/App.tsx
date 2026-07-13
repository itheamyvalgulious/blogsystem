import { startTransition, type SetStateAction, useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loader, type OnMount } from "@monaco-editor/react";
import * as monacoEditor from "monaco-editor";
import GithubSlugger from "github-slugger";
import "monaco-editor/esm/vs/editor/contrib/snippet/browser/snippetController2.js";
import "katex/dist/katex.min.css";
import katexCssRaw from "katex/dist/katex.min.css?raw";
import "./monaco-environment";

import { ActivityIcon } from "./components/ActivityIcon";
import { CommandPalette } from "./components/CommandPalette";
import { LoginView } from "./components/LoginView";

import {
  extractMarkdownBlocks,
  highlightThemeCss,
  normalizeAdminHomeConfig,
  normalizeEditorConfig,
  parseArticleSource,
  type ProjectLogRecord,
  type ProjectSummary,
  type ProjectTaskRecord,
  renderMarkdownFragmentWithKatex,
  rewriteManagedMediaTextReferences,
  rewriteManagedMediaUrls,
  rewriteRelativeAssetUrls,
  type ArticleRecord,
  type EditorSnippet,
  type FileSystemNode,
  type FileSystemFileNode
} from "@blog-system/content-core";

import {
  api,
  ApiRequestError,
  type AdminHomeConfigPayload,
  type EditorConfigPayload,
  type GlobalMarkdownSearchReplaceNextRequest,
  type GlobalMarkdownSearchRequest,
  type MarkdownBlockConfigPayload,
  type PublishConfigPayload,
  type ProjectLogPayload,
  type ProjectPayload,
  type ProjectsPayload,
  type ProjectTaskPayload,
  type SiteConfigPayload,
  type ThemeAssetPayload,
  type ThemeGroupsPayload,
  type TreePayload,
  type UsageStatsPayload
} from "./api";
import { jsonSchemas } from "./editor-config-schema";
import { evaluateWhenClause, getActiveKeybinding, getMatchingKeybindings, matchesKeybindingEvent } from "./keybindings";
import {
  installMarkdownMathTokenization,
  scanDocumentMathPairs,
  updateMathPairsCache,
  type MathPair
} from "./markdown-math-tokenization";
import {
  getSnippetTriggerCharacters,
  resolveActiveSnippetMatches
} from "./snippet-completion";
import {
  DEFAULT_FILE_PANE_FILTERS,
  parseStoredCollapsedTreePaths,
  parseStoredFilePaneFilters,
  parseStoredWorkbenchResource,
  remapCollapsedTreePaths,
  removeCollapsedTreePaths,
  serializeCollapsedTreePaths,
  serializeFilePaneFilters,
  serializeWorkbenchResource
} from "./workbench-session";
import type { FilePaneFilters, SortOrder, StatusFilter } from "./workbench-session";
import { getSnippetsForLanguage, normalizeWorkbenchSnippets } from "./snippet-scope";
import { getSnippetLanguageFromMathPairs } from "./snippet-context";
import {
  scanHeadingsFromText,
  buildOutlineTree,
  findActiveMarkdownOutlineItemId,
  hashLine,
  type CachedHeading,
  type MarkdownOutlineItem
} from "./markdown-outline";
import { builtInPlugins } from "./workbench/builtins";
import { resolvePreferredEditorId } from "./workbench/editor-associations";
import { normalizeThemeGroupId } from "./workbench/theme-utils";
import { PluginRuntime } from "./workbench/plugin-runtime";
import type {
  ArticleWorkbenchDocument,
  ClipboardImageInput,
  CreateDialogContributionDefinition,
  ConfigDocumentKind,
  ConfigWorkbenchDocument,
  EditorContributionDefinition,
  HomeWidgetContributionDefinition,
  HomeWorkbenchDocument,
  ModuleContributionDefinition,
  NormalizedEditorConfig,
  NormalizedSnippet,
  PaneContributionDefinition,
  PaneGroupId,
  RevealLineOptions,
  ProjectLogWorkbenchDocument,
  ProjectTaskWorkbenchDocument,
  ProjectWorkbenchDocument,
  ThemeAssetWorkbenchDocument,
  UsageStatsWorkbenchDocument,
  WorkbenchApi,
  WorkbenchDocument,
  WorkbenchEditorId,
  WorkbenchResourceTarget
} from "./workbench/types";
import {
  getProjectDocumentPath,
  getProjectLogDocumentPath,
  getProjectTaskDocumentPath,
  PROJECT_MODULE_ID,
  PROJECT_OVERVIEW_PANE_ID
} from "./workbench/project-utils";
import {
  getProjectTaskNoteQuery,
  getProjectTaskNoteSuggestions
} from "./workbench/project-task-utils";

loader.config({ monaco: monacoEditor });
void installMarkdownMathTokenization(monacoEditor);

const PREVIEW_UPDATE_DEBOUNCE_MS = 50;
const DRAFT_VALUE_SYNC_DEBOUNCE_MS = 50;
const DIRTY_CHECK_DEBOUNCE_MS = 700;
const USAGE_STATS_FLUSH_DEBOUNCE_MS = 2500;
const USAGE_STATS_ACTIVITY_TICK_MS = 15000;
const USAGE_STATS_ACTIVITY_IDLE_MS = 60000;
const SIDEBAR_WIDTH_STORAGE_KEY = "admin-sidebar-width";
const PREVIEW_WIDTH_STORAGE_KEY = "admin-preview-width";
const ARTICLE_CURSOR_STATE_STORAGE_KEY = "admin-article-cursor-state";
const ACTIVE_RESOURCE_STORAGE_KEY = "admin-active-resource";
const COLLAPSED_TREE_PATHS_STORAGE_KEY = "admin-collapsed-tree-paths";
const FILE_PANE_FILTERS_STORAGE_KEY = "admin-file-pane-filters";
const HOME_DOCUMENT_ID = "home:dashboard";
const USAGE_STATS_DOCUMENT_ID = "usage-stats:overview";

interface PreviewSourceParseResult {
  body: string;
  directory: string;
  frontmatterError: string | null;
  lineOffset: number;
}

interface ParsedPreviewBlock {
  hash: string;
  source: string;
  startLine: number;
  endLine: number;
}

interface RenderedPreviewBlock {
  id: string;
  hash: string;
  startLine: number;
  endLine: number;
  element: HTMLElement;
}

interface StoredArticleCursorState {
  lineNumber: number;
  column: number;
  scrollLeft: number;
  scrollTop: number;
}

interface PendingArticleReveal {
  articlePath: string;
  column?: number;
  focus?: boolean;
  lineNumber: number;
  moveCursor?: boolean;
}

interface SidebarPaneItem {
  kind: "core" | "plugin";
  paneId: string;
  tabLabel: string;
  title: string;
  component?: PaneContributionDefinition["component"];
}

interface SidebarModuleItem {
  icon: string;
  id: PaneGroupId;
  order?: number;
  title: string;
}

function loadStoredArticleCursorStates() {
  try {
    const rawValue = window.localStorage.getItem(ARTICLE_CURSOR_STATE_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as Record<string, Partial<StoredArticleCursorState>>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([articlePath, value]) =>
        typeof articlePath === "string" &&
        value &&
        Number.isFinite(value.lineNumber) &&
        Number.isFinite(value.column) &&
        Number.isFinite(value.scrollTop) &&
        Number.isFinite(value.scrollLeft)
          ? [
              [
                articlePath,
                {
                  lineNumber: Number(value.lineNumber),
                  column: Number(value.column),
                  scrollTop: Number(value.scrollTop),
                  scrollLeft: Number(value.scrollLeft)
                } satisfies StoredArticleCursorState
              ]
            ]
          : []
      )
    ) as Record<string, StoredArticleCursorState>;
  } catch {
    return {};
  }
}

const CONFIG_DOCUMENT_META: Record<Exclude<ConfigDocumentKind, "markdownBlockConfig" | "publishConfig" | "siteConfig">, { title: string; path: string; read: (payload: EditorConfigPayload) => string }> = {
  editorAssociations: {
    title: "editor.associations.json",
    path: "config/editor.associations.json",
    read: (payload) => payload.editorAssociationsRaw
  },
  markdownSnippets: {
    title: "markdown.snippets.json",
    path: "config/markdown.snippets.json",
    read: (payload) => payload.markdownSnippetsRaw
  },
  latexSnippets: {
    title: "latex.snippets.json",
    path: "config/latex.snippets.json",
    read: (payload) => payload.latexSnippetsRaw
  },
  keybindings: {
    title: "keybindings.json",
    path: "config/keybindings.json",
    read: (payload) => payload.keybindingsRaw
  }
};

const MARKDOWN_BLOCK_CONFIG_DOCUMENT_META = {
  title: "markdown-blocks.json",
  path: "config/markdown-blocks.json"
} as const;

const SITE_CONFIG_DOCUMENT_META = {
  title: "site.json",
  path: "config/site.json"
} as const;

const PUBLISH_CONFIG_DOCUMENT_META = {
  title: "site-publish.local.json",
  path: "config/site-publish.local.json"
} as const;

function getThemeGroupDocumentPath(groupId: string) {
  return `config/theme/${groupId}/theme.json`;
}

function getThemeAssetDocumentPath(groupId: string, fileName: string) {
  return `config/theme/${groupId}/${fileName}`;
}

function getDocumentPath(document: WorkbenchDocument | null, fallbackPath: string | null) {
  if (!document) {
    return fallbackPath ?? "";
  }

  if (document.kind === "home" || document.kind === "usageStats") {
    return fallbackPath ?? "";
  }

  if (document.kind === "article") {
    return document.articlePath;
  }

  if (document.kind === "themeAsset") {
    return document.editorPath;
  }

  if (document.kind === "project") {
    return getProjectDocumentPath(document.projectId);
  }

  if (document.kind === "projectTask") {
    return getProjectTaskDocumentPath(document.projectId, document.taskId);
  }

  if (document.kind === "projectLog") {
    return getProjectLogDocumentPath(document.projectId, document.logId);
  }

  if (document.kind === "config") {
    return getConfigDocumentPath(document.configKind);
  }

  return fallbackPath ?? document.title;
}

const CORE_MODULES = [
  {
    id: "explorer",
    icon: "explorer",
    order: 0,
    title: "Explorer"
  },
  {
    id: "outline",
    icon: "outline",
    order: 10,
    title: "Outline"
  },
  {
    id: "edit",
    icon: "edit",
    order: 20,
    title: "Edit"
  },
  {
    id: "plugins",
    icon: "plugins",
    order: 30,
    title: "Plugins"
  }
] as const satisfies SidebarModuleItem[];

const PREVIEW_SHADOW_BASE_CSS = `
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

const emptyConfigPayload: EditorConfigPayload = {
  editorAssociations: {},
  editorAssociationsRaw: "{}\n",
  markdownSnippets: [],
  latexSnippets: [],
  keybindings: [],
  markdownSnippetsRaw: "[]\n",
  latexSnippetsRaw: "[]\n",
  keybindingsRaw: "[]\n",
  warnings: []
};

const DEFAULT_KEYBINDINGS = normalizeEditorConfig({
  snippets: [],
  keybindings: [
    {
      key: "Ctrl+S",
      command: "workbench.saveActiveDocument"
    },
    {
      key: "Ctrl+Shift+P",
      command: "workbench.action.showCommands"
    },
    {
      key: "F1",
      command: "workbench.action.showCommands"
    },
    {
      key: "Ctrl+B",
      command: "workbench.toggleSidebar"
    },
    {
      key: "Ctrl+Backslash",
      command: "workbench.togglePreview"
    },
    {
      key: "F22",
      command: "acceptSelectedSuggestion",
      when: "suggestWidgetVisible"
    },
    {
      key: "Ctrl+E",
      command: "editor.markdown.set_bold",
      when: "editorTextFocus"
    }
  ]
}).keybindings;

function getConfigDocumentPath(kind: ConfigDocumentKind) {
  switch (kind) {
    case "markdownBlockConfig":
      return MARKDOWN_BLOCK_CONFIG_DOCUMENT_META.path;
    case "publishConfig":
      return PUBLISH_CONFIG_DOCUMENT_META.path;
    case "siteConfig":
      return SITE_CONFIG_DOCUMENT_META.path;
    default:
      return CONFIG_DOCUMENT_META[kind].path;
  }
}

function getConfigDocumentTitle(kind: ConfigDocumentKind) {
  switch (kind) {
    case "markdownBlockConfig":
      return MARKDOWN_BLOCK_CONFIG_DOCUMENT_META.title;
    case "publishConfig":
      return PUBLISH_CONFIG_DOCUMENT_META.title;
    case "siteConfig":
      return SITE_CONFIG_DOCUMENT_META.title;
    default:
      return CONFIG_DOCUMENT_META[kind].title;
  }
}

function getJsonSchemaDefinitions() {
  return [
    { uri: "inmemory://schemas/snippets.json", fileMatch: [CONFIG_DOCUMENT_META.markdownSnippets.path, CONFIG_DOCUMENT_META.latexSnippets.path], schema: jsonSchemas.snippetSchema as object },
    { uri: "inmemory://schemas/keybindings.json", fileMatch: [CONFIG_DOCUMENT_META.keybindings.path], schema: jsonSchemas.keybindingSchema as object },
    { uri: "inmemory://schemas/editor-associations.json", fileMatch: [CONFIG_DOCUMENT_META.editorAssociations.path], schema: jsonSchemas.editorAssociationsSchema as object },
    { uri: "inmemory://schemas/markdown-blocks.json", fileMatch: [MARKDOWN_BLOCK_CONFIG_DOCUMENT_META.path], schema: jsonSchemas.markdownBlockConfigSchema as object },
    { uri: "inmemory://schemas/theme-group.json", fileMatch: ["config/theme/*/theme.json"], schema: jsonSchemas.themeGroupConfigSchema as object },
    { uri: "inmemory://schemas/site.json", fileMatch: [SITE_CONFIG_DOCUMENT_META.path], schema: jsonSchemas.siteConfigSchema as object },
  ];
}

function hashText(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(36);
}

function parsePreviewBlocks(
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

function computeBodyLineOffset(rawContent: string) {
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

function findPreviewBlockByLine(blocks: RenderedPreviewBlock[], lineNumber: number) {
  for (const block of blocks) {
    if (lineNumber >= block.startLine && lineNumber <= block.endLine) {
      return block;
    }
  }

  return blocks.find((block) => block.startLine > lineNumber) ?? blocks[blocks.length - 1] ?? null;
}

function findPreviewAnchorElement(
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

function parsePreviewSource(articlePath: string, rawContent: string): PreviewSourceParseResult {
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
      frontmatterError: (error as Error).message,
      lineOffset: computeBodyLineOffset(rawContent)
    };
  }
}

function parsePlainPreviewSource(rawContent: string, directory: string): PreviewSourceParseResult {
  return {
    body: rawContent.replace(/\r\n/g, "\n"),
    directory,
    frontmatterError: null,
    lineOffset: 0
  };
}

function shouldStoreLiveDocumentValue(document: WorkbenchDocument) {
  return (
    document.kind !== "article" &&
    document.kind !== "config" &&
    document.kind !== "themeAsset" &&
    document.kind !== "usageStats"
  );
}

function canReadFullDocumentValueFromEditor(document: WorkbenchDocument) {
  return !shouldStoreLiveDocumentValue(document);
}

function parsePreviewSourceForDocument(
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

function isArticleDocument(document: WorkbenchDocument | null): document is ArticleWorkbenchDocument {
  return Boolean(document && document.kind === "article");
}

function isHomeDocument(document: WorkbenchDocument | null): document is HomeWorkbenchDocument {
  return Boolean(document && document.kind === "home");
}

function isUsageStatsDocument(document: WorkbenchDocument | null): document is UsageStatsWorkbenchDocument {
  return Boolean(document && document.kind === "usageStats");
}

function isConfigDocument(document: WorkbenchDocument | null): document is ConfigWorkbenchDocument {
  return Boolean(document && document.kind === "config");
}

function isThemeAssetDocument(document: WorkbenchDocument | null): document is ThemeAssetWorkbenchDocument {
  return Boolean(document && document.kind === "themeAsset");
}

function isProjectDocument(document: WorkbenchDocument | null): document is ProjectWorkbenchDocument {
  return Boolean(document && document.kind === "project");
}

function isProjectTaskDocument(document: WorkbenchDocument | null): document is ProjectTaskWorkbenchDocument {
  return Boolean(document && document.kind === "projectTask");
}

function isProjectLogDocument(document: WorkbenchDocument | null): document is ProjectLogWorkbenchDocument {
  return Boolean(document && document.kind === "projectLog");
}

function isMarkdownCompletionDocument(document: WorkbenchDocument | null) {
  return isArticleDocument(document) || isProjectTaskDocument(document);
}

function buildNormalizedEditorConfig(configPayload: EditorConfigPayload | null): NormalizedEditorConfig {
  const payload = configPayload ?? emptyConfigPayload;
  return {
    markdownSnippets: normalizeWorkbenchSnippets(payload.markdownSnippets, "markdown"),
    latexSnippets: normalizeWorkbenchSnippets(payload.latexSnippets, "latex"),
    keybindings: [...DEFAULT_KEYBINDINGS, ...normalizeEditorConfig({ snippets: [], keybindings: payload.keybindings }).keybindings]
  };
}

function buildConfigDocument(
  kind: ConfigDocumentKind,
  payload:
    | EditorConfigPayload
    | MarkdownBlockConfigPayload
    | PublishConfigPayload
    | SiteConfigPayload
): ConfigWorkbenchDocument {
  const value =
    kind === "markdownBlockConfig"
      ? (payload as MarkdownBlockConfigPayload).raw
      : kind === "publishConfig"
      ? (payload as PublishConfigPayload).raw
      : kind === "siteConfig"
      ? (payload as SiteConfigPayload).raw
      : CONFIG_DOCUMENT_META[kind].read(payload as EditorConfigPayload);

  return {
    id: `config:${kind}`,
    kind: "config",
    editorId: "workbench.code-text",
    configKind: kind,
    title: getConfigDocumentTitle(kind),
    language: "json",
    value,
    savedValue: value,
    dirty: false,
    previewable: false
  };
}

function buildHomeDocument(): HomeWorkbenchDocument {
  return {
    id: HOME_DOCUMENT_ID,
    kind: "home",
    editorId: "workbench.home-dashboard",
    title: "Admin Home",
    language: "json",
    value: "",
    savedValue: "",
    dirty: false,
    previewable: false
  };
}

function buildUsageStatsDocument(payload: UsageStatsPayload): UsageStatsWorkbenchDocument {
  return {
    id: USAGE_STATS_DOCUMENT_ID,
    kind: "usageStats",
    editorId: "usage-stats.overview",
    title: "Usage Stats",
    language: "json",
    value: payload.raw,
    savedValue: payload.raw,
    dirty: false,
    previewable: false,
    stats: payload.value
  };
}

function buildArticleDocument(record: ArticleRecord): ArticleWorkbenchDocument {
  return {
    id: `article:${record.path}`,
    kind: "article",
    editorId: "workbench.article-markdown",
    articlePath: record.path,
    record,
    title: record.title,
    language: "markdown",
    value: record.rawContent,
    savedValue: record.rawContent,
    dirty: false,
    previewable: true
  };
}

function buildThemeAssetDocument(payload: ThemeAssetPayload): ThemeAssetWorkbenchDocument {
  return {
    id: `theme-asset:${payload.assetPath}`,
    kind: "themeAsset",
    editorId: "workbench.code-text",
    assetPath: payload.assetPath,
    fileName: payload.fileName,
    groupId: payload.groupId,
    editorPath: getThemeAssetDocumentPath(payload.groupId, payload.fileName),
    title: payload.fileName,
    language: payload.language,
    value: payload.raw,
    savedValue: payload.raw,
    dirty: false,
    previewable: false
  };
}

function buildProjectDocument(payload: ProjectPayload): ProjectWorkbenchDocument {
  return {
    id: `project:${payload.value.id}`,
    kind: "project",
    editorId: "project.overview",
    projectId: payload.value.id,
    record: payload.value,
    title: payload.value.title,
    language: "json",
    value: payload.raw,
    savedValue: payload.raw,
    dirty: false,
    previewable: false
  };
}

function buildProjectTaskDocument(payload: ProjectTaskPayload): ProjectTaskWorkbenchDocument {
  return {
    id: `project-task:${payload.projectId}:${payload.value.id}`,
    kind: "projectTask",
    editorId: "project.task-markdown",
    projectId: payload.projectId,
    record: payload.value,
    taskId: payload.value.id,
    title: payload.value.title,
    language: "markdown",
    value: payload.raw,
    savedValue: payload.raw,
    dirty: false,
    previewable: false
  };
}

function buildProjectLogDocument(payload: ProjectLogPayload): ProjectLogWorkbenchDocument {
  return {
    id: `project-log:${payload.projectId}:${payload.value.id}`,
    kind: "projectLog",
    editorId: "project.log-markdown",
    logId: payload.value.id,
    projectId: payload.projectId,
    record: payload.value,
    title: payload.value.title,
    language: "markdown",
    value: payload.raw,
    savedValue: payload.raw,
    dirty: false,
    previewable: false
  };
}

function upsertDocument(documents: WorkbenchDocument[], nextDocument: WorkbenchDocument) {
  const index = documents.findIndex((document) => document.id === nextDocument.id);
  if (index === -1) {
    return [...documents, nextDocument];
  }
  const nextDocuments = [...documents];
  nextDocuments[index] = nextDocument;
  return nextDocuments;
}

function closeDocument(documents: WorkbenchDocument[], documentId: string) {
  return documents.filter((document) => document.id === HOME_DOCUMENT_ID || document.id !== documentId);
}

function isDocumentInProject(document: WorkbenchDocument, projectId: string) {
  return (
    (document.kind === "project" ||
      document.kind === "projectTask" ||
      document.kind === "projectLog") &&
    document.projectId === projectId
  );
}

function closeProjectDocuments(documents: WorkbenchDocument[], projectId: string) {
  return documents.filter((document) => document.kind === "home" || !isDocumentInProject(document, projectId));
}

function removeProjectDraftValues(draftValues: Record<string, string>, projectId: string) {
  return Object.fromEntries(
    Object.entries(draftValues).filter(
      ([key]) =>
        !(
          key === `project:${projectId}` ||
          key.startsWith(`project-task:${projectId}:`) ||
          key.startsWith(`project-log:${projectId}:`)
        )
    )
  );
}

function getParentPath(path: string) {
  const normalized = path.replace(/\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? "" : normalized.slice(0, index);
}

function getBaseName(path: string) {
  const normalized = path.replace(/\/+$/g, "");
  const index = normalized.lastIndexOf("/");
  return index === -1 ? normalized : normalized.slice(index + 1);
}

function matchesPathPrefix(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function replacePathPrefix(path: string, fromPrefix: string, toPrefix: string) {
  if (path === fromPrefix) {
    return toPrefix;
  }
  if (path.startsWith(`${fromPrefix}/`)) {
    return `${toPrefix}${path.slice(fromPrefix.length)}`;
  }
  return path;
}

function remapArticleCursorStates(
  states: Record<string, StoredArticleCursorState>,
  fromPath: string,
  toPath: string
) {
  return Object.fromEntries(
    Object.entries(states).map(([articlePath, value]) => [replacePathPrefix(articlePath, fromPath, toPath), value])
  );
}

function removeArticleCursorStates(states: Record<string, StoredArticleCursorState>, targetPath: string) {
  return Object.fromEntries(
    Object.entries(states).filter(([articlePath]) => !matchesPathPrefix(articlePath, targetPath))
  );
}

function remapArticleDraftValues(
  draftValues: Record<string, string>,
  fromPath: string,
  toPath: string
) {
  return Object.fromEntries(
    Object.entries(draftValues).map(([key, value]) =>
      key.startsWith("article:")
        ? [`article:${replacePathPrefix(key.slice("article:".length), fromPath, toPath)}`, value]
        : [key, value]
    )
  );
}

function removeArticleDraftValues(draftValues: Record<string, string>, targetPath: string) {
  return Object.fromEntries(
    Object.entries(draftValues).filter(
      ([key]) =>
        !key.startsWith("article:") || !matchesPathPrefix(key.slice("article:".length), targetPath)
    )
  );
}

function flattenTreePaths(nodes: TreePayload["tree"]): string[] {
  return nodes.flatMap((node) => (node.type === "directory" ? flattenTreePaths(node.children ?? []) : [node.path]));
}

function buildFileTreeMap(nodes: FileSystemNode[]) {
  const entries = new Map<string, FileSystemNode>();
  const visit = (node: FileSystemNode) => {
    entries.set(node.path, node);
    if (node.type === "directory") {
      node.children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return entries;
}

function filterFileTreeNode(node: FileSystemNode, searchQuery: string, selectedTag: string, selectedStatus: StatusFilter, showAssets: boolean) {
  const query = searchQuery.trim().toLowerCase();
  if (node.type === "directory") {
    return (
      query.length === 0 ||
      node.name.toLowerCase().includes(query) ||
      node.path.toLowerCase().includes(query) ||
      node.children.some((child) => filterFileTreeNode(child, searchQuery, selectedTag, selectedStatus, showAssets))
    );
  }
  if (!showAssets && node.fileKind === "asset") {
    return false;
  }
  const article = node.article;
  const matchesQuery =
    query.length === 0 ||
    node.name.toLowerCase().includes(query) ||
    node.path.toLowerCase().includes(query) ||
    article?.title.toLowerCase().includes(query) ||
    article?.tags.some((tag) => tag.toLowerCase().includes(query));
  const matchesTag = !article || selectedTag === "all" || article.tags.includes(selectedTag);
  const matchesStatus = !article || selectedStatus === "all" || article.status === selectedStatus;
  return matchesQuery && matchesTag && matchesStatus;
}

function sortTreeNodes(nodes: FileSystemNode[], sortOrder: SortOrder): FileSystemNode[] {
  const now = Date.now();
  return nodes
    .map((node) => {
      if (node.type === "directory") {
        return { ...node, children: sortTreeNodes(node.children, sortOrder) };
      }
      return node;
    })
    .sort((left, right) => {
      if (left.type === "directory" && right.type !== "directory") {
        return -1;
      }
      if (left.type !== "directory" && right.type === "directory") {
        return 1;
      }
      if (left.type === "directory" && right.type === "directory") {
        return left.name.localeCompare(right.name);
      }
      const leftTitle = left.article?.title ?? left.name;
      const rightTitle = right.article?.title ?? right.name;
      if (sortOrder.startsWith("date")) {
        const leftDate = left.fileKind === "asset" ? Infinity
          : left.article?.date ? Date.parse(left.article.date) : now;
        const rightDate = right.fileKind === "asset" ? Infinity
          : right.article?.date ? Date.parse(right.article.date) : now;
        if (leftDate !== rightDate) {
          return sortOrder === "date-inc" ? leftDate - rightDate : rightDate - leftDate;
        }
        return leftTitle.localeCompare(rightTitle) * (sortOrder === "date-inc" ? 1 : -1);
      }
      const titleCmp = leftTitle.localeCompare(rightTitle);
      return sortOrder === "title-inc" ? titleCmp : -titleCmp;
    });
}

function toSnippetBody(body: string | string[]) {
  return Array.isArray(body) ? body.join("\n") : body;
}

function getScopedSnippets(snippets: NormalizedSnippet[], languageId: "markdown" | "latex") {
  return getSnippetsForLanguage(snippets, languageId);
}

function resolveEditorSnippetState(
  linePrefix: string,
  snippetLanguage: "markdown" | "latex",
  normalizedConfig: NormalizedEditorConfig
) {
  return resolveActiveSnippetMatches(
    linePrefix,
    snippetLanguage,
    getScopedSnippets(normalizedConfig.markdownSnippets, "markdown"),
    getScopedSnippets(normalizedConfig.latexSnippets, "latex")
  );
}

function buildPreviewRootCompatCss(rawCss: string) {
  return rawCss.replace(/(^|,)\s*:root\b/gm, "$1 :host, html");
}

function isWorkbenchKeybindingCommand(command: string) {
  return command === "workbench.action.showCommands" || command.startsWith("workbench.") || command.startsWith("blog.");
}

function isSuppressedDefaultEditorCommand(command: string, context: Record<string, unknown>) {
  switch (command) {
    case "acceptSelectedSuggestion":
      return context.suggestWidgetVisible === true;
    case "editor.action.triggerSuggest":
    case "editor.action.inlineSuggest.commit":
    case "editor.action.copyLinesDownAction":
    case "markdown.extension.onCopyLineDown":
    case "editor.action.copyLinesUpAction":
    case "markdown.extension.onCopyLineUp":
    case "editor.action.insertCursorAbove":
    case "editor.action.insertCursorBelow":
    case "workbench.action.quickOpen":
      return true;
    default:
      return false;
  }
}

function parseCommaSeparatedTags(value: string) {
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function deriveArticleFileName(title: string) {
  const normalized = title.trim().replace(/\s+/g, "-");
  return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
}

function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function remapDocuments(documents: WorkbenchDocument[], fromPath: string, toPath: string) {
  return documents.map((document) => {
    if (document.kind !== "article") {
      return document;
    }
    const nextPath = replacePathPrefix(document.articlePath, fromPath, toPath);
    if (nextPath === document.articlePath) {
      return document;
    }
    return {
      ...document,
      id: `article:${nextPath}`,
      articlePath: nextPath,
      record: {
        ...document.record,
        path: nextPath,
        directory: getParentPath(nextPath),
        fileName: getBaseName(nextPath)
      }
    };
  });
}

function removeDocuments(documents: WorkbenchDocument[], targetPath: string) {
  return documents.filter((document) => document.kind !== "article" || !matchesPathPrefix(document.articlePath, targetPath));
}

function isWorkbenchTabShortcutEvent(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code" | "key">) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
    return false;
  }

  return (
    /^Digit[1-9]$/.test(event.code) ||
    event.code === "PageUp" ||
    event.code === "PageDown" ||
    event.key === "PageUp" ||
    event.key === "PageDown" ||
    event.code === "KeyW" ||
    event.key.toLowerCase() === "w"
  );
}

export function App() {
  const [initialArticleCursorStates] = useState(loadStoredArticleCursorStates);
  const [initialCollapsedTreePaths] = useState(() =>
    parseStoredCollapsedTreePaths(window.localStorage.getItem(COLLAPSED_TREE_PATHS_STORAGE_KEY))
  );
  const [initialActiveResource] = useState(() =>
    parseStoredWorkbenchResource(window.localStorage.getItem(ACTIVE_RESOURCE_STORAGE_KEY))
  );
  const [authenticated, setAuthenticated] = useState(false);
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [sidebarGroupId, setSidebarGroupId] = useState<PaneGroupId>("explorer");
  const [activePaneByGroup, setActivePaneByGroup] = useState<Record<string, string>>({
    edit: "edit-actions",
    explorer: "files",
    plugins: "plugin-manager"
  });
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [previewVisible, setPreviewVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(() => Number(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY) ?? 280));
  const [previewWidth, setPreviewWidth] = useState(() => Number(window.localStorage.getItem(PREVIEW_WIDTH_STORAGE_KEY) ?? 420));
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteMode, setCommandPaletteMode] = useState<"commands" | "editors" | "themeGroupCreate" | "themes">("commands");
  const [commandQuery, setCommandQuery] = useState("");
  const [selectedPaletteIndex, setSelectedPaletteIndex] = useState(0);
  const [treePayload, setTreePayload] = useState<TreePayload | null>(null);
  const [adminHomePayload, setAdminHomePayload] = useState<AdminHomeConfigPayload | null>(null);
  const [configPayload, setConfigPayload] = useState<EditorConfigPayload | null>(null);
  const [markdownBlockConfigPayload, setMarkdownBlockConfigPayload] = useState<MarkdownBlockConfigPayload | null>(null);
  const [projectsPayload, setProjectsPayload] = useState<ProjectsPayload | null>(null);
  const [themeGroupsPayload, setThemeGroupsPayload] = useState<ThemeGroupsPayload | null>(null);
  const [publishConfigPayload, setPublishConfigPayload] = useState<PublishConfigPayload | null>(null);
  const [siteConfigPayload, setSiteConfigPayload] = useState<SiteConfigPayload | null>(null);
  const [usageStatsPayload, setUsageStatsPayload] = useState<UsageStatsPayload | null>(null);
  const [documents, setDocuments] = useState<WorkbenchDocument[]>(() => [buildHomeDocument()]);
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(HOME_DOCUMENT_ID);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [initialFilters] = useState<FilePaneFilters>(() =>
    parseStoredFilePaneFilters(window.localStorage.getItem(FILE_PANE_FILTERS_STORAGE_KEY))
  );
  const [searchQuery, setSearchQuery] = useState(initialFilters.searchQuery);
  const [publishBusy, setPublishBusy] = useState(false);
  const [tagFilter, setTagFilter] = useState(initialFilters.tagFilter);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(initialFilters.statusFilter);
  const [sortOrder, setSortOrder] = useState<SortOrder>(initialFilters.sortOrder);
  const [showAssets, setShowAssets] = useState(initialFilters.showAssets);
  const [previewRenderDialogOpen, setPreviewRenderDialogOpen] = useState(false);
  const [renderStyleAssetVersion, setRenderStyleAssetVersion] = useState(0);
  const [activeArticleLineNumber, setActiveArticleLineNumber] = useState<number | null>(null);
  const [themeId, setThemeId] = useState(() => window.localStorage.getItem("admin-theme") ?? "eva-dark");
  const [disabledPluginIds, setDisabledPluginIds] = useState<string[]>(() => {
    try {
      const rawValue = window.localStorage.getItem("admin-disabled-plugins");
      return rawValue ? (JSON.parse(rawValue) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);
  const [collapsedTreePaths, setCollapsedTreePaths] = useState<Set<string>>(initialCollapsedTreePaths);
  const [contextMenuState, setContextMenuState] = useState<{ path: string; x: number; y: number } | null>(null);
  const [contextMenuPos, setContextMenuPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    if (!contextMenuState) {
      return;
    }
    const menu = contextMenuRef.current;
    const margin = 4;
    let left = contextMenuState.x;
    let top = contextMenuState.y;
    if (menu) {
      const rect = menu.getBoundingClientRect();
      const maxLeft = window.innerWidth - rect.width - margin;
      const maxTop = window.innerHeight - rect.height - margin;
      // Not enough room to the right: open to the left of the cursor.
      if (left > maxLeft) {
        left = Math.max(margin, contextMenuState.x - rect.width);
      }
      // Not enough room below: open above the cursor so the menu never leaves
      // the viewport.
      if (top > maxTop) {
        top = Math.max(margin, contextMenuState.y - rect.height);
      }
    }
    setContextMenuPos({ left, top });
  }, [contextMenuState]);
  const [treeClipboard, setTreeClipboard] = useState<{ path: string; mode: "copy" | "move" } | null>(null);
  const [fileDialog, setFileDialog] = useState<{
    entryType: "file" | "directory";
    fileKind?: "article" | "asset";
    mode: "create-file" | "create-directory" | "rename" | "delete";
    path: string;
    value: string;
    metadata: Record<string, string>;
  } | null>(null);
  const [folderMetadataDialog, setFolderMetadataDialog] = useState<{
    path: string;
    name: string;
    tags: string;
    title: string;
    status: string;
    top: string;
    date: string;
    summary: string;
    slug: string;
    password: string;
    extraJson: string;
  } | null>(null);
  const [titleConflictState, setTitleConflictState] = useState<{
    conflicts: Array<{ path: string; title: string }>;
    fileDialog: {
      entryType: "file" | "directory";
      fileKind?: "article" | "asset";
      mode: "create-file" | "create-directory" | "rename" | "delete";
      path: string;
      value: string;
      metadata: Record<string, string>;
    };
  } | null>(null);
  const [textInputDialog, setTextInputDialog] = useState<{
    confirmLabel: string;
    description?: string;
    emptyValueMessage: string;
    error: string | null;
    label: string;
    overline: string;
    placeholder?: string;
    title: string;
    value: string;
  } | null>(null);
  const [previewSourceText, setPreviewSourceText] = useState("");
  const [editorReadyVersion, setEditorReadyVersion] = useState(0);
  const [previewReadyVersion, setPreviewReadyVersion] = useState(0);
  const deferredCommandQuery = useDeferredValue(commandQuery);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const editorRef = useRef<monacoEditor.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof monacoEditor | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewShadowHeadRef = useRef<HTMLDivElement | null>(null);
  const previewProseRef = useRef<HTMLDivElement | null>(null);
  const previewBlocksRef = useRef<RenderedPreviewBlock[]>([]);
  const headingsRef = useRef<CachedHeading[]>([]);
  const mathPairsRef = useRef<MathPair[]>([]);
  const outlineVersionRef = useRef(0);
  const previewBlockIdRef = useRef(0);
  const previewCursorSyncRafRef = useRef<number | null>(null);
  const schedulePreviewCursorSyncRef = useRef<(() => void) | null>(null);
  const suppressPreviewFollowFromEditorScrollRef = useRef(false);
  const previewUpdateTimerRef = useRef<number | null>(null);
  const previewRenderRequestRef = useRef(0);
  const editorFeatureCleanupRef = useRef<(() => void) | null>(null);
  const adminHomeSaveTimerRef = useRef<number | null>(null);
  const articleCursorPersistTimerRef = useRef<number | null>(null);
  const dirtyCheckTimerRef = useRef<number | null>(null);
  const draftValueSyncTimerRef = useRef<number | null>(null);
  const usageStatsFlushTimerRef = useRef<number | null>(null);
  const usageStatsActivityTimerRef = useRef<number | null>(null);
  const articleCursorStatesRef = useRef<Record<string, StoredArticleCursorState>>(initialArticleCursorStates);
  const lastStoredArticleLineNumberRef = useRef<number | null>(null);
  const lastPreviewCursorSyncLineRef = useRef<number | null>(null);
  const activeDocumentIdRef = useRef<string | null>(activeDocumentId);
  const dirtyDocumentIdsRef = useRef<Set<string>>(new Set());
  const textInputDialogResolveRef = useRef<((value: string | null) => void) | null>(null);
  const textInputDialogInputRef = useRef<HTMLInputElement | null>(null);
  const draftValuesRef = useRef<Record<string, string>>({});
  const usageStatsPendingActiveMsRef = useRef(0);
  const usageStatsPendingDocumentDeltaRef = useRef<
    Map<string, { documentId: string; documentKind: string; title: string; netCharacterDelta: number }>
  >(new Map());
  const usageStatsLastInteractionAtRef = useRef<number | null>(null);
  const workbenchApiRef = useRef<WorkbenchApi | null>(null);
  const treeRootRef = useRef<HTMLDivElement | null>(null);
  const pendingArticleRevealRef = useRef<PendingArticleReveal | null>(null);
  const restoredSessionRef = useRef(false);
  const initialActiveResourceRef = useRef(initialActiveResource);

  const enabledPlugins = useMemo(() => builtInPlugins.filter((plugin) => !disabledPluginIds.includes(plugin.id)), [disabledPluginIds]);
  const pluginRuntime = useMemo(() => {
    const runtime = new PluginRuntime();
    runtime.activate(enabledPlugins);
    return runtime;
  }, [enabledPlugins]);

  const [outlineVersion, setOutlineVersion] = useState(0);

  const outlineTree = useMemo(
    () => buildOutlineTree(headingsRef.current),
    [outlineVersion]
  );

  const activeOutlineItemId = useMemo(
    () => findActiveMarkdownOutlineItemId(headingsRef.current, activeArticleLineNumber),
    [outlineVersion, activeArticleLineNumber]
  );

  const getSnippetLanguageForEditor = useCallback(
    (model: monacoEditor.editor.ITextModel, position: monacoEditor.Position) => {
      return getSnippetLanguageFromMathPairs(mathPairsRef.current, position.lineNumber, position.column);
    },
    []
  );
  const activeDocument = useMemo(() => documents.find((document) => document.id === activeDocumentId) ?? null, [documents, activeDocumentId]);
  useLayoutEffect(() => {
    activeDocumentIdRef.current = activeDocumentId;
    dirtyDocumentIdsRef.current = new Set(documents.filter((document) => document.dirty).map((document) => document.id));
  }, [activeDocumentId, documents]);
  const normalizedConfig = useMemo(() => buildNormalizedEditorConfig(configPayload), [configPayload]);
  const fileTreeMap = useMemo(() => buildFileTreeMap(treePayload?.fileTree ?? []), [treePayload?.fileTree]);
  const selectedTreeNode = selectedTreePath ? fileTreeMap.get(selectedTreePath) ?? null : null;
  const contextTargetNode = contextMenuState?.path ? fileTreeMap.get(contextMenuState.path) ?? null : null;
  const availableCommands = useMemo(() => pluginRuntime.getCommands(), [pluginRuntime]);
  const availableEditors = useMemo(() => pluginRuntime.getEditorContributions(), [pluginRuntime]);
  const availableMarkdownFenceRenderers = useMemo(
    () => pluginRuntime.getMarkdownFenceRenderers(),
    [pluginRuntime]
  );
  const availableThemes = useMemo(() => pluginRuntime.getThemes(), [pluginRuntime]);
  const moduleContributions = useMemo(
    () =>
      pluginRuntime
        .getWorkbenchContributions()
        .filter(
          (contribution): contribution is ModuleContributionDefinition => contribution.kind === "module"
        ),
    [pluginRuntime]
  );
  const paneContributions = useMemo(
    () =>
      pluginRuntime
        .getWorkbenchContributions()
        .filter((contribution): contribution is PaneContributionDefinition => contribution.kind === "pane"),
    [pluginRuntime]
  );
  const sidebarModules = useMemo<SidebarModuleItem[]>(
    () =>
      [...CORE_MODULES, ...moduleContributions.map((module) => ({
        icon: module.icon,
        id: module.moduleId,
        order: module.order,
        title: module.title
      }))].sort((left, right) => (left.order ?? 0) - (right.order ?? 0)),
    [moduleContributions]
  );
  const groupedPanes = useMemo<Record<string, SidebarPaneItem[]>>(
    () => {
      const groups: Record<string, SidebarPaneItem[]> = {
        edit: [
          {
            kind: "core",
            paneId: "edit-actions",
            tabLabel: "Actions",
            title: "Edit Actions"
          }
        ],
        explorer: [
          {
            kind: "core",
            paneId: "files",
            tabLabel: "Files",
            title: "Files"
          }
        ],
        outline: [],
        plugins: [
          {
            kind: "core",
            paneId: "plugin-manager",
            tabLabel: "Plugins",
            title: "Plugins"
          }
        ]
      };

      for (const module of sidebarModules) {
        groups[module.id] ??= [];
      }

      for (const pane of paneContributions) {
        groups[pane.defaultGroupId] ??= [];
        groups[pane.defaultGroupId].push({
          component: pane.component,
          kind: "plugin",
          paneId: pane.paneId,
          tabLabel: pane.tabLabel,
          title: pane.title
        });
      }

      return groups;
    },
    [paneContributions, sidebarModules]
  );
  const activeGroupPanes = groupedPanes[sidebarGroupId] ?? groupedPanes.explorer ?? [];
  const activePaneId =
    activePaneByGroup[sidebarGroupId] && activeGroupPanes.some((pane) => pane.paneId === activePaneByGroup[sidebarGroupId])
      ? activePaneByGroup[sidebarGroupId]
      : activeGroupPanes[0]?.paneId ?? null;
  const activeSidebarPane =
    activePaneId ? activeGroupPanes.find((pane) => pane.paneId === activePaneId) ?? null : null;
  const createDialogContributions = useMemo(
    () =>
      pluginRuntime
        .getWorkbenchContributions()
        .filter((contribution): contribution is CreateDialogContributionDefinition => contribution.kind === "create-dialog"),
    [pluginRuntime]
  );
  const homeWidgetContributions = useMemo(
    () =>
      pluginRuntime
        .getWorkbenchContributions()
        .filter((contribution): contribution is HomeWidgetContributionDefinition => contribution.kind === "home-widget"),
    [pluginRuntime]
  );
  const activeEditorContribution = useMemo(() => {
    if (!activeDocument) {
      return null;
    }

    return (
      pluginRuntime.getEditorContribution(activeDocument.editorId) ??
      availableEditors.find((editor) => editor.canHandle(activeDocument)) ??
      null
    );
  }, [activeDocument, availableEditors, pluginRuntime]);
  const activeDocumentSupportsPreview = Boolean(
    activeDocument && activeEditorContribution?.supportsPreview
  );
  const previewPaneVisible = activeDocumentSupportsPreview && previewVisible;
  const hasDirtyArticleDocument = useCallback(
    () => documents.some((document) => document.kind === "article" && document.dirty),
    [documents]
  );
  const activeTheme = pluginRuntime.getTheme(themeId) ?? availableThemes[0] ?? null;
  const enabledThemeGroups = useMemo(
    () => (themeGroupsPayload?.groups ?? []).filter((group) => group.enable),
    [themeGroupsPayload]
  );
  const resolveDocumentEditorId = useCallback(
    (document: WorkbenchDocument, preferredEditorId?: WorkbenchEditorId) => {
      if (preferredEditorId) {
        const preferredEditor = availableEditors.find(
          (editor) => editor.editorId === preferredEditorId && editor.canHandle(document)
        );

        if (preferredEditor) {
          return preferredEditor.editorId;
        }
      }

      return (
        resolvePreferredEditorId(
          document,
          availableEditors,
          configPayload?.editorAssociations ?? emptyConfigPayload.editorAssociations
        ) ?? document.editorId
      );
    },
    [availableEditors, configPayload?.editorAssociations]
  );
  const withResolvedEditor = useCallback(
    <T extends WorkbenchDocument>(document: T, preferredEditorId?: WorkbenchEditorId) =>
      ({
        ...document,
        editorId: resolveDocumentEditorId(document, preferredEditorId)
      }) as T,
    [resolveDocumentEditorId]
  );
  useEffect(() => {
    setActivePaneByGroup((current) => {
      let changed = false;
      const nextValue = { ...current };

      for (const [groupId, panes] of Object.entries(groupedPanes)) {
        const activeGroupPaneId = nextValue[groupId];
        if (activeGroupPaneId && panes.some((pane) => pane.paneId === activeGroupPaneId)) {
          continue;
        }

        nextValue[groupId] = panes[0]?.paneId ?? "";
        changed = true;
      }

      return changed ? nextValue : current;
    });
  }, [groupedPanes]);
  const previewThemeCssAssets = useMemo(
    () =>
      enabledThemeGroups.flatMap((group) =>
        group.files
          .filter(
            (file) =>
              file.type === "css" &&
              file.adminPreview &&
              file.colorMode === (activeTheme?.appearance ?? "dark")
          )
          .map((file) => ({
            assetPath: `${group.groupId}/${file.fileName}`,
            colorMode: file.colorMode,
            fileName: file.fileName,
            groupId: group.groupId
          }))
      ),
    [activeTheme?.appearance, enabledThemeGroups]
  );
  const previewThemeScriptAssets = useMemo(
    () =>
      enabledThemeGroups.flatMap((group) =>
        group.files
          .filter((file) => file.type === "js" && file.adminPreview)
          .map((file) => ({
            assetPath: `${group.groupId}/${file.fileName}`,
            fileName: file.fileName,
            groupId: group.groupId
          }))
      ),
    [enabledThemeGroups]
  );
  const activePreviewFenceRenderers = useMemo(() => {
    const enabledSitePluginIds = Array.isArray(siteConfigPayload?.value.enabledPlugins)
      ? siteConfigPayload?.value.enabledPlugins.filter((entry): entry is string => typeof entry === "string")
      : [];

    if (enabledSitePluginIds.length === 0) {
      return [];
    }

    return availableMarkdownFenceRenderers.filter((renderer) => {
      if (renderer.language !== "commutative") {
        return true;
      }

      return enabledSitePluginIds.includes("commutative");
    });
  }, [availableMarkdownFenceRenderers, siteConfigPayload?.value.enabledPlugins]);
  const commandItems = useMemo(() => {
    const query = deferredCommandQuery.trim().toLowerCase();
    const base = availableCommands.map((command) => ({
      id: command.id,
      title: command.title,
      description: command.keywords?.join(", "),
      haystack: `${command.title} ${command.id} ${(command.keywords ?? []).join(" ")}`.toLowerCase()
    }));
    return query ? base.filter((command) => command.haystack.includes(query)) : base;
  }, [availableCommands, deferredCommandQuery]);
  const themeItems = useMemo(() => {
    const query = deferredCommandQuery.trim().toLowerCase();
    const base = availableThemes.map((theme) => ({
      id: theme.id,
      title: theme.label,
      description: theme.appearance === "dark" ? "Dark theme" : "Light theme",
      haystack: `${theme.label} ${theme.id} ${theme.appearance}`.toLowerCase()
    }));
    return query ? base.filter((theme) => theme.haystack.includes(query)) : base;
  }, [availableThemes, deferredCommandQuery]);
  const editorItems = useMemo(() => {
    if (!activeDocument) {
      return [];
    }

    const query = deferredCommandQuery.trim().toLowerCase();
    const base = availableEditors
      .filter((editor) => editor.canHandle(activeDocument))
      .map((editor) => ({
        id: editor.editorId,
        title: editor.label,
        description: editor.editorId === activeDocument.editorId ? "Current editor" : editor.editorId,
        haystack: `${editor.label} ${editor.editorId}`.toLowerCase()
      }));

    return query ? base.filter((item) => item.haystack.includes(query)) : base;
  }, [activeDocument, availableEditors, deferredCommandQuery]);
  const themeGroupCreateItems = useMemo(() => {
    if (commandPaletteMode !== "themeGroupCreate") {
      return [];
    }

    const normalizedGroupId = normalizeThemeGroupId(deferredCommandQuery);
    if (!normalizedGroupId) {
      return [];
    }

    const existing = (themeGroupsPayload?.groups ?? []).some(
      (group) => group.groupId.toLowerCase() === normalizedGroupId.toLowerCase()
    );

    return [
      {
        id: "theme-group:create-input",
        title: `${existing ? "Open" : "Create"} ${normalizedGroupId}`,
        description: `config/theme/${normalizedGroupId}/theme.json`
      }
    ];
  }, [commandPaletteMode, deferredCommandQuery, themeGroupsPayload]);
  const paletteItems =
    commandPaletteMode === "commands"
      ? commandItems
      : commandPaletteMode === "themes"
        ? themeItems
        : commandPaletteMode === "editors"
          ? editorItems
        : themeGroupCreateItems;
  const activeMetadataDialogFields = useMemo(() => {
    if (!fileDialog || fileDialog.mode === "delete") {
      return [];
    }

    const entryType = fileDialog.entryType;
    return createDialogContributions.flatMap((contribution) =>
      contribution.fields.filter(
        (field) => field.appliesTo === "both" || field.appliesTo === entryType
      )
    );
  }, [createDialogContributions, fileDialog]);
  const getCreateDialogMetadataDefaults = useCallback(
    (entryType: "file" | "directory") => {
      const defaults: Record<string, string> = {};

      for (const contribution of createDialogContributions) {
        for (const field of contribution.fields) {
          if (field.appliesTo !== "both" && field.appliesTo !== entryType) {
            continue;
          }

          defaults[field.id] = field.defaultValue ?? "";
        }
      }

      return defaults;
    },
    [createDialogContributions]
  );

  const requestWorkbenchKeyboardLock = useCallback(() => {
    const keyboardApi = (navigator as Navigator & {
      keyboard?: {
        lock: (codes?: string[]) => Promise<void>;
        unlock: () => void;
      };
    }).keyboard;

    if (!keyboardApi?.lock) {
      return;
    }

    const codes = ["KeyW", "PageUp", "PageDown", ...Array.from({ length: 9 }, (_, index) => `Digit${index + 1}`)];
    void keyboardApi.lock(codes).catch(() => undefined);
  }, []);

  const closeTextInputDialog = useCallback((value: string | null) => {
    textInputDialogResolveRef.current?.(value);
    textInputDialogResolveRef.current = null;
    setTextInputDialog(null);
  }, []);

  useEffect(() => {
    if (!textInputDialog) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      textInputDialogInputRef.current?.focus();
      textInputDialogInputRef.current?.select();
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [Boolean(textInputDialog)]);

  useEffect(() => {
    return () => {
      textInputDialogResolveRef.current?.(null);
      textInputDialogResolveRef.current = null;
    };
  }, []);

  const syncEditorValuePreservingView = useCallback((nextValue: string) => {
    const editor = editorRef.current;
    const model = editor?.getModel();

    if (!editor || !model || model.getValue() === nextValue) {
      return;
    }

    const selectionOffsets = (editor.getSelections() ?? []).map((selection) => ({
      selectionStartOffset: model.getOffsetAt({
        lineNumber: selection.selectionStartLineNumber,
        column: selection.selectionStartColumn
      }),
      positionOffset: model.getOffsetAt(selection.getPosition())
    }));
    const scrollTop = editor.getScrollTop();
    const scrollLeft = editor.getScrollLeft();
    const fullRange = model.getFullModelRange();

    editor.pushUndoStop();
    editor.executeEdits("workbench-sync-value", [
      {
        forceMoveMarkers: true,
        range: fullRange,
        text: nextValue
      }
    ]);
    editor.pushUndoStop();

    const nextModel = editor.getModel();

    if (nextModel && selectionOffsets.length > 0) {
      editor.setSelections(
        selectionOffsets.map(({ selectionStartOffset, positionOffset }) => {
          const nextSelectionStart = nextModel.getPositionAt(
            Math.min(selectionStartOffset, nextValue.length)
          );
          const nextPosition = nextModel.getPositionAt(Math.min(positionOffset, nextValue.length));

          return new monacoEditor.Selection(
            nextSelectionStart.lineNumber,
            nextSelectionStart.column,
            nextPosition.lineNumber,
            nextPosition.column
          );
        })
      );
    }

    editor.setScrollTop(scrollTop);
    editor.setScrollLeft(scrollLeft);
    editor.focus();
  }, []);

  const openRenameDialog = useCallback(
    async (targetNode: FileSystemNode) => {
      const baseMetadata =
        targetNode.type === "file" && targetNode.fileKind === "article" && targetNode.article
          ? {
              tags: targetNode.article.tags.join(", "),
              top: String(targetNode.article.top)
            }
          : {};

      const metadataPayload =
        targetNode.type === "directory"
          ? await api.getFileSystemMetadata(targetNode.path)
          : targetNode.type === "file" && targetNode.fileKind === "article"
            ? await api.getFileSystemMetadata(targetNode.path)
            : null;

      setFileDialog({
        entryType: targetNode.type === "directory" ? "directory" : "file",
        fileKind: targetNode.type === "file" ? targetNode.fileKind : undefined,
        mode: "rename",
        path: targetNode.path,
        value:
          targetNode.type === "file" && targetNode.fileKind === "article" && metadataPayload?.metadata.title
            ? String(metadataPayload.metadata.title)
            : targetNode.name,
        metadata: {
          ...getCreateDialogMetadataDefaults(targetNode.type === "directory" ? "directory" : "file"),
          ...baseMetadata,
          ...(metadataPayload?.metadata.tags
            ? { tags: Array.isArray(metadataPayload.metadata.tags) ? metadataPayload.metadata.tags.join(", ") : String(metadataPayload.metadata.tags) }
            : {}),
          ...(metadataPayload?.metadata.top !== undefined ? { top: String(metadataPayload.metadata.top) } : {})
        }
      });
    },
    [getCreateDialogMetadataDefaults]
  );
  const openFolderMetadataDialog = useCallback(
    async (targetNode: { type: "directory"; path: string; name: string }) => {
      const metadataPayload = await api.getFileSystemMetadata(targetNode.path);
      const rawMeta = metadataPayload.metadata ?? {};
      const knownKeys = ["tags", "title", "status", "top", "date", "summary", "slug", "password"];
      const extraEntries = Object.entries(rawMeta).filter(([k]) => !knownKeys.includes(k));
      setFolderMetadataDialog({
        path: targetNode.path,
        name: targetNode.name,
        tags: Array.isArray(rawMeta.tags) ? rawMeta.tags.join(", ") : String(rawMeta.tags ?? ""),
        title: String(rawMeta.title ?? ""),
        status: String(rawMeta.status ?? ""),
        top: String(rawMeta.top ?? ""),
        date: String(rawMeta.date ?? ""),
        summary: String(rawMeta.summary ?? ""),
        slug: String(rawMeta.slug ?? ""),
        password: String(rawMeta.password ?? ""),
        extraJson: extraEntries.length > 0 ? JSON.stringify(Object.fromEntries(extraEntries), null, 2) : ""
      });
    },
    []
  );
  const selectedTags = treePayload?.tags ?? [];

  const getDraftValue = useCallback(
    (document: WorkbenchDocument) => {
      if (document.id === activeDocumentId && canReadFullDocumentValueFromEditor(document)) {
        return editorRef.current?.getValue() ?? draftValuesRef.current[document.id] ?? document.savedValue;
      }

      return draftValuesRef.current[document.id] ?? document.savedValue;
    },
    [activeDocumentId]
  );

  const getRenderDraftValue = useCallback(
    (document: WorkbenchDocument) => draftValuesRef.current[document.id] ?? document.savedValue,
    []
  );

  const computeDocumentDirtyState = useCallback(
    (document: WorkbenchDocument, nextValue: string) =>
      pluginRuntime.getEditorContribution(document.editorId)?.isDirty?.(document, nextValue) ??
      nextValue !== document.savedValue,
    [pluginRuntime]
  );

  const scheduleDocumentDirtyCheck = useCallback(
    (documentId: string) => {
      if (dirtyCheckTimerRef.current !== null) {
        window.clearTimeout(dirtyCheckTimerRef.current);
      }

      dirtyCheckTimerRef.current = window.setTimeout(() => {
        dirtyCheckTimerRef.current = null;
        setDocuments((current) => {
          let changed = false;
          const nextDocuments = current.map((document) => {
            if (document.id !== documentId) {
              return document;
            }

            const nextValue = draftValuesRef.current[document.id] ?? document.savedValue;
            const shouldBeDirty = computeDocumentDirtyState(document, nextValue);
            if (document.dirty === shouldBeDirty) {
              return document;
            }

            changed = true;
            return { ...document, dirty: shouldBeDirty };
          });

          return changed ? nextDocuments : current;
        });
      }, DIRTY_CHECK_DEBOUNCE_MS);
    },
    [computeDocumentDirtyState]
  );

  const cancelPendingDirtyCheck = useCallback(() => {
    if (dirtyCheckTimerRef.current !== null) {
      window.clearTimeout(dirtyCheckTimerRef.current);
      dirtyCheckTimerRef.current = null;
    }
  }, []);

  const flushDocumentDraft = useCallback(
    (document: WorkbenchDocument | null = activeDocument) => {
      if (!document || !canReadFullDocumentValueFromEditor(document)) {
        return null;
      }

      const editor = editorRef.current;
      if (!editor || activeDocumentIdRef.current !== document.id) {
        return null;
      }

      if (draftValueSyncTimerRef.current !== null) {
        window.clearTimeout(draftValueSyncTimerRef.current);
        draftValueSyncTimerRef.current = null;
      }

      const nextValue = editor.getValue();
      draftValuesRef.current[document.id] = nextValue;
      const shouldBeDirty = computeDocumentDirtyState(document, nextValue);
      if (shouldBeDirty) {
        dirtyDocumentIdsRef.current.add(document.id);
      } else {
        dirtyDocumentIdsRef.current.delete(document.id);
      }
      setDocuments((current) => {
        let changed = false;
        const nextDocuments = current.map((currentDocument) => {
          if (currentDocument.id !== document.id || currentDocument.dirty === shouldBeDirty) {
            return currentDocument;
          }

          changed = true;
          return { ...currentDocument, dirty: shouldBeDirty };
        });

        return changed ? nextDocuments : current;
      });
      return nextValue;
    },
    [activeDocument, computeDocumentDirtyState]
  );

  const activateDocument = useCallback(
    (nextDocumentIdOrUpdater: SetStateAction<string | null>) => {
      flushDocumentDraft();
      setActiveDocumentId(nextDocumentIdOrUpdater);
    },
    [flushDocumentDraft]
  );

  const flushArticleCursorStates = useCallback(() => {
    try {
      window.localStorage.setItem(
        ARTICLE_CURSOR_STATE_STORAGE_KEY,
        JSON.stringify(articleCursorStatesRef.current)
      );
    } catch {
      // Ignore storage failures and keep the in-memory cursor state.
    }
  }, []);

  const scheduleArticleCursorStatePersist = useCallback(() => {
    if (articleCursorPersistTimerRef.current !== null) {
      return;
    }

    articleCursorPersistTimerRef.current = window.setTimeout(() => {
      articleCursorPersistTimerRef.current = null;
      flushArticleCursorStates();
    }, 120);
  }, [flushArticleCursorStates]);

  const storeArticleCursorState = useCallback(
    (articlePath: string) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const position = editor?.getPosition();

      if (!editor || !model || !position) {
        return;
      }

      const lineNumber = Math.max(1, Math.min(position.lineNumber, model.getLineCount()));
      const maxColumn = model.getLineMaxColumn(lineNumber);
      const column = Math.max(1, Math.min(position.column, maxColumn));

      articleCursorStatesRef.current[articlePath] = {
        lineNumber,
        column,
        scrollTop: editor.getScrollTop(),
        scrollLeft: editor.getScrollLeft()
      };
      if (lastStoredArticleLineNumberRef.current !== lineNumber) {
        lastStoredArticleLineNumberRef.current = lineNumber;
        setActiveArticleLineNumber(lineNumber);
      }
      scheduleArticleCursorStatePersist();
    },
    [scheduleArticleCursorStatePersist]
  );

  const remapStoredArticleCursorStates = useCallback(
    (fromPath: string, toPath: string) => {
      articleCursorStatesRef.current = remapArticleCursorStates(
        articleCursorStatesRef.current,
        fromPath,
        toPath
      );
      scheduleArticleCursorStatePersist();
    },
    [scheduleArticleCursorStatePersist]
  );

  const discardStoredArticleCursorStates = useCallback(
    (targetPath: string) => {
      articleCursorStatesRef.current = removeArticleCursorStates(
        articleCursorStatesRef.current,
        targetPath
      );
      scheduleArticleCursorStatePersist();
    },
    [scheduleArticleCursorStatePersist]
  );

  const jumpToActiveArticleLine = useCallback(
    (lineNumber: number, options?: RevealLineOptions) => {
      if (!isArticleDocument(activeDocument)) {
        return;
      }

      const editor = editorRef.current;
      const model = editor?.getModel();
      if (!editor || !model) {
        return;
      }

      const nextLineNumber = Math.max(1, Math.min(lineNumber, model.getLineCount()));
      const currentPosition = editor.getPosition();
      const firstContentColumn = model.getLineFirstNonWhitespaceColumn(nextLineNumber);
      const defaultColumn = Math.min(
        Math.max(1, firstContentColumn > 0 ? firstContentColumn : 1),
        model.getLineMaxColumn(nextLineNumber)
      );
      const nextColumn = Math.max(
        1,
        Math.min(options?.column ?? defaultColumn, model.getLineMaxColumn(nextLineNumber))
      );
      const shouldMoveCursor = options?.moveCursor ?? true;
      const shouldFocus = options?.focus ?? true;

      if (shouldMoveCursor) {
        const selection = new monacoEditor.Selection(
          nextLineNumber,
          nextColumn,
          nextLineNumber,
          nextColumn
        );

        editor.setSelection(selection);
        editor.setPosition({ lineNumber: nextLineNumber, column: nextColumn });
      } else {
        suppressPreviewFollowFromEditorScrollRef.current = true;
      }
      editor.revealLineInCenter(nextLineNumber);
      if (shouldFocus) {
        editor.focus();
      }
      lastStoredArticleLineNumberRef.current = shouldMoveCursor ? nextLineNumber : currentPosition?.lineNumber ?? nextLineNumber;
      setActiveArticleLineNumber(shouldMoveCursor ? nextLineNumber : currentPosition?.lineNumber ?? nextLineNumber);

      window.requestAnimationFrame(() => {
        if (shouldMoveCursor) {
          storeArticleCursorState(activeDocument.articlePath);
          schedulePreviewCursorSyncRef.current?.();
        }
      });
    },
    [activeDocument, storeArticleCursorState]
  );

  const attachPreviewRef = useCallback((node: HTMLDivElement | null) => {
    previewRef.current = node;
    setPreviewReadyVersion((current) => current + 1);
  }, []);

  const attachPreviewSurfaceRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      previewShadowHeadRef.current = null;
      previewProseRef.current = null;
      previewBlocksRef.current = [];
      setPreviewReadyVersion((current) => current + 1);
      return;
    }

    const shadowRoot = node.shadowRoot ?? node.attachShadow({ mode: "open" });
    const baseStyle = document.createElement("style");
    baseStyle.textContent = PREVIEW_SHADOW_BASE_CSS;

    const externalStylesHost = document.createElement("div");
    const htmlElement = document.createElement("html");
    const bodyElement = document.createElement("body");
    const proseElement = document.createElement("div");
    proseElement.className = "prose preview-prose";
    bodyElement.appendChild(proseElement);
    htmlElement.appendChild(bodyElement);

    shadowRoot.replaceChildren(baseStyle, externalStylesHost, htmlElement);
    previewShadowHeadRef.current = externalStylesHost;
    previewProseRef.current = proseElement;
    previewBlocksRef.current = [];
    setPreviewReadyVersion((current) => current + 1);
  }, []);

  const schedulePreviewSourceUpdate = useCallback((nextValue: string, options?: { immediate?: boolean }) => {
    if (previewUpdateTimerRef.current !== null) {
      window.clearTimeout(previewUpdateTimerRef.current);
      previewUpdateTimerRef.current = null;
    }

    if (options?.immediate) {
      setPreviewSourceText(nextValue);
      return;
    }

    previewUpdateTimerRef.current = window.setTimeout(() => {
      setPreviewSourceText(nextValue);
      previewUpdateTimerRef.current = null;
    }, PREVIEW_UPDATE_DEBOUNCE_MS);
  }, []);

  const scheduleDocumentPreviewUpdate = useCallback(
    (document: WorkbenchDocument, nextValue: string, options?: { immediate?: boolean }) => {
      if (!previewPaneVisible) {
        return;
      }

      const update = () => {
        const contribution = pluginRuntime.getEditorContribution(document.editorId);
        if (!contribution?.supportsPreview) {
          schedulePreviewSourceUpdate("", { immediate: true });
          return;
        }

        const nextPreviewBody = contribution.previewSource?.(document, nextValue);
        schedulePreviewSourceUpdate(
          typeof nextPreviewBody === "string" ? nextPreviewBody : "",
          { immediate: true }
        );
      };

      if (previewUpdateTimerRef.current !== null) {
        window.clearTimeout(previewUpdateTimerRef.current);
        previewUpdateTimerRef.current = null;
      }

      if (options?.immediate) {
        update();
        return;
      }

      previewUpdateTimerRef.current = window.setTimeout(() => {
        previewUpdateTimerRef.current = null;
        update();
      }, DRAFT_VALUE_SYNC_DEBOUNCE_MS);
    },
    [pluginRuntime, previewPaneVisible, schedulePreviewSourceUpdate]
  );

  const scheduleDraftValueSync = useCallback(
    (document: WorkbenchDocument) => {
      const editor = editorRef.current;
      if (!editor) {
        return;
      }

      if (draftValueSyncTimerRef.current !== null) {
        window.clearTimeout(draftValueSyncTimerRef.current);
      }

      draftValueSyncTimerRef.current = window.setTimeout(() => {
        draftValueSyncTimerRef.current = null;
        if (activeDocumentIdRef.current !== document.id) {
          return;
        }

        const nextValue = editor.getValue();
        draftValuesRef.current[document.id] = nextValue;
        scheduleDocumentDirtyCheck(document.id);
        if (previewPaneVisible) {
          scheduleDocumentPreviewUpdate(document, nextValue);
        }
      }, PREVIEW_UPDATE_DEBOUNCE_MS);
    },
    [previewPaneVisible, scheduleDocumentDirtyCheck, scheduleDocumentPreviewUpdate]
  );

  const openPalette = (mode: "commands" | "editors" | "themeGroupCreate" | "themes") => {
    setCommandPaletteMode(mode);
    setCommandQuery("");
    setSelectedPaletteIndex(0);
    setCommandPaletteOpen(true);
  };

  const startResize = useCallback(
    (mode: "sidebar" | "preview", startClientX: number) => {
      const initialSidebarWidth = sidebarWidth;
      const initialPreviewWidth = previewWidth;

      const handlePointerMove = (event: PointerEvent) => {
        if (mode === "sidebar") {
          setSidebarWidth(Math.max(220, Math.min(520, initialSidebarWidth + (event.clientX - startClientX))));
        } else {
          setPreviewWidth(Math.max(280, Math.min(760, initialPreviewWidth - (event.clientX - startClientX))));
        }
      };

      const handlePointerUp = () => {
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
      };

      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
    },
    [previewWidth, sidebarWidth]
  );

  const loadTree = async () => {
    const payload = await api.getTree();
    startTransition(() => {
      setTreePayload(payload);
    });
    return payload;
  };

  const loadConfig = async () => {
    const payload = await api.getEditorConfig();
    startTransition(() => {
      setConfigPayload(payload);
    });
    return payload;
  };

  const loadSiteConfig = async () => {
    const payload = await api.getSiteConfig();
    startTransition(() => {
      setSiteConfigPayload(payload);
    });
    return payload;
  };

  const loadPublishConfig = async () => {
    const payload = await api.getPublishConfig();
    startTransition(() => {
      setPublishConfigPayload(payload);
    });
    return payload;
  };

  const loadMarkdownBlockConfig = async () => {
    const payload = await api.getMarkdownBlockConfig();
    startTransition(() => {
      setMarkdownBlockConfigPayload(payload);
    });
    return payload;
  };

  const loadUsageStats = async () => {
    const payload = await api.getUsageStats();
    startTransition(() => {
      setUsageStatsPayload(payload);
      setDocuments((current) =>
        current.map((document) =>
          document.kind === "usageStats"
            ? withResolvedEditor(buildUsageStatsDocument(payload), document.editorId)
            : document
        )
      );
    });
    return payload;
  };

  const loadProjects = async () => {
    const payload = await api.listProjects();
    startTransition(() => {
      setProjectsPayload(payload);
    });
    return payload;
  };

  const loadAdminHomeConfig = async () => {
    const payload = await api.getAdminHomeConfig();
    startTransition(() => {
      setAdminHomePayload(payload);
    });
    return payload;
  };

  const loadThemeGroups = async () => {
    const payload = await api.listThemeGroups();
    startTransition(() => {
      setThemeGroupsPayload(payload);
    });
    return payload;
  };

  const updateAdminHomeConfigValue = useCallback((nextValue: AdminHomeConfigPayload["value"]) => {
    const normalizedValue = normalizeAdminHomeConfig(nextValue);
    const raw = `${JSON.stringify(normalizedValue, null, 2)}\n`;

    setAdminHomePayload({
      raw,
      value: normalizedValue
    });

    if (adminHomeSaveTimerRef.current !== null) {
      window.clearTimeout(adminHomeSaveTimerRef.current);
      adminHomeSaveTimerRef.current = null;
    }

    adminHomeSaveTimerRef.current = window.setTimeout(() => {
      api.saveAdminHomeConfig(raw)
        .then((savedPayload) => {
          setAdminHomePayload(savedPayload);
          setPageError(null);
        })
        .catch((error: Error) => {
          setPageError(error.message);
        })
        .finally(() => {
          adminHomeSaveTimerRef.current = null;
        });
    }, 220);
  }, []);

  const flushUsageStats = useCallback(async () => {
    if (!authenticated) {
      return null;
    }

    if (usageStatsFlushTimerRef.current !== null) {
      window.clearTimeout(usageStatsFlushTimerRef.current);
      usageStatsFlushTimerRef.current = null;
    }

    const activeMilliseconds = usageStatsPendingActiveMsRef.current;
    const documents = [...usageStatsPendingDocumentDeltaRef.current.values()].filter(
      (entry) => entry.netCharacterDelta !== 0
    );

    if (activeMilliseconds <= 0 && documents.length === 0) {
      return null;
    }

    usageStatsPendingActiveMsRef.current = 0;
    usageStatsPendingDocumentDeltaRef.current = new Map();

    const payload = await api.recordUsageStats({
      activeMilliseconds,
      documents
    });

    startTransition(() => {
      setUsageStatsPayload(payload);
      setDocuments((current) =>
        current.map((document) =>
          document.kind === "usageStats"
            ? withResolvedEditor(buildUsageStatsDocument(payload), document.editorId)
            : document
        )
      );
    });

    return payload;
  }, [authenticated, withResolvedEditor]);

  const scheduleUsageStatsFlush = useCallback(() => {
    if (!authenticated) {
      return;
    }

    if (usageStatsFlushTimerRef.current !== null) {
      return;
    }

    usageStatsFlushTimerRef.current = window.setTimeout(() => {
      void flushUsageStats().catch((error: Error) => {
        setPageError(error.message);
      });
    }, USAGE_STATS_FLUSH_DEBOUNCE_MS);
  }, [authenticated, flushUsageStats]);

  const queueUsageDocumentDelta = useCallback(
    (document: WorkbenchDocument, netCharacterDelta: number) => {
      if (!authenticated || netCharacterDelta === 0 || document.kind === "home" || document.kind === "usageStats") {
        return;
      }

      const current =
        usageStatsPendingDocumentDeltaRef.current.get(document.id) ?? {
          documentId: document.id,
          documentKind: document.kind,
          title: document.title,
          netCharacterDelta: 0
        };

      usageStatsPendingDocumentDeltaRef.current.set(document.id, {
        ...current,
        documentKind: document.kind,
        title: document.title,
        netCharacterDelta: current.netCharacterDelta + netCharacterDelta
      });
      scheduleUsageStatsFlush();
    },
    [authenticated, scheduleUsageStatsFlush]
  );

  const markUsageActivity = useCallback(() => {
    if (!authenticated) {
      return;
    }

    const now = Date.now();
    const previous = usageStatsLastInteractionAtRef.current;
    usageStatsLastInteractionAtRef.current = now;

    if (previous === null) {
      return;
    }

    const elapsed = now - previous;
    if (elapsed <= 0 || elapsed > USAGE_STATS_ACTIVITY_IDLE_MS) {
      return;
    }

    usageStatsPendingActiveMsRef.current += elapsed;
    scheduleUsageStatsFlush();
  }, [authenticated, scheduleUsageStatsFlush]);

  const openArticleDocument = async (articlePath: string, preferredEditorId?: WorkbenchEditorId) => {
    const existingDocument = documents.find((document) => document.kind === "article" && document.articlePath === articlePath);
    if (existingDocument) {
      if (preferredEditorId && existingDocument.editorId !== preferredEditorId) {
        setDocuments((current) =>
          current.map((document) =>
            document.id === existingDocument.id
              ? {
                  ...document,
                  editorId: resolveDocumentEditorId(document, preferredEditorId)
                }
              : document
          )
        );
      }
      activateDocument(existingDocument.id);
      setSelectedTreePath(articlePath);
      return;
    }
    const article = await api.getArticle(articlePath);
    const articleDocument = withResolvedEditor(buildArticleDocument(article), preferredEditorId);
    draftValuesRef.current[articleDocument.id] = articleDocument.value;
    setDocuments((current) => upsertDocument(current, articleDocument));
    activateDocument(articleDocument.id);
    setSelectedTreePath(articlePath);
  };

  const refreshOpenArticleDocuments = useCallback(
    async (changedPaths: string[]) => {
      const normalizedPaths = Array.from(new Set(changedPaths));
      if (normalizedPaths.length === 0) {
        return;
      }

      const openCleanArticles = documents.filter(
        (document): document is ArticleWorkbenchDocument =>
          document.kind === "article" &&
          !document.dirty &&
          normalizedPaths.includes(document.articlePath)
      );
      if (openCleanArticles.length === 0) {
        return;
      }

      const refreshedEntries = await Promise.all(
        openCleanArticles.map(async (document) => ({
          documentId: document.id,
          editorId: document.editorId,
          payload: await api.getArticle(document.articlePath)
        }))
      );

      const refreshedById = new Map(
        refreshedEntries.map(({ documentId, editorId, payload }) => [
          documentId,
          withResolvedEditor(buildArticleDocument(payload), editorId)
        ])
      );

      for (const nextDocument of refreshedById.values()) {
        draftValuesRef.current[nextDocument.id] = nextDocument.value;
      }

      setDocuments((current) =>
        current.map((document) => refreshedById.get(document.id) ?? document)
      );

      if (activeDocument && activeDocument.kind === "article") {
        const refreshedActiveDocument = refreshedById.get(activeDocument.id);
        if (refreshedActiveDocument) {
          syncEditorValuePreservingView(refreshedActiveDocument.value);
          schedulePreviewSourceUpdate(refreshedActiveDocument.value, { immediate: true });
        }
      }
    },
    [activeDocument, documents, schedulePreviewSourceUpdate, syncEditorValuePreservingView, withResolvedEditor]
  );

  const applySavedThemeGroupsPayload = (savedPayload: ThemeGroupsPayload) => {
    setThemeGroupsPayload(savedPayload);
    setRenderStyleAssetVersion((current) => current + 1);
  };

  const refreshThemeGroupsPayload = async () => {
    const payload = await api.listThemeGroups();
    applySavedThemeGroupsPayload(payload);
    return payload;
  };

  const openThemeAssetDocument = async (
    groupId: string,
    fileName: string,
    preferredEditorId?: WorkbenchEditorId
  ) => {
    try {
      const existingDocument = documents.find(
        (document) =>
          document.kind === "themeAsset" &&
          document.groupId === groupId &&
          document.fileName === fileName
      );
      if (existingDocument) {
        if (preferredEditorId && existingDocument.editorId !== preferredEditorId) {
          setDocuments((current) =>
            current.map((document) =>
              document.id === existingDocument.id
                ? {
                    ...document,
                    editorId: resolveDocumentEditorId(document, preferredEditorId)
                  }
                : document
            )
          );
        }
        activateDocument(existingDocument.id);
        return;
      }

      const payload = await api.getThemeAsset(groupId, fileName);
      const nextDocument = withResolvedEditor(buildThemeAssetDocument(payload), preferredEditorId);
      draftValuesRef.current[nextDocument.id] = nextDocument.value;
      setDocuments((current) => upsertDocument(current, nextDocument));
      activateDocument(nextDocument.id);
      setPageError(null);
    } catch (error) {
      setPageError((error as Error).message);
    }
  };

  const openThemeGroupConfigDocument = async (
    groupId: string,
    preferredEditorId?: WorkbenchEditorId
  ) => {
    try {
      const existingDocument = documents.find(
        (document) =>
          document.kind === "themeAsset" &&
          document.groupId === groupId &&
          document.fileName === "theme.json"
      );
      if (existingDocument) {
        if (preferredEditorId && existingDocument.editorId !== preferredEditorId) {
          setDocuments((current) =>
            current.map((document) =>
              document.id === existingDocument.id
                ? {
                    ...document,
                    editorId: resolveDocumentEditorId(document, preferredEditorId)
                  }
                : document
            )
          );
        }
        activateDocument(existingDocument.id);
        return;
      }

      const payload = await api.getThemeGroup(groupId);
      const nextDocument = withResolvedEditor(buildThemeAssetDocument({
        adminPreview: false,
        assetPath: `${payload.groupId}/theme.json`,
        fileName: "theme.json",
        groupId: payload.groupId,
        language: "json",
        raw: payload.raw,
        type: "js"
      }), preferredEditorId);
      draftValuesRef.current[nextDocument.id] = nextDocument.value;
      setDocuments((current) => upsertDocument(current, nextDocument));
      activateDocument(nextDocument.id);
      setPageError(null);
    } catch (error) {
      setPageError((error as Error).message);
    }
  };

  const openProjectDocument = async (projectId: string, preferredEditorId?: WorkbenchEditorId) => {
    try {
      const existingDocument = documents.find(
        (document) => document.kind === "project" && document.projectId === projectId
      );
      if (existingDocument) {
        if (preferredEditorId && existingDocument.editorId !== preferredEditorId) {
          setDocuments((current) =>
            current.map((document) =>
              document.id === existingDocument.id
                ? {
                    ...document,
                    editorId: resolveDocumentEditorId(document, preferredEditorId)
                  }
                : document
            )
          );
        }
        activateDocument(existingDocument.id);
        setSidebarGroupId(PROJECT_MODULE_ID);
        return;
      }

      const payload = await api.getProject(projectId);
      const nextDocument = withResolvedEditor(buildProjectDocument(payload), preferredEditorId);
      draftValuesRef.current[nextDocument.id] = nextDocument.value;
      setDocuments((current) => upsertDocument(current, nextDocument));
      activateDocument(nextDocument.id);
      setSidebarGroupId(PROJECT_MODULE_ID);
      setPageError(null);
    } catch (error) {
      setPageError((error as Error).message);
    }
  };

  const openProjectTaskDocument = async (
    projectId: string,
    taskId: string,
    preferredEditorId?: WorkbenchEditorId
  ) => {
    try {
      const existingDocument = documents.find(
        (document) =>
          document.kind === "projectTask" &&
          document.projectId === projectId &&
          document.taskId === taskId
      );
      if (existingDocument) {
        if (preferredEditorId && existingDocument.editorId !== preferredEditorId) {
          setDocuments((current) =>
            current.map((document) =>
              document.id === existingDocument.id
                ? {
                    ...document,
                    editorId: resolveDocumentEditorId(document, preferredEditorId)
                  }
                : document
            )
          );
        }
        activateDocument(existingDocument.id);
        setSidebarGroupId(PROJECT_MODULE_ID);
        return;
      }

      const payload = await api.getProjectTask(projectId, taskId);
      const nextDocument = withResolvedEditor(buildProjectTaskDocument(payload), preferredEditorId);
      draftValuesRef.current[nextDocument.id] = nextDocument.value;
      setDocuments((current) => upsertDocument(current, nextDocument));
      activateDocument(nextDocument.id);
      setSidebarGroupId(PROJECT_MODULE_ID);
      setPageError(null);
    } catch (error) {
      setPageError((error as Error).message);
    }
  };

  const openProjectLogDocument = async (
    projectId: string,
    logId: string,
    preferredEditorId?: WorkbenchEditorId
  ) => {
    try {
      const existingDocument = documents.find(
        (document) =>
          document.kind === "projectLog" &&
          document.projectId === projectId &&
          document.logId === logId
      );
      if (existingDocument) {
        if (preferredEditorId && existingDocument.editorId !== preferredEditorId) {
          setDocuments((current) =>
            current.map((document) =>
              document.id === existingDocument.id
                ? {
                    ...document,
                    editorId: resolveDocumentEditorId(document, preferredEditorId)
                  }
                : document
            )
          );
        }
        activateDocument(existingDocument.id);
        setSidebarGroupId(PROJECT_MODULE_ID);
        return;
      }

      const payload = await api.getProjectLog(projectId, logId);
      const nextDocument = withResolvedEditor(buildProjectLogDocument(payload), preferredEditorId);
      draftValuesRef.current[nextDocument.id] = nextDocument.value;
      setDocuments((current) => upsertDocument(current, nextDocument));
      activateDocument(nextDocument.id);
      setSidebarGroupId(PROJECT_MODULE_ID);
      setPageError(null);
    } catch (error) {
      setPageError((error as Error).message);
    }
  };

  const saveProjectWorkbenchDocument = async () => {
    if (!isProjectDocument(activeDocument)) {
      return;
    }

    const raw = getDraftValue(activeDocument);
    const savedPayload = await api.saveProject(activeDocument.projectId, raw);
    const savedDocument = withResolvedEditor(
      buildProjectDocument(savedPayload),
      activeDocument.editorId
    );
    draftValuesRef.current[savedDocument.id] = savedDocument.value;
    setDocuments((current) => upsertDocument(current, savedDocument));
    setActiveDocumentId(savedDocument.id);
    await loadProjects();
  };

  const saveProjectTaskWorkbenchDocument = async () => {
    if (!isProjectTaskDocument(activeDocument)) {
      return;
    }

    const raw = getDraftValue(activeDocument);
    const savedPayload = await api.saveProjectTask(activeDocument.projectId, activeDocument.taskId, raw);
    const savedDocument = withResolvedEditor(
      buildProjectTaskDocument(savedPayload),
      activeDocument.editorId
    );
    draftValuesRef.current[savedDocument.id] = savedDocument.value;
    setDocuments((current) => upsertDocument(current, savedDocument));
    setActiveDocumentId(savedDocument.id);
    await loadProjects();
  };

  const saveProjectLogWorkbenchDocument = async () => {
    if (!isProjectLogDocument(activeDocument)) {
      return;
    }

    const raw = getDraftValue(activeDocument);
    const savedPayload = await api.saveProjectLog(activeDocument.projectId, activeDocument.logId, raw);
    const savedDocument = withResolvedEditor(
      buildProjectLogDocument(savedPayload),
      activeDocument.editorId
    );
    draftValuesRef.current[savedDocument.id] = savedDocument.value;
    setDocuments((current) => upsertDocument(current, savedDocument));
    setActiveDocumentId(savedDocument.id);
    await loadProjects();
  };

  const saveThemeAssetDocument = async () => {
    if (!isThemeAssetDocument(activeDocument)) {
      return;
    }

    const raw = editorRef.current?.getValue() ?? getDraftValue(activeDocument);
    if (activeDocument.fileName === "theme.json") {
      await api.saveThemeGroup(activeDocument.groupId, raw);
      await refreshThemeGroupsPayload();
      await openThemeGroupConfigDocument(activeDocument.groupId);
      return;
    }

    const savedPayload = await api.saveThemeAsset(activeDocument.groupId, activeDocument.fileName, raw);
    const savedDocument = withResolvedEditor(
      buildThemeAssetDocument(savedPayload),
      activeDocument.editorId
    );
    draftValuesRef.current[savedDocument.id] = savedDocument.value;
    setDocuments((current) => upsertDocument(current, savedDocument));
    setActiveDocumentId(savedDocument.id);
    await refreshThemeGroupsPayload();
  };

  const createThemeGroupDocument = async (groupId: string) => {
    const normalizedGroupId = normalizeThemeGroupId(groupId);
    if (!normalizedGroupId) {
      return;
    }

    setBusyMessage(`Creating ${normalizedGroupId}...`);
    try {
      await api.createThemeGroup(normalizedGroupId);
      await refreshThemeGroupsPayload();
      await openThemeGroupConfigDocument(normalizedGroupId);
      setPageError(null);
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setBusyMessage(null);
    }
  };

  const executeFileDialogOperation = async (
    dialog: NonNullable<typeof fileDialog>,
    options?: { allowDuplicateTitle?: boolean }
  ) => {
    if (dialog.mode === "create-file" || dialog.mode === "create-directory") {
      const result = await api.createFileSystemEntry(
        dialog.path,
        dialog.mode === "create-file" ? "file" : "directory",
        dialog.entryType === "file" && dialog.fileKind === "article"
          ? deriveArticleFileName(dialog.value)
          : dialog.value,
        dialog.entryType === "file" && dialog.fileKind === "article"
          ? {
              ...dialog.metadata,
              title: dialog.value
            }
          : dialog.metadata,
        {
          allowDuplicateTitle: options?.allowDuplicateTitle
        }
      );
      await loadTree();
      setSelectedTreePath(result.path);
      if (result.path.toLowerCase().endsWith(".md")) {
        await openArticleDocument(result.path);
      }
      return;
    }

    if (dialog.mode === "rename") {
      const result = await api.renameFileSystemEntry(
        dialog.path,
        dialog.entryType === "file" && dialog.fileKind === "article"
          ? deriveArticleFileName(dialog.value)
          : dialog.value,
        dialog.entryType === "file" && dialog.fileKind === "article"
          ? {
              allowDuplicateTitle: options?.allowDuplicateTitle,
              title: dialog.value
            }
          : undefined
      );
      // For directories, the rename dialog only carries its editable fields
      // (tags/top). Merge with the folder's existing metadata so renaming does
      // not silently drop status/password/summary/etc.
      const renameMetadataBase =
        dialog.entryType === "directory"
          ? (await api.getFileSystemMetadata(result.path)).metadata
          : {};
      await api.saveFileSystemMetadata(result.path, {
        ...renameMetadataBase,
        ...dialog.metadata,
        ...(dialog.entryType === "file" && dialog.fileKind === "article"
          ? { title: dialog.value }
          : {})
      });
      await loadTree();
      setDocuments((current) => remapDocuments(current, dialog.path, result.path));
      remapStoredArticleCursorStates(dialog.path, result.path);
      setCollapsedTreePaths((current) => remapCollapsedTreePaths(current, dialog.path, result.path));
      setSelectedTreePath(result.path);
      if (dialog.entryType === "file" && dialog.fileKind === "article") {
        const updatedArticle = await api.getArticle(result.path);
        const updatedDocument = buildArticleDocument(updatedArticle);
        draftValuesRef.current[updatedDocument.id] = updatedDocument.value;
        setDocuments((current) => upsertDocument(remapDocuments(current, dialog.path, result.path), updatedDocument));
        activateDocument(updatedDocument.id);
        syncEditorValuePreservingView(updatedDocument.value);
        schedulePreviewSourceUpdate(updatedDocument.value, { immediate: true });
      }
      return;
    }

    await api.deleteFileSystemEntry(dialog.path);
    await loadTree();
    setDocuments((current) => removeDocuments(current, dialog.path));
    draftValuesRef.current = removeArticleDraftValues(draftValuesRef.current, dialog.path);
    discardStoredArticleCursorStates(dialog.path);
    setCollapsedTreePaths((current) => removeCollapsedTreePaths(current, dialog.path));
    activateDocument((current) =>
      current?.startsWith("article:") && matchesPathPrefix(current.slice("article:".length), dialog.path)
        ? HOME_DOCUMENT_ID
        : current
    );
    setSelectedTreePath(null);
  };

  const openConfigDocument = async (kind: ConfigDocumentKind, preferredEditorId?: WorkbenchEditorId) => {
    const existingDocument = documents.find((document) => document.kind === "config" && document.configKind === kind);
    if (existingDocument) {
      if (preferredEditorId && existingDocument.editorId !== preferredEditorId) {
        setDocuments((current) =>
          current.map((document) =>
            document.id === existingDocument.id
              ? {
                  ...document,
                  editorId: resolveDocumentEditorId(document, preferredEditorId)
                }
              : document
          )
        );
      }
      activateDocument(existingDocument.id);
      return;
    }
    const payload =
      kind === "markdownBlockConfig"
        ? markdownBlockConfigPayload ?? (await loadMarkdownBlockConfig())
        : kind === "publishConfig"
        ? publishConfigPayload ?? (await loadPublishConfig())
        : kind === "siteConfig"
        ? siteConfigPayload ?? (await loadSiteConfig())
        : configPayload ?? (await loadConfig());
    const document = withResolvedEditor(buildConfigDocument(kind, payload), preferredEditorId);
    draftValuesRef.current[document.id] = document.value;
    setDocuments((current) => upsertDocument(current, document));
    activateDocument(document.id);
  };

  const refreshWorkspace = async () => {
    await Promise.all([
      loadTree(),
      loadConfig(),
      loadMarkdownBlockConfig(),
      loadUsageStats(),
      loadProjects(),
      loadAdminHomeConfig(),
      loadThemeGroups(),
      loadPublishConfig(),
      loadSiteConfig()
    ]);
    setDocuments((current) => (current.some((document) => document.kind === "home") ? current : [buildHomeDocument(), ...current]));
    activateDocument((current) => current ?? HOME_DOCUMENT_ID);
  };

  const saveConfigDocuments = async () => {
    const editorAssociationsDocument = documents.find(
      (document) => document.kind === "config" && document.configKind === "editorAssociations"
    );
    const markdownSnippetsDocument = documents.find((document) => document.kind === "config" && document.configKind === "markdownSnippets");
    const latexSnippetsDocument = documents.find((document) => document.kind === "config" && document.configKind === "latexSnippets");
    const keybindingsDocument = documents.find((document) => document.kind === "config" && document.configKind === "keybindings");
    const savedPayload = await api.saveEditorConfig(
      (markdownSnippetsDocument ? getDraftValue(markdownSnippetsDocument) : undefined) ?? configPayload?.markdownSnippetsRaw ?? emptyConfigPayload.markdownSnippetsRaw,
      (latexSnippetsDocument ? getDraftValue(latexSnippetsDocument) : undefined) ?? configPayload?.latexSnippetsRaw ?? emptyConfigPayload.latexSnippetsRaw,
      (keybindingsDocument ? getDraftValue(keybindingsDocument) : undefined) ?? configPayload?.keybindingsRaw ?? emptyConfigPayload.keybindingsRaw,
      (editorAssociationsDocument ? getDraftValue(editorAssociationsDocument) : undefined) ?? configPayload?.editorAssociationsRaw ?? emptyConfigPayload.editorAssociationsRaw
    );
    setConfigPayload(savedPayload);
    setDocuments((current) =>
      current.map((document) => {
        if (
          document.kind !== "config" ||
          (document.configKind !== "markdownSnippets" &&
            document.configKind !== "editorAssociations" &&
            document.configKind !== "latexSnippets" &&
            document.configKind !== "keybindings")
        ) {
          return document;
        }
        const nextValue = CONFIG_DOCUMENT_META[document.configKind].read(savedPayload);
        return { ...document, value: nextValue, savedValue: nextValue, dirty: false };
      })
    );
    draftValuesRef.current["config:editorAssociations"] = savedPayload.editorAssociationsRaw;
    draftValuesRef.current["config:markdownSnippets"] = savedPayload.markdownSnippetsRaw;
    draftValuesRef.current["config:latexSnippets"] = savedPayload.latexSnippetsRaw;
    draftValuesRef.current["config:keybindings"] = savedPayload.keybindingsRaw;
  };

  const saveSiteConfigDocument = async () => {
    const siteConfigDocument = documents.find(
      (document) => document.kind === "config" && document.configKind === "siteConfig"
    );
    const raw = (siteConfigDocument ? getDraftValue(siteConfigDocument) : undefined) ?? siteConfigPayload?.raw;

    if (typeof raw !== "string") {
      return;
    }

    const savedPayload = await api.saveSiteConfig(raw);
    setSiteConfigPayload(savedPayload);
    setDocuments((current) =>
      current.map((document) =>
        document.kind === "config" && document.configKind === "siteConfig"
          ? {
              ...document,
              value: savedPayload.raw,
              savedValue: savedPayload.raw,
              dirty: false
            }
          : document
      )
    );
    draftValuesRef.current["config:siteConfig"] = savedPayload.raw;
  };

  const savePublishConfigDocument = async () => {
    const publishConfigDocument = documents.find(
      (document) => document.kind === "config" && document.configKind === "publishConfig"
    );
    const raw = (publishConfigDocument ? getDraftValue(publishConfigDocument) : undefined) ?? publishConfigPayload?.raw;

    if (typeof raw !== "string") {
      return;
    }

    const savedPayload = await api.savePublishConfig(raw);
    setPublishConfigPayload(savedPayload);
    setDocuments((current) =>
      current.map((document) =>
        document.kind === "config" && document.configKind === "publishConfig"
          ? {
              ...document,
              value: savedPayload.raw,
              savedValue: savedPayload.raw,
              dirty: false
            }
          : document
      )
    );
    draftValuesRef.current["config:publishConfig"] = savedPayload.raw;
  };

  const saveMarkdownBlockConfigDocument = async () => {
    const markdownBlockDocument = documents.find(
      (document) => document.kind === "config" && document.configKind === "markdownBlockConfig"
    );
    const raw =
      (markdownBlockDocument ? getDraftValue(markdownBlockDocument) : undefined) ??
      markdownBlockConfigPayload?.raw;

    if (typeof raw !== "string") {
      return;
    }

    const savedPayload = await api.saveMarkdownBlockConfig(raw);
    setMarkdownBlockConfigPayload(savedPayload);
    setDocuments((current) =>
      current.map((document) =>
        document.kind === "config" && document.configKind === "markdownBlockConfig"
          ? {
              ...document,
              value: savedPayload.raw,
              savedValue: savedPayload.raw,
              dirty: false
            }
          : document
      )
    );
    draftValuesRef.current["config:markdownBlockConfig"] = savedPayload.raw;
  };

  const saveActiveDocument = async () => {
    if (!activeDocument) {
      return;
    }
    if (activeDocument.kind === "home" || activeDocument.kind === "usageStats") {
      return;
    }
    cancelPendingDirtyCheck();
    flushDocumentDraft(activeDocument);
    setBusyMessage(`Saving ${activeDocument.title}...`);
    try {
      if (activeDocument.kind === "article") {
        const currentValue = editorRef.current?.getValue() ?? getDraftValue(activeDocument);
        const savedArticle = await api.saveArticle(activeDocument.articlePath, currentValue);
        const savedDocument = withResolvedEditor(
          buildArticleDocument(savedArticle),
          activeDocument.editorId
        );
        draftValuesRef.current[savedDocument.id] = savedDocument.value;
        setDocuments((current) => upsertDocument(current, savedDocument));
        setActiveDocumentId(savedDocument.id);
        syncEditorValuePreservingView(savedDocument.value);
        schedulePreviewSourceUpdate(savedDocument.value, { immediate: true });
        await loadTree();
      } else if (activeDocument.kind === "project") {
        await saveProjectWorkbenchDocument();
      } else if (activeDocument.kind === "projectTask") {
        await saveProjectTaskWorkbenchDocument();
      } else if (activeDocument.kind === "projectLog") {
        await saveProjectLogWorkbenchDocument();
      } else if (activeDocument.kind === "themeAsset") {
        await saveThemeAssetDocument();
      } else if (activeDocument.configKind === "markdownBlockConfig") {
        await saveMarkdownBlockConfigDocument();
      } else if (activeDocument.configKind === "publishConfig") {
        await savePublishConfigDocument();
      } else if (activeDocument.configKind === "siteConfig") {
        await saveSiteConfigDocument();
      } else {
        await saveConfigDocuments();
      }
      setPageError(null);
    } catch (error) {
      setPageError((error as Error).message);
    } finally {
      setBusyMessage(null);
    }
  };

  const publishStaticSite = async () => {
    setPublishBusy(true);
    setBusyMessage("Publishing static site. This can take a while...");
    try {
      const result = await api.publishSite();
      setPageError(result.stderr || null);
    } catch (error) {
      // Carry the publish target + phase through to the error toast so authors
      // can see e.g. "Publish failed (cloudflare/upload-assets): 401 invalid
      // token" instead of a bare error message.
      if (error instanceof ApiRequestError && (error.target || error.phase)) {
        const where = [error.target, error.phase].filter(Boolean).join("/");
        const status = error.providerStatus ? ` ${error.providerStatus}` : "";
        setPageError(`Publish failed (${where}):${status} ${error.message}`.trim());
      } else {
        setPageError((error as Error).message);
      }
    } finally {
      setPublishBusy(false);
      setBusyMessage(null);
    }
  };

  const refreshWorkspaceData = useCallback(
    async (
      target:
        | "adminHome"
        | "config"
        | "markdownBlockConfig"
        | "publishConfig"
        | "usageStats"
        | "projects"
        | "siteConfig"
        | "themeGroups"
        | "tree"
        | Array<
            | "adminHome"
            | "config"
            | "markdownBlockConfig"
            | "publishConfig"
            | "usageStats"
            | "projects"
            | "siteConfig"
            | "themeGroups"
            | "tree"
          >
    ) => {
      const targets = Array.isArray(target) ? target : [target];
      await Promise.all(
        targets.map((entry) => {
          switch (entry) {
            case "tree":
              return loadTree();
            case "config":
              return loadConfig();
            case "markdownBlockConfig":
              return loadMarkdownBlockConfig();
            case "publishConfig":
              return loadPublishConfig();
            case "usageStats":
              return loadUsageStats();
            case "projects":
              return loadProjects();
            case "adminHome":
              return loadAdminHomeConfig();
            case "themeGroups":
              return loadThemeGroups();
            case "siteConfig":
              return loadSiteConfig();
          }
        })
      );
    },
    []
  );
  const revealLine = useCallback((lineNumber: number, options?: RevealLineOptions) => {
    const editor = editorRef.current;
    if (!editor) {
      return;
    }

    editor.revealLineInCenter(lineNumber);
    if (options?.moveCursor ?? true) {
      const selection = new monacoEditor.Selection(
        lineNumber,
        options?.column ?? 1,
        lineNumber,
        options?.column ?? 1
      );
      editor.setSelection(selection);
      editor.setPosition({
        lineNumber,
        column: options?.column ?? 1
      });
    }
    if (options?.focus ?? true) {
      editor.focus();
    }
  }, []);
  const reopenActiveDocumentWithEditor = useCallback((editorId: WorkbenchEditorId) => {
    if (!activeDocument) {
      return;
    }

    setDocuments((current) =>
      current.map((document) =>
        document.id === activeDocument.id
          ? {
              ...document,
              editorId: resolveDocumentEditorId(document, editorId)
            }
          : document
      )
    );
  }, [activeDocument, resolveDocumentEditorId]);
  const closeProjectWorkbenchDocuments = useCallback((projectId: string) => {
    draftValuesRef.current = removeProjectDraftValues(draftValuesRef.current, projectId);
    setDocuments((current) => closeProjectDocuments(current, projectId));

    if (activeDocument && isDocumentInProject(activeDocument, projectId)) {
      activateDocument(HOME_DOCUMENT_ID);
    }
  }, [activateDocument, activeDocument]);
  const openResource = useCallback(
    async (target: WorkbenchResourceTarget) => {
      switch (target.kind) {
        case "home":
          setDocuments((current) => (current.some((document) => document.kind === "home") ? current : [buildHomeDocument(), ...current]));
          activateDocument(HOME_DOCUMENT_ID);
          return;
        case "usageStats": {
          const existingDocument = documents.find((document) => document.kind === "usageStats");
          if (existingDocument) {
            if (target.preferredEditorId && existingDocument.editorId !== target.preferredEditorId) {
              setDocuments((current) =>
                current.map((document) =>
                  document.id === existingDocument.id
                    ? {
                        ...document,
                        editorId: resolveDocumentEditorId(document, target.preferredEditorId)
                      }
                    : document
                )
              );
            }
            activateDocument(existingDocument.id);
            return;
          }

          const payload = usageStatsPayload ?? (await loadUsageStats());
          const document = withResolvedEditor(buildUsageStatsDocument(payload), target.preferredEditorId);
          draftValuesRef.current[document.id] = document.value;
          setDocuments((current) => upsertDocument(current, document));
          activateDocument(document.id);
          return;
        }
        case "article":
          pendingArticleRevealRef.current =
            typeof target.lineNumber === "number"
              ? {
                  articlePath: target.articlePath,
                  column: target.column,
                  lineNumber: target.lineNumber
                }
              : null;
          await openArticleDocument(target.articlePath, target.preferredEditorId);
          if (
            typeof target.lineNumber === "number" &&
            activeDocument &&
            activeDocument.kind === "article" &&
            activeDocument.articlePath === target.articlePath
          ) {
            pendingArticleRevealRef.current = null;
            jumpToActiveArticleLine(target.lineNumber, { column: target.column });
          }
          return;
        case "config":
          await openConfigDocument(target.configKind, target.preferredEditorId);
          return;
        case "project":
          await openProjectDocument(target.projectId, target.preferredEditorId);
          return;
        case "projectTask":
          await openProjectTaskDocument(target.projectId, target.taskId, target.preferredEditorId);
          return;
        case "projectLog":
          await openProjectLogDocument(target.projectId, target.logId, target.preferredEditorId);
          return;
        case "themeAsset":
          await openThemeAssetDocument(target.groupId, target.fileName, target.preferredEditorId);
          return;
        case "themeGroupConfig":
          await openThemeGroupConfigDocument(target.groupId, target.preferredEditorId);
          return;
      }
    },
    [
      openArticleDocument,
      openConfigDocument,
      jumpToActiveArticleLine,
      loadUsageStats,
      openProjectDocument,
      openProjectLogDocument,
      openProjectTaskDocument,
      openThemeAssetDocument,
      openThemeGroupConfigDocument,
      activateDocument,
      activeDocument,
      documents,
      resolveDocumentEditorId,
      usageStatsPayload,
      withResolvedEditor
    ]
  );
  const renderSidebarStatusPills = () => (
    <>
      {busyMessage ? <span className="status-pill info">{busyMessage}</span> : null}
      {pageError ? <span className="status-pill error">{pageError}</span> : null}
    </>
  );

  const workbenchApi: WorkbenchApi = {
    closeProjectDocuments: closeProjectWorkbenchDocuments,
    hasDirtyArticleDocument,
    openHome: () => {
      setDocuments((current) => (current.some((document) => document.kind === "home") ? current : [buildHomeDocument(), ...current]));
      activateDocument(HOME_DOCUMENT_ID);
    },
    openResource,
    showCommandPalette: () => openPalette("commands"),
    hideCommandPalette: () => setCommandPaletteOpen(false),
    showSidebarModule: (moduleId, paneId) => {
      setSidebarGroupId(moduleId);
      if (paneId) {
        setActivePaneByGroup((current) => ({
          ...current,
          [moduleId]: paneId
        }));
      } else {
        setActivePaneByGroup((current) =>
          current[moduleId]
            ? current
            : {
                ...current,
                [moduleId]: groupedPanes[moduleId]?.[0]?.paneId ?? ""
              }
        );
      }
      setSidebarVisible(true);
    },
    showReopenWithEditor: () => openPalette("editors"),
    showThemePicker: () => openPalette("themes"),
    startThemeGroupCreate: () => {
      setCommandQuery("");
      openPalette("themeGroupCreate");
    },
    toggleSidebar: () => setSidebarVisible((current) => !current),
    togglePreview: () => {
      flushDocumentDraft();
      setPreviewVisible((current) => !current);
    },
    requestTextInput: (options) => {
      if (textInputDialogResolveRef.current) {
        textInputDialogResolveRef.current(null);
        textInputDialogResolveRef.current = null;
      }

      return new Promise((resolve) => {
        textInputDialogResolveRef.current = resolve;
        setTextInputDialog({
          confirmLabel: options.confirmLabel ?? "Confirm",
          description: options.description,
          emptyValueMessage: options.emptyValueMessage ?? "This field is required.",
          error: null,
          label: options.label,
          overline: options.overline ?? "Workbench",
          placeholder: options.placeholder,
          title: options.title,
          value: options.defaultValue ?? ""
        });
      });
    },
    setBusy: setBusyMessage,
    showError: setPageError,
    refreshWorkspaceData,
    revealLine,
    previewGlobalMarkdownSearch: (input) => api.previewGlobalMarkdownSearch(input),
    replaceNextGlobalMarkdownMatch: async (input: GlobalMarkdownSearchReplaceNextRequest) => {
      const response = await api.replaceNextGlobalMarkdownMatch(input);
      await loadTree();
      await refreshOpenArticleDocuments(response.applied?.changedPaths ?? []);
      return response;
    },
    replaceAllGlobalMarkdownMatches: async (input: GlobalMarkdownSearchRequest) => {
      const response = await api.replaceAllGlobalMarkdownMatches(input);
      await loadTree();
      await refreshOpenArticleDocuments(response.applied?.changedPaths ?? []);
      return response;
    },
    reopenActiveDocumentWithEditor,
    saveActiveDocument,
    openConfigDocument,
    publishStaticSite,
    setTheme: setThemeId
  };
  useLayoutEffect(() => {
    workbenchApiRef.current = workbenchApi;
  }, [workbenchApi]);

  useEffect(() => {
    window.localStorage.setItem("admin-disabled-plugins", JSON.stringify(disabledPluginIds));
  }, [disabledPluginIds]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FILE_PANE_FILTERS_STORAGE_KEY,
        serializeFilePaneFilters({ searchQuery, tagFilter, statusFilter, sortOrder, showAssets })
      );
    } catch {
      // Ignore storage failures and keep the in-memory filter state.
    }
  }, [searchQuery, tagFilter, statusFilter, sortOrder, showAssets]);

  useEffect(() => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    window.localStorage.setItem(PREVIEW_WIDTH_STORAGE_KEY, String(previewWidth));
  }, [previewWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        COLLAPSED_TREE_PATHS_STORAGE_KEY,
        serializeCollapsedTreePaths(collapsedTreePaths)
      );
    } catch {
      // Ignore storage failures and keep the in-memory tree state.
    }
  }, [collapsedTreePaths]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    try {
      const target = serializeWorkbenchResource(activeDocument);
      if (target) {
        window.localStorage.setItem(ACTIVE_RESOURCE_STORAGE_KEY, JSON.stringify(target));
      } else {
        window.localStorage.removeItem(ACTIVE_RESOURCE_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures and keep the in-memory workbench state.
    }
  }, [activeDocument, authenticated]);

  useEffect(() => {
    const previewShadowHead = previewShadowHeadRef.current;

    if (!previewShadowHead) {
      return;
    }

    let cancelled = false;
    const nextLinks = previewThemeCssAssets.map((asset) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `/theme-files/${asset.assetPath
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/")}?v=${renderStyleAssetVersion}`;
      link.dataset.renderStyleDirectory = asset.assetPath;
      return link;
    });
    previewShadowHead.replaceChildren(...nextLinks);

    void Promise.all(
      previewThemeCssAssets.map(async (asset) => {
        const href = `/theme-files/${asset.assetPath
          .split("/")
          .filter(Boolean)
          .map((segment) => encodeURIComponent(segment))
          .join("/")}?v=${renderStyleAssetVersion}`;
        const response = await fetch(href, { credentials: "include" });
        const cssText = rewriteManagedMediaTextReferences(await response.text(), "/media");
        const styleElement = document.createElement("style");
        styleElement.dataset.renderStyleRootCompat = asset.assetPath;
        styleElement.textContent = buildPreviewRootCompatCss(cssText);
        return styleElement;
      })
    )
      .then((compatStyles) => {
        if (cancelled || previewShadowHeadRef.current !== previewShadowHead) {
          return;
        }
        const scriptElements = previewThemeScriptAssets.map((asset) => {
          const script = document.createElement("script");
          script.type = "module";
          script.dataset.themePreviewScript = asset.assetPath;
          return fetch(
            `/theme-files/${asset.assetPath
              .split("/")
              .filter(Boolean)
              .map((segment) => encodeURIComponent(segment))
              .join("/")}?v=${renderStyleAssetVersion}`,
            { credentials: "include" }
          )
            .then((response) => response.text())
            .then((code) => {
              script.textContent = `const previewHost = document.querySelector('.preview-shadow-host'); const previewRoot = previewHost?.shadowRoot ?? null; const previewProse = previewRoot?.querySelector('.preview-prose') ?? null; const previewApi = { previewHost, previewRoot, previewProse }; ${rewriteManagedMediaTextReferences(code, "/media")}`;
              return script;
            });
        });

        return Promise.all(scriptElements).then((resolvedScripts) => {
          if (cancelled || previewShadowHeadRef.current !== previewShadowHead) {
            return;
          }

          previewShadowHead.replaceChildren(...nextLinks, ...compatStyles, ...resolvedScripts);
        });
      })
      .catch(() => {
        if (!cancelled && previewShadowHeadRef.current === previewShadowHead) {
          previewShadowHead.replaceChildren(...nextLinks);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [previewReadyVersion, previewThemeCssAssets, previewThemeScriptAssets, renderStyleAssetVersion]);

  useEffect(() => {
    if (!activeTheme) {
      return;
    }
    window.localStorage.setItem("admin-theme", activeTheme.id);
    document.documentElement.dataset.themeAppearance = activeTheme.appearance;
    Object.entries(activeTheme.cssVariables).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
    monacoEditor.editor.defineTheme(activeTheme.id, activeTheme.monacoTheme);
    monacoEditor.editor.setTheme(activeTheme.id);
  }, [activeTheme]);

  useEffect(() => {
    if (selectedPaletteIndex >= paletteItems.length) {
      setSelectedPaletteIndex(Math.max(0, paletteItems.length - 1));
    }
  }, [paletteItems.length, selectedPaletteIndex]);

  useEffect(() => {
    if (authenticated) {
      refreshWorkspace()
        .then(async () => {
          if (restoredSessionRef.current) {
            return;
          }
          restoredSessionRef.current = true;

          const target = initialActiveResourceRef.current;
          if (!target || target.kind === "home") {
            return;
          }

          await workbenchApiRef.current?.openResource(target);
        })
        .catch((error: Error) => setPageError(error.message));
    }
  }, [authenticated]);

  useEffect(() => {
    if (!authenticated) {
      usageStatsLastInteractionAtRef.current = null;
      if (usageStatsActivityTimerRef.current !== null) {
        window.clearInterval(usageStatsActivityTimerRef.current);
        usageStatsActivityTimerRef.current = null;
      }
      return;
    }

    usageStatsLastInteractionAtRef.current = Date.now();
    const activityListener = () => {
      markUsageActivity();
    };
    const activityEvents: Array<keyof WindowEventMap> = [
      "pointerdown",
      "keydown",
      "mousemove",
      "focus"
    ];

    for (const eventName of activityEvents) {
      window.addEventListener(eventName, activityListener, true);
    }

    usageStatsActivityTimerRef.current = window.setInterval(() => {
      markUsageActivity();
    }, USAGE_STATS_ACTIVITY_TICK_MS);

    return () => {
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, activityListener, true);
      }

      if (usageStatsActivityTimerRef.current !== null) {
        window.clearInterval(usageStatsActivityTimerRef.current);
        usageStatsActivityTimerRef.current = null;
      }
    };
  }, [authenticated, markUsageActivity]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    const keyboardApi = (navigator as Navigator & {
      keyboard?: {
        lock: (codes?: string[]) => Promise<void>;
        unlock: () => void;
      };
    }).keyboard;

    if (!keyboardApi?.lock || !keyboardApi.unlock) {
      return;
    }

    requestWorkbenchKeyboardLock();

    return () => {
      keyboardApi.unlock();
    };
  }, [authenticated, requestWorkbenchKeyboardLock]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }

    const handleBeforeUnload = () => {
      markUsageActivity();
      void flushUsageStats().catch(() => undefined);
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [authenticated, flushUsageStats, markUsageActivity]);

  useEffect(() => {
    if (!commandPaletteOpen) {
      setCommandQuery("");
      setSelectedPaletteIndex(0);
      setCommandPaletteMode("commands");
    }
  }, [commandPaletteOpen]);

  useEffect(() => {
    if (!activeDocumentSupportsPreview) {
      setPreviewRenderDialogOpen(false);
    }
  }, [activeDocumentSupportsPreview]);

  useEffect(() => {
    if (!previewPaneVisible || !activeDocument || !activeDocumentSupportsPreview) {
      schedulePreviewSourceUpdate("", { immediate: true });
      return;
    }

    const activeValue = draftValuesRef.current[activeDocument.id] ?? activeDocument.savedValue;
    scheduleDocumentPreviewUpdate(activeDocument, activeValue, { immediate: true });
  }, [activeDocument?.id, activeDocumentSupportsPreview, previewPaneVisible, scheduleDocumentPreviewUpdate, schedulePreviewSourceUpdate]);

  useEffect(() => {
    if (!previewPaneVisible || !activeDocument || !activeDocumentSupportsPreview) {
      previewBlocksRef.current = [];
      return;
    }

    const previewRoot = previewProseRef.current;
    const requestId = previewRenderRequestRef.current + 1;
    previewRenderRequestRef.current = requestId;
    const parsedSource = parsePreviewSourceForDocument(activeDocument, previewSourceText);

    if (!previewRoot || !parsedSource) {
      previewRoot?.replaceChildren();
      previewBlocksRef.current = [];
      setPageError((current) => (current && current.includes("end of the stream") ? null : current));
      return;
    }

    let previewRenderError = parsedSource.frontmatterError;
    let renderBlockConfig = markdownBlockConfigPayload?.value ?? null;
    let nextBlocks: ParsedPreviewBlock[];

    try {
      nextBlocks = parsePreviewBlocks(parsedSource.body, renderBlockConfig);
    } catch (error) {
      previewRenderError = error instanceof Error ? error.message : String(error);
      renderBlockConfig = null;
      nextBlocks = parsePreviewBlocks(parsedSource.body, null);
    }

    const nextPreviewBlocks = nextBlocks.map((block) => ({
      ...block,
      startLine: block.startLine + parsedSource.lineOffset,
      endLine: block.endLine + parsedSource.lineOffset
    }));
    const currentBlocks = previewBlocksRef.current;

    let prefixLength = 0;
    while (
      prefixLength < currentBlocks.length &&
      prefixLength < nextPreviewBlocks.length &&
      currentBlocks[prefixLength].hash === nextPreviewBlocks[prefixLength].hash
    ) {
      prefixLength += 1;
    }

    let currentTailIndex = currentBlocks.length - 1;
    let nextTailIndex = nextPreviewBlocks.length - 1;
    while (
      currentTailIndex >= prefixLength &&
      nextTailIndex >= prefixLength &&
      currentBlocks[currentTailIndex].hash === nextPreviewBlocks[nextTailIndex].hash
    ) {
      currentTailIndex -= 1;
      nextTailIndex -= 1;
    }

    const changedBlocks = nextPreviewBlocks.slice(prefixLength, nextTailIndex + 1);

    Promise.all(
      changedBlocks.map(async (block) => {
        const html = await renderMarkdownFragmentWithKatex(
          block.source,
          renderBlockConfig,
          activePreviewFenceRenderers
        );
        return rewriteManagedMediaUrls(
          rewriteRelativeAssetUrls(html, parsedSource.directory, "/content-files"),
          "/media"
        );
      })
    )
      .then((changedHtmlBlocks) => {
        if (previewRenderRequestRef.current !== requestId || !previewProseRef.current) {
          return;
        }

        const nextRenderedBlocks: RenderedPreviewBlock[] = [];

        for (let index = 0; index < prefixLength; index += 1) {
          const previousBlock = currentBlocks[index];
          const nextBlock = nextPreviewBlocks[index];
          nextRenderedBlocks.push({
            ...previousBlock,
            hash: nextBlock.hash,
            startLine: nextBlock.startLine,
            endLine: nextBlock.endLine
          });
        }

        for (let index = 0; index < changedBlocks.length; index += 1) {
          const nextBlock = changedBlocks[index];
          previewBlockIdRef.current += 1;
          const element = document.createElement("section");
          element.className = "preview-block";
          element.dataset.previewBlockId = `preview-block-${previewBlockIdRef.current}`;
          element.innerHTML = changedHtmlBlocks[index];
          nextRenderedBlocks.push({
            id: element.dataset.previewBlockId ?? `preview-block-${previewBlockIdRef.current}`,
            hash: nextBlock.hash,
            startLine: nextBlock.startLine,
            endLine: nextBlock.endLine,
            element
          });
        }

        const nextSuffixStart = prefixLength + changedBlocks.length;
        const currentSuffixStart = currentTailIndex + 1;
        for (let nextIndex = nextSuffixStart; nextIndex < nextPreviewBlocks.length; nextIndex += 1) {
          const previousBlock = currentBlocks[currentSuffixStart + (nextIndex - nextSuffixStart)];
          const nextBlock = nextPreviewBlocks[nextIndex];

          if (!previousBlock) {
            continue;
          }

          nextRenderedBlocks.push({
            ...previousBlock,
            hash: nextBlock.hash,
            startLine: nextBlock.startLine,
            endLine: nextBlock.endLine
          });
        }

        const fragment = document.createDocumentFragment();
        for (const block of nextRenderedBlocks) {
          block.element.dataset.startLine = String(block.startLine);
          block.element.dataset.endLine = String(block.endLine);
          fragment.appendChild(block.element);
        }

        previewProseRef.current.replaceChildren(fragment);
        previewBlocksRef.current = nextRenderedBlocks;
        setPageError(previewRenderError);
        schedulePreviewCursorSyncRef.current?.();
      })
      .catch((error: Error) => {
        if (previewRenderRequestRef.current === requestId) {
          setPageError(error.message);
        }
      });
  }, [
    activeDocument?.id,
    activeDocument?.kind,
    activeDocumentSupportsPreview,
    activePreviewFenceRenderers,
    markdownBlockConfigPayload?.raw,
    previewPaneVisible,
    previewReadyVersion,
    previewSourceText
  ]);

  useEffect(() => {
    const editor = editorRef.current;
    const previewElement = previewRef.current;

    if (!editor || !previewElement || !activeDocumentSupportsPreview || !activeDocument) {
      schedulePreviewCursorSyncRef.current = null;
      return;
    }

    const isPreviewFollowSuppressed = () => suppressPreviewFollowFromEditorScrollRef.current;
    const clearPreviewFollowSuppression = () => {
      suppressPreviewFollowFromEditorScrollRef.current = false;
    };
    const editorDomNode = editor.getDomNode();

    const runCursorSync = (force = false) => {
      previewCursorSyncRafRef.current = null;

      const position = editor.getPosition();
      if (!position) {
        return;
      }
      if (!force && lastPreviewCursorSyncLineRef.current === position.lineNumber) {
        return;
      }
      lastPreviewCursorSyncLineRef.current = position.lineNumber;

      const block = findPreviewBlockByLine(previewBlocksRef.current, position.lineNumber);
      if (!block || !block.element.isConnected) {
        return;
      }

      const lineRatio =
        block.endLine <= block.startLine
          ? 0
          : (position.lineNumber - block.startLine) / (block.endLine - block.startLine);
      const anchorElement = findPreviewAnchorElement(block.element, lineRatio, previewElement.clientHeight);
      const currentScrollTop = previewElement.scrollTop;
      const previewBounds = previewElement.getBoundingClientRect();
      const anchorBounds = anchorElement.getBoundingClientRect();
      const anchorTop = anchorBounds.top - previewBounds.top + currentScrollTop;
      const anchorHeight = Math.max(anchorBounds.height, 1);
      const anchorBottom = anchorTop + anchorHeight;
      const viewportHeight = previewElement.clientHeight;
      const focusBandTop = currentScrollTop + viewportHeight * 0.25;
      const focusBandBottom = currentScrollTop + viewportHeight * 0.75;

      if (anchorBottom >= focusBandTop && anchorTop <= focusBandBottom) {
        return;
      }

      const desiredTop = anchorTop - viewportHeight * 0.18;
      const maxScrollTop = Math.max(previewElement.scrollHeight - viewportHeight, 0);
      previewElement.scrollTo({
        top: Math.min(maxScrollTop, Math.max(0, desiredTop)),
        behavior: "smooth"
      });
    };

    const scheduleCursorSync = (options?: { force?: boolean }) => {
      if (previewCursorSyncRafRef.current !== null) {
        return;
      }

      previewCursorSyncRafRef.current = window.requestAnimationFrame(() => runCursorSync(options?.force));
    };

    schedulePreviewCursorSyncRef.current = scheduleCursorSync;
    lastPreviewCursorSyncLineRef.current = null;

    const cursorDisposable = editor.onDidChangeCursorPosition(() => {
      const position = editor.getPosition();
      if (isPreviewFollowSuppressed()) {
        return;
      }
      if (position && lastPreviewCursorSyncLineRef.current === position.lineNumber) {
        return;
      }
      scheduleCursorSync();
    });
    const scrollDisposable = editor.onDidScrollChange((event) => {
      if (event.scrollTopChanged) {
        if (isPreviewFollowSuppressed()) {
          return;
        }
        scheduleCursorSync({ force: true });
      }
    });

    editorDomNode?.addEventListener("pointerdown", clearPreviewFollowSuppression, true);
    editorDomNode?.addEventListener("wheel", clearPreviewFollowSuppression, true);
    editorDomNode?.addEventListener("keydown", clearPreviewFollowSuppression, true);
    editorDomNode?.addEventListener("touchstart", clearPreviewFollowSuppression, true);

    scheduleCursorSync();

    return () => {
      schedulePreviewCursorSyncRef.current = null;
      cursorDisposable.dispose();
      scrollDisposable.dispose();
      editorDomNode?.removeEventListener("pointerdown", clearPreviewFollowSuppression, true);
      editorDomNode?.removeEventListener("wheel", clearPreviewFollowSuppression, true);
      editorDomNode?.removeEventListener("keydown", clearPreviewFollowSuppression, true);
      editorDomNode?.removeEventListener("touchstart", clearPreviewFollowSuppression, true);

      if (previewCursorSyncRafRef.current !== null) {
        window.cancelAnimationFrame(previewCursorSyncRafRef.current);
        previewCursorSyncRafRef.current = null;
      }
    };
  }, [activeDocument?.id, activeDocumentSupportsPreview, editorReadyVersion, previewReadyVersion]);

  useEffect(() => {
    const previewRoot = previewProseRef.current;

    if (!previewRoot || !activeDocumentSupportsPreview || !activeDocument) {
      return;
    }

    const handleDoubleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const blockElement = target.closest(".preview-block");
      if (!(blockElement instanceof HTMLElement)) {
        return;
      }

      const startLine = Number(blockElement.dataset.startLine);
      const endLine = Number(blockElement.dataset.endLine);
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
        return;
      }

      const bounds = blockElement.getBoundingClientRect();
      const offsetY = Math.min(Math.max(event.clientY - bounds.top, 0), Math.max(bounds.height, 1));
      const ratio = bounds.height <= 0 ? 0 : offsetY / bounds.height;
      const lineSpan = Math.max(0, endLine - startLine);
      const targetLine = Math.max(
        startLine,
        Math.min(endLine, startLine + Math.round(lineSpan * ratio))
      );

      jumpToActiveArticleLine(targetLine, { focus: false, moveCursor: false });
    };

    previewRoot.addEventListener("dblclick", handleDoubleClick);
    return () => {
      previewRoot.removeEventListener("dblclick", handleDoubleClick);
    };
  }, [activeDocument, activeDocumentSupportsPreview, jumpToActiveArticleLine, previewReadyVersion]);

  useEffect(() => {
    return () => {
      if (adminHomeSaveTimerRef.current !== null) {
        window.clearTimeout(adminHomeSaveTimerRef.current);
        adminHomeSaveTimerRef.current = null;
      }

      if (articleCursorPersistTimerRef.current !== null) {
        window.clearTimeout(articleCursorPersistTimerRef.current);
        articleCursorPersistTimerRef.current = null;
      }
      flushArticleCursorStates();

      if (dirtyCheckTimerRef.current !== null) {
        window.clearTimeout(dirtyCheckTimerRef.current);
        dirtyCheckTimerRef.current = null;
      }

      if (draftValueSyncTimerRef.current !== null) {
        window.clearTimeout(draftValueSyncTimerRef.current);
        draftValueSyncTimerRef.current = null;
      }

      if (usageStatsFlushTimerRef.current !== null) {
        window.clearTimeout(usageStatsFlushTimerRef.current);
        usageStatsFlushTimerRef.current = null;
      }

      if (usageStatsActivityTimerRef.current !== null) {
        window.clearInterval(usageStatsActivityTimerRef.current);
        usageStatsActivityTimerRef.current = null;
      }

      if (previewUpdateTimerRef.current !== null) {
        window.clearTimeout(previewUpdateTimerRef.current);
        previewUpdateTimerRef.current = null;
      }

      if (previewCursorSyncRafRef.current !== null) {
        window.cancelAnimationFrame(previewCursorSyncRafRef.current);
        previewCursorSyncRafRef.current = null;
      }

      suppressPreviewFollowFromEditorScrollRef.current = false;
      previewBlocksRef.current = [];
      schedulePreviewCursorSyncRef.current = null;
      previewProseRef.current?.replaceChildren();
      void flushUsageStats().catch(() => undefined);
    };
  }, [flushArticleCursorStates, flushUsageStats]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (isWorkbenchTabShortcutEvent(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    document.addEventListener("keydown", listener, true);
    window.addEventListener("keydown", listener, true);
    return () => {
      document.removeEventListener("keydown", listener, true);
      window.removeEventListener("keydown", listener, true);
    };
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (commandPaletteOpen) {
        return;
      }

      const editor = editorRef.current;
      const model = editor?.getModel();
      const position = editor?.getPosition();
      const snippetLanguage =
        editor && model && position && isArticleDocument(activeDocument) ? getSnippetLanguageForEditor(model, position) : "markdown";
      const context = {
        editorLangId: snippetLanguage,
        editorTextFocus: Boolean(editor?.hasTextFocus()),
        textInputFocus: Boolean(editor?.hasTextFocus()),
        inputFocus: Boolean(editor?.hasTextFocus()),
        suggestWidgetVisible: Boolean(document.querySelector(".suggest-widget.visible"))
      };
      const binding = getActiveKeybinding(normalizedConfig.keybindings, event, context);
      if (!binding || !workbenchApiRef.current || !isWorkbenchKeybindingCommand(binding.command)) {
        return;
      }

      const command = pluginRuntime.getCommand(
        binding.command === "workbench.action.showCommands" ? "workbench.showCommandPalette" : binding.command
      );
      if (!command) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void command.handler(workbenchApiRef.current);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [activeDocument, commandPaletteOpen, normalizedConfig.keybindings, pluginRuntime]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (sidebarGroupId !== "explorer" || activePaneId !== "files") {
        return;
      }
      const activeElement = document.activeElement;
      if (!treeRootRef.current?.contains(activeElement) || activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
        return;
      }
      const targetNode = selectedTreeNode;
      const targetDirectoryPath = !targetNode ? "" : targetNode.type === "directory" ? targetNode.path : getParentPath(targetNode.path);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && targetNode) {
        event.preventDefault();
        setTreeClipboard({ path: targetNode.path, mode: "copy" });
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x" && targetNode) {
        event.preventDefault();
        setTreeClipboard({ path: targetNode.path, mode: "move" });
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && treeClipboard) {
        event.preventDefault();
        setBusyMessage("Applying file operation...");
        api.transferFileSystemEntry(treeClipboard.path, targetDirectoryPath, treeClipboard.mode)
          .then(async (result) => {
            await loadTree();
            if (treeClipboard.mode === "move") {
              setDocuments((current) => remapDocuments(current, treeClipboard.path, result.path));
              draftValuesRef.current = remapArticleDraftValues(
                draftValuesRef.current,
                treeClipboard.path,
                result.path
              );
              remapStoredArticleCursorStates(treeClipboard.path, result.path);
              setCollapsedTreePaths((current) =>
                remapCollapsedTreePaths(current, treeClipboard.path, result.path)
              );
              setTreeClipboard(null);
            }
            setSelectedTreePath(result.path);
            setPageError(null);
          })
          .catch((error: Error) => setPageError(error.message))
          .finally(() => setBusyMessage(null));
      } else if (event.key === "Delete" && targetNode) {
        event.preventDefault();
        setFileDialog({
          entryType: targetNode.type === "directory" ? "directory" : "file",
          fileKind: targetNode.type === "file" ? targetNode.fileKind : undefined,
          mode: "delete",
          path: targetNode.path,
          value: targetNode.name,
          metadata: {}
        });
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [activePaneId, remapStoredArticleCursorStates, selectedTreeNode, sidebarGroupId, treeClipboard]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (commandPaletteOpen) {
        return;
      }

      if (!isWorkbenchTabShortcutEvent(event)) {
        return;
      }

      const tabIndexMatch = /^Digit([1-9])$/.exec(event.code);
      if (tabIndexMatch) {
        const index = Number(tabIndexMatch[1]) - 1;
        const targetDocument = documents[index];
        if (targetDocument) {
          activateDocument(targetDocument.id);
        }
        return;
      }

      const isPageUp = event.code === "PageUp" || event.key === "PageUp";
      const isPageDown = event.code === "PageDown" || event.key === "PageDown";

      if (isPageUp || isPageDown) {
        const activeIndex = documents.findIndex((document) => document.id === activeDocumentId);
        if (activeIndex === -1 || documents.length === 0) {
          return;
        }

        const delta = isPageUp ? -1 : 1;
        const nextIndex = (activeIndex + delta + documents.length) % documents.length;
        activateDocument(documents[nextIndex]?.id ?? activeDocumentId);
        return;
      }

      if (event.key.toLowerCase() === "w") {
        if (activeDocumentId === HOME_DOCUMENT_ID) {
          return;
        }

        const nextDocuments = closeDocument(documents, activeDocumentId ?? "");
        setDocuments(nextDocuments);
        if (activeDocumentId) {
          const closedIndex = documents.findIndex((document) => document.id === activeDocumentId);
          const fallbackIndex = Math.max(0, closedIndex - 1);
          activateDocument(nextDocuments[fallbackIndex]?.id ?? HOME_DOCUMENT_ID);
        }
      }
    };

    document.addEventListener("keydown", listener, true);
    window.addEventListener("keydown", listener, true);
    return () => {
      document.removeEventListener("keydown", listener, true);
      window.removeEventListener("keydown", listener, true);
    };
  }, [activateDocument, activeDocumentId, commandPaletteOpen, documents]);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorFeatureCleanupRef.current?.();
    editorFeatureCleanupRef.current = null;
    editorRef.current = editor;
    monacoRef.current = monaco;
    setEditorReadyVersion((current) => current + 1);
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      schemas: getJsonSchemaDefinitions()
    });
    if (activeTheme) {
      monaco.editor.setTheme(activeTheme.id);
    }

    if (activeDocument?.language === "markdown") {
      const cleanups = pluginRuntime
        .getMarkdownEditorFeatures()
        .filter((feature) => feature.matches(activeDocument))
        .map((feature) => feature.onMount?.(editor, monaco, activeDocument))
        .filter((cleanup): cleanup is () => void => typeof cleanup === "function");

      if (cleanups.length > 0) {
        editorFeatureCleanupRef.current = () => {
          for (const cleanup of cleanups) {
            cleanup();
          }
        };
      }
    }
  };

  useEffect(() => {
    if (!activeDocument || activeDocument.kind === "home") {
      editorFeatureCleanupRef.current?.();
      editorFeatureCleanupRef.current = null;
      editorRef.current = null;
      monacoRef.current = null;
    }
  }, [activeDocument?.id, activeDocument?.kind, activeEditorContribution?.editorId]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();

    if (!editor || !model || !isArticleDocument(activeDocument)) {
      lastStoredArticleLineNumberRef.current = null;
      setActiveArticleLineNumber(null);
      return;
    }

    const storedState = articleCursorStatesRef.current[activeDocument.articlePath];
    const lineNumber = Math.max(1, Math.min(storedState?.lineNumber ?? 1, model.getLineCount()));
    const column = Math.max(1, Math.min(storedState?.column ?? 1, model.getLineMaxColumn(lineNumber)));
    const frame = window.requestAnimationFrame(() => {
      const selection = new monacoEditor.Selection(lineNumber, column, lineNumber, column);

      editor.setSelection(selection);
      editor.setPosition({ lineNumber, column });
      if (storedState) {
        editor.setScrollTop(storedState.scrollTop);
        editor.setScrollLeft(storedState.scrollLeft);
      } else {
        editor.setScrollTop(0);
        editor.setScrollLeft(0);
      }
      editor.focus();
      lastStoredArticleLineNumberRef.current = lineNumber;
      setActiveArticleLineNumber(lineNumber);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeDocument?.id, editorReadyVersion]);

  useEffect(() => {
    const pendingReveal = pendingArticleRevealRef.current;
    if (
      !pendingReveal ||
      !activeDocument ||
      activeDocument.kind !== "article" ||
      activeDocument.articlePath !== pendingReveal.articlePath
    ) {
      return;
    }

    const editor = editorRef.current;
    if (!editor?.getModel()) {
      return;
    }

    pendingArticleRevealRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      jumpToActiveArticleLine(pendingReveal.lineNumber, {
        column: pendingReveal.column,
        focus: pendingReveal.focus,
        moveCursor: pendingReveal.moveCursor
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeDocument?.id, editorReadyVersion, jumpToActiveArticleLine]);

  useEffect(() => {
    const editor = editorRef.current;

    if (!editor || !isArticleDocument(activeDocument)) {
      return;
    }

    const updateCursorState = () => {
      storeArticleCursorState(activeDocument.articlePath);
    };

    const cursorDisposable = editor.onDidChangeCursorPosition(() => {
      updateCursorState();
    });
    const scrollDisposable = editor.onDidScrollChange((event) => {
      if (event.scrollTopChanged || event.scrollLeftChanged) {
        updateCursorState();
      }
    });

    return () => {
      cursorDisposable.dispose();
      scrollDisposable.dispose();
    };
  }, [activeDocument?.id, editorReadyVersion, storeArticleCursorState]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeDocument || !isArticleDocument(activeDocument)) {
      headingsRef.current = [];
      mathPairsRef.current = [];
      updateMathPairsCache([]);
      outlineVersionRef.current += 1;
      setOutlineVersion(outlineVersionRef.current);
      return;
    }

    const fullText = editor.getValue();
    headingsRef.current = scanHeadingsFromText(fullText);
    const newPairs = scanDocumentMathPairs(fullText);
    mathPairsRef.current = newPairs;
    updateMathPairsCache(newPairs);
    outlineVersionRef.current += 1;
    setOutlineVersion(outlineVersionRef.current);
  }, [activeDocument?.id, editorReadyVersion]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) {
      return;
    }
    const allSnippets = [...normalizedConfig.markdownSnippets, ...normalizedConfig.latexSnippets];
    const markdownSymbolTriggerCharacters = getSnippetTriggerCharacters(normalizedConfig.markdownSnippets);
    const latexSymbolTriggerCharacters = getSnippetTriggerCharacters(normalizedConfig.latexSnippets);
    const completionProvider = monaco.languages.registerCompletionItemProvider("markdown", {
      triggerCharacters: Array.from(
        new Set(["@", ...markdownSymbolTriggerCharacters, ...latexSymbolTriggerCharacters])
      ),
      provideCompletionItems(model, position) {
        const linePrefix = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column));

        if (isProjectTaskDocument(activeDocument)) {
          const noteQuery = getProjectTaskNoteQuery(linePrefix);
          if (!noteQuery) {
            return { suggestions: [] };
          }

          const suggestions = getProjectTaskNoteSuggestions(noteQuery.query, treePayload?.articles ?? []).map(
            (article, index) => ({
              detail: article.path,
              filterText: `${article.title} ${article.path} @note`.trim(),
              insertText: `@note/${article.title} `,
              kind: monaco.languages.CompletionItemKind.Reference,
              label: {
                description: article.path,
                label: article.title
              },
              range: new monaco.Range(
                position.lineNumber,
                Math.max(1, position.column - noteQuery.replacementText.length),
                position.lineNumber,
                position.column
              ),
              sortText: `0-${String(index).padStart(4, "0")}`
            })
          );

          return { suggestions };
        }

        if (!isArticleDocument(activeDocument)) {
          return { suggestions: [] };
        }
        const snippetLanguage = getSnippetLanguageForEditor(model, position);
        const snippetState = resolveEditorSnippetState(linePrefix, snippetLanguage, normalizedConfig);
        const suggestions = snippetState.matches.map(
          ({ prefix, replacementText, snippet }) => ({
            kind: monaco.languages.CompletionItemKind.Snippet,
            label: { label: snippet.name, description: prefix },
            filterText: `${prefix} ${snippet.name} ${snippet.description ?? ""}`.trim(),
            insertText: toSnippetBody(snippet.body),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range: new monaco.Range(
              position.lineNumber,
              Math.max(1, position.column - replacementText.length),
              position.lineNumber,
              position.column
            ),
            sortText: `0-${String(9999 - replacementText.length).padStart(4, "0")}-${String(prefix.length).padStart(4, "0")}-${prefix}`
          })
        );
        return { suggestions };
      }
    });
    const domNode = editor.getDomNode();
    const textarea = domNode?.querySelector("textarea.inputarea");
    const getSnippetController = () =>
      editor.getContribution("snippetController2") as {
        insert: (template: string) => void;
        isInSnippet?: () => boolean;
      } | null;
    const insertSnippet = (snippet: EditorSnippet) => {
      getSnippetController()?.insert(toSnippetBody(snippet.body));
    };
    const createEditorWhenContext = () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      const hasSelection = Boolean(editor.getSelection()) && !editor.getSelection()?.isEmpty();
      const editorHasTextFocus = editor.hasTextFocus();
      const snippetController = getSnippetController();
      const snippetLanguage =
        model && position && isArticleDocument(activeDocument) ? getSnippetLanguageForEditor(model, position) : "markdown";

      return {
        editorLangId: snippetLanguage,
        editorTextFocus: editorHasTextFocus,
        textInputFocus: editorHasTextFocus,
        inputFocus: editorHasTextFocus,
        editorReadonly: editor.getOption(monaco.editor.EditorOption.readOnly),
        editorHasCompletionItemProvider: isMarkdownCompletionDocument(activeDocument),
        suggestWidgetVisible: Boolean(domNode?.querySelector(".suggest-widget.visible")),
        editorHasMultipleSelections: (editor.getSelections()?.length ?? 0) > 1,
        editorHasSelection: hasSelection,
        editorHoverVisible: Boolean(domNode?.querySelector(".monaco-hover.visible")),
        editorHoverFocused: false,
        editorTabMovesFocus: false,
        inlineChatFocused: false,
        notebookEditorFocused: false,
        notebookOutputFocused: false,
        inInlineEditsPreviewEditor: false,
        inlineEditIsVisible: false,
        inlineSuggestionVisible: false,
        inlineSuggestionHasIndentationLessThanTabSize: false,
        tabShouldAcceptInlineEdit: false,
        inSnippetMode: snippetController?.isInSnippet?.() ?? false,
        editor: {
          hasSelection
        },
        trae: {
          hasInlineSuggestShouldAcceptDirect: false
        }
      };
    };
    const executeEditorKeybinding = async (
      keybinding: EditorConfigPayload["keybindings"][number],
      relevantSnippets: NormalizedSnippet[],
      activeSnippetMatches: import("./snippet-completion").SnippetCompletionMatch[]
    ) => {
      if (keybinding.command === "editor.insertSnippet") {
        const snippetName = String(keybinding.args?.snippetName ?? "");
        const snippet =
          relevantSnippets.find((item) => item.name === snippetName) ??
          allSnippets.find((item) => item.name === snippetName);

        if (snippet) {
          insertSnippet(snippet);
          return true;
        }

        return false;
      }

      if (keybinding.command === "type") {
        editor.trigger("keyboard", "type", keybinding.args ?? {});
        return true;
      }

      if (isWorkbenchKeybindingCommand(keybinding.command)) {
        const workbenchCommand = pluginRuntime.getCommand(
          keybinding.command === "workbench.action.showCommands"
            ? "workbench.showCommandPalette"
            : keybinding.command
        );
        if (workbenchCommand && workbenchApiRef.current) {
          await workbenchCommand.handler(workbenchApiRef.current);
          return true;
        }
      }

      const action = pluginRuntime.getEditorAction(keybinding.command);
      if (action) {
        return await action.handler({
          editor,
          monaco,
          activeDocument,
          snippets: relevantSnippets,
          activeSnippetMatches
        });
      }

      if (
        keybinding.command === "hideSuggestWidget" ||
        keybinding.command === "acceptSelectedSuggestion" ||
        keybinding.command.startsWith("editor.")
      ) {
        editor.trigger("keyboard", keybinding.command, keybinding.args ?? {});
        return true;
      }

      return false;
    };
    const keydownListener = async (event: KeyboardEvent) => {
      if (!editor.hasTextFocus() || !isArticleDocument(activeDocument)) {
        return;
      }
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position) {
        return;
      }

      const snippetLanguage = getSnippetLanguageForEditor(model, position);
      const linePrefix = model.getValueInRange(
        new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column)
      );
      const snippetState = resolveEditorSnippetState(linePrefix, snippetLanguage, normalizedConfig);
      const relevantSnippets = snippetState.currentLanguageSnippets;
      const whenContext = createEditorWhenContext();
      const matchingKeybindings = getMatchingKeybindings(normalizedConfig.keybindings, event, whenContext);
      const activeKeybinding = getActiveKeybinding(normalizedConfig.keybindings, event, whenContext);

      if (activeKeybinding) {
        const handled = await executeEditorKeybinding(
          activeKeybinding,
          relevantSnippets,
          snippetState.matches
        );
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const removedCommands = matchingKeybindings
        .filter((keybinding) => keybinding.command.startsWith("-"))
        .map((keybinding) => keybinding.command.slice(1));
      const snippetController = getSnippetController();

      if (
        event.key === "Tab" &&
        (snippetController?.isInSnippet?.() ?? false) &&
        removedCommands.includes("acceptSelectedSuggestion")
      ) {
        event.preventDefault();
        event.stopPropagation();
        editor.trigger(
          "keyboard",
          event.shiftKey ? "jumpToPrevSnippetPlaceholder" : "jumpToNextSnippetPlaceholder",
          {}
        );
        return;
      }

      if (removedCommands.some((command) => isSuppressedDefaultEditorCommand(command, whenContext))) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const keyedSnippet = relevantSnippets.find(
        (snippet) => snippet.key && matchesKeybindingEvent(snippet.key, event)
      );
      if (keyedSnippet) {
        event.preventDefault();
        event.stopPropagation();
        insertSnippet(keyedSnippet);
        return;
      }
    };
    const typeDisposable = editor.onDidType((text) => {
      if (text.length !== 1) {
        return;
      }

      if (isProjectTaskDocument(activeDocument)) {
        if (text !== "@") {
          return;
        }

        queueMicrotask(() => {
          if (!editor.hasTextFocus()) {
            return;
          }

          editor.trigger("keyboard", "editor.action.triggerSuggest", {});
        });
        return;
      }

      if (!isArticleDocument(activeDocument)) {
        return;
      }

      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position) {
        return;
      }

      const snippetLanguage = getSnippetLanguageForEditor(model, position);

      queueMicrotask(() => {
        if (!editor.hasTextFocus()) {
          return;
        }

        const currentModel = editor.getModel();
        const currentPosition = editor.getPosition();
        if (!currentModel || !currentPosition) {
          return;
        }

        const currentSnippetLanguage = getSnippetLanguageForEditor(currentModel, currentPosition);
        const currentLinePrefix = currentModel.getValueInRange(
          new monaco.Range(currentPosition.lineNumber, 1, currentPosition.lineNumber, currentPosition.column)
        );
        const snippetState = resolveEditorSnippetState(
          currentLinePrefix,
          currentSnippetLanguage,
          normalizedConfig
        );
        const triggerCharacters = getSnippetTriggerCharacters(
          snippetState.matches.map((match) => match.snippet)
        );
        const suggestWidgetVisible = Boolean(domNode?.querySelector(".suggest-widget.visible"));

        if (snippetState.matches.length === 0) {
          editor.trigger("keyboard", "hideSuggestWidget", {});
          return;
        }

        if (triggerCharacters.includes(text) || suggestWidgetVisible) {
          editor.trigger("keyboard", "editor.action.triggerSuggest", {});
        }
      });
    });
    const pasteListener = async (event: ClipboardEvent) => {
      if (!isArticleDocument(activeDocument)) {
        return;
      }

      if ((event as ClipboardEvent & { __blogSystemPasteHandled?: boolean }).__blogSystemPasteHandled) {
        return;
      }

      const target = event.target;
      const targetIsInsideEditor =
        target instanceof Node ? domNode?.contains(target) ?? false : false;
      const activeElement = document.activeElement;
      const focusIsOnEditorTextarea =
        activeElement instanceof HTMLTextAreaElement &&
        activeElement.classList.contains("inputarea") &&
        (domNode?.contains(activeElement) ?? false);

      if (!targetIsInsideEditor && !focusIsOnEditorTextarea) {
        return;
      }

      (event as ClipboardEvent & { __blogSystemPasteHandled?: boolean }).__blogSystemPasteHandled = true;

      for (const handler of pluginRuntime.getPasteHandlers()) {
        const handled = await handler.handle({
          event,
          editor,
          activeDocument,
          uploadClipboardImages: async (target, images: ClipboardImageInput[]) => {
            if (target.kind === "article") {
              const response = await api.uploadPastedImages(target.articlePath, images);
              await loadTree();
              return response.assets;
            }

            const response = await api.uploadMediaAssets(images);
            return response.assets;
          }
        });
        if (handled) {
          break;
        }
      }
    };
    domNode?.addEventListener("keydown", keydownListener, true);
    domNode?.addEventListener("paste", pasteListener, true);
    textarea?.addEventListener("paste", pasteListener, true);
    window.addEventListener("paste", pasteListener, true);
    return () => {
      completionProvider.dispose();
      typeDisposable.dispose();
      domNode?.removeEventListener("keydown", keydownListener, true);
      domNode?.removeEventListener("paste", pasteListener, true);
      textarea?.removeEventListener("paste", pasteListener, true);
      window.removeEventListener("paste", pasteListener, true);
    };
  }, [activeDocument, editorReadyVersion, normalizedConfig, pluginRuntime, treePayload?.articles]);

  const renderFileNode = (node: FileSystemNode): JSX.Element | null => {
    if (node.type === "directory") {
      const hasActiveFilters = deferredSearchQuery.trim().length > 0 || tagFilter !== "all" || statusFilter !== "all" || showAssets;
      const isExpanded = hasActiveFilters || !collapsedTreePaths.has(node.path);
      return (
        <details
          className="tree-group"
          key={node.path}
          onToggle={(event) => {
            const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
            if (hasActiveFilters) {
              return;
            }
            setCollapsedTreePaths((current) => {
              const nextPaths = new Set(current);
              if (nextOpen) {
                nextPaths.delete(node.path);
              } else {
                nextPaths.add(node.path);
              }
              return nextPaths;
            });
          }}
          open={isExpanded}
        >
          <summary
            className={`tree-directory ${selectedTreePath === node.path ? "is-active" : ""}`}
            onClick={() => setSelectedTreePath(node.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSelectedTreePath(node.path);
              setContextMenuState({ path: node.path, x: event.clientX, y: event.clientY });
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const sourcePath = event.dataTransfer.getData("text/plain");
              if (sourcePath) {
                setBusyMessage("Moving file...");
                api.transferFileSystemEntry(sourcePath, node.path, "move")
                  .then(async (result) => {
                    await loadTree();
                    setDocuments((current) => remapDocuments(current, sourcePath, result.path));
                    draftValuesRef.current = remapArticleDraftValues(
                      draftValuesRef.current,
                      sourcePath,
                      result.path
                    );
                    remapStoredArticleCursorStates(sourcePath, result.path);
                    setCollapsedTreePaths((current) =>
                      remapCollapsedTreePaths(current, sourcePath, result.path)
                    );
                    setSelectedTreePath(result.path);
                  })
                  .catch((error: Error) => setPageError(error.message))
                  .finally(() => setBusyMessage(null));
              }
            }}
          >
            {node.name}{node.hasMetadata ? <span className="folder-metadata-dot" /> : null}
          </summary>
          <div className="tree-children">{node.children.map((child) => renderFileNode(child))}</div>
        </details>
      );
    }

    return (
      <button
        className={`tree-file ${selectedTreePath === node.path ? "is-active" : ""}`}
        draggable
        key={node.path}
        onClick={() => {
          setSelectedTreePath(node.path);
          if (node.fileKind === "article") {
            void openArticleDocument(node.path);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setSelectedTreePath(node.path);
          setContextMenuState({ path: node.path, x: event.clientX, y: event.clientY });
        }}
        onDragStart={(event) => event.dataTransfer.setData("text/plain", node.path)}
        type="button"
      >
        <span className="tree-file-title">{node.article?.title ?? node.name}</span>
        {node.article ? (
          <span className={`status-badge ${node.article.status}`}>
            {node.article.status === "draft" ? "dra" : node.article.status === "working" ? "ing" : "pub"}
          </span>
        ) : (
          <span className="tag-chip">{node.extension || "file"}</span>
        )}
      </button>
    );
  };

  const handleDocumentValueChange = useCallback(
    (nextValue: string) => {
      if (!activeDocument) {
        return;
      }

      const previousValue = draftValuesRef.current[activeDocument.id] ?? activeDocument.savedValue;
      const netCharacterDelta = nextValue.length - previousValue.length;

      draftValuesRef.current[activeDocument.id] = nextValue;
      const shouldStoreValue = shouldStoreLiveDocumentValue(activeDocument);
      setDocuments((current) => {
        let changed = false;
        const nextDocuments = current.map((document) => {
          if (document.id !== activeDocument.id) {
            return document;
          }

          const shouldBeDirty = true;
          if (
            document.dirty !== shouldBeDirty ||
            (shouldStoreValue && document.value !== nextValue)
          ) {
            changed = true;
            return {
              ...document,
              dirty: shouldBeDirty,
              value: shouldStoreValue ? nextValue : document.value
            };
          }

          return document;
        });

        return changed ? nextDocuments : current;
      });

      scheduleDocumentDirtyCheck(activeDocument.id);
      queueUsageDocumentDelta(activeDocument, netCharacterDelta);
      markUsageActivity();

      if (activeDocumentSupportsPreview) {
        scheduleDocumentPreviewUpdate(activeDocument, nextValue);
      }
    },
    [
      activeDocument,
      activeDocumentSupportsPreview,
      markUsageActivity,
      queueUsageDocumentDelta,
      scheduleDocumentDirtyCheck,
      scheduleDocumentPreviewUpdate
    ]
  );

  const handleEditorModelContentChange = useCallback(
    (event: monacoEditor.editor.IModelContentChangedEvent) => {
      if (!activeDocument || shouldStoreLiveDocumentValue(activeDocument)) {
        return;
      }

      const netCharacterDelta = event.changes.reduce(
        (sum, change) => sum + change.text.length - change.rangeLength,
        0
      );

      if (!dirtyDocumentIdsRef.current.has(activeDocument.id)) {
        dirtyDocumentIdsRef.current.add(activeDocument.id);
        setDocuments((current) => {
          let changed = false;
          const nextDocuments = current.map((document) => {
            if (document.id !== activeDocument.id || document.dirty) {
              return document;
            }

            changed = true;
            return { ...document, dirty: true };
          });

          return changed ? nextDocuments : current;
        });
      }

      if (isArticleDocument(activeDocument)) {
        const model = editorRef.current?.getModel();
        if (model) {
          const isSingleLine = event.changes.every(
            (c) => c.range.startLineNumber === c.range.endLineNumber && !c.text.includes("\n")
          );

          if (isSingleLine && event.changes.length === 1) {
            const change = event.changes[0];
            const lineNum = change.range.startLineNumber;
            const newLine = model.getLineContent(lineNum);

            // Incremental heading update
            const headings = headingsRef.current;
            let hLow = 0;
            let hHigh = headings.length - 1;
            let hIdx = -1;
            while (hLow <= hHigh) {
              const mid = (hLow + hHigh) >>> 1;
              if (headings[mid].lineNumber === lineNum) { hIdx = mid; break; }
              if (headings[mid].lineNumber < lineNum) hLow = mid + 1;
              else hHigh = mid - 1;
            }

            const headingMatch = /^(#{1,6})\s+(.+)$/.exec(newLine);
            if (hIdx >= 0) {
              if (headingMatch) {
                const newText = headingMatch[2].trim();
                const newHash = hashLine(newLine);
                if (headings[hIdx].text !== newText) {
                  const slugger = new GithubSlugger();
                  for (const h of headings) slugger.slug(h.text);
                  headings[hIdx] = { ...headings[hIdx], depth: headingMatch[1].length, text: newText, id: slugger.slug(newText), lineHash: newHash };
                } else {
                  headings[hIdx] = { ...headings[hIdx], depth: headingMatch[1].length, lineHash: newHash };
                }
              } else {
                headingsRef.current = headings.filter((_, i) => i !== hIdx);
              }
            } else if (headingMatch) {
              const newText = headingMatch[2].trim();
              if (newText) {
                const slugger = new GithubSlugger();
                for (const h of headings) slugger.slug(h.text);
                const newHeading: CachedHeading = {
                  depth: headingMatch[1].length,
                  text: newText,
                  id: slugger.slug(newText),
                  lineNumber: lineNum,
                  lineHash: hashLine(newLine)
                };
                const insertIdx = headings.findIndex((h) => h.lineNumber > lineNum);
                if (insertIdx === -1) headingsRef.current = [...headings, newHeading];
                else headingsRef.current = [...headings.slice(0, insertIdx), newHeading, ...headings.slice(insertIdx)];
              }
            }

            // Incremental math pairs update
            const pairs = mathPairsRef.current;
            let pLow = 0;
            let pHigh = pairs.length - 1;
            let pIdx = -1;
            while (pLow <= pHigh) {
              const mid = (pLow + pHigh) >>> 1;
              if (pairs[mid].endLine >= lineNum && pairs[mid].startLine <= lineNum) { pIdx = mid; break; }
              if (pairs[mid].endLine < lineNum) pLow = mid + 1;
              else pHigh = mid - 1;
            }

            const newDollarCount = (newLine.match(/\$/g) ?? []).length;
            const oldLine = model.getLineContent(lineNum); // already the new content
            // We can't easily get the old line, so we check if any pair boundary was on this line
            const affectedPair = pIdx >= 0 ? pairs[pIdx] : null;
            const pairBoundaryChanged = affectedPair
              ? (affectedPair.startLine === lineNum || affectedPair.endLine === lineNum)
              : newDollarCount > 0;

            if (pairBoundaryChanged) {
              // Full rescan of math pairs
              const fullText = model.getValue();
              const newPairs = scanDocumentMathPairs(fullText);
              mathPairsRef.current = newPairs;
              updateMathPairsCache(newPairs);
            }
          } else {
            // Multi-line change: full rebuild
            const fullText = model.getValue();
            headingsRef.current = scanHeadingsFromText(fullText);
            const newPairs = scanDocumentMathPairs(fullText);
            mathPairsRef.current = newPairs;
            updateMathPairsCache(newPairs);
          }

          outlineVersionRef.current += 1;
          setOutlineVersion(outlineVersionRef.current);
        }
      }

      queueUsageDocumentDelta(activeDocument, netCharacterDelta);
      markUsageActivity();
      scheduleDraftValueSync(activeDocument);
    },
    [activeDocument, markUsageActivity, queueUsageDocumentDelta, scheduleDraftValueSync]
  );

  const renderSidebarPaneContent = () => {
    if (!activeSidebarPane) {
      return (
        <div className="sidebar-scroll">
          <div className="empty-state">No pane available.</div>
        </div>
      );
    }

    if (activeSidebarPane.kind === "plugin" && activeSidebarPane.component) {
      const PaneComponent = activeSidebarPane.component;
      return (
        <PaneComponent
          activeArticleLineNumber={activeArticleLineNumber ?? 1}
          activeDocument={activeDocument}
          api={workbenchApi}
          getDocumentValue={getDraftValue}
          projects={projectsPayload?.projects ?? []}
          outlineTree={outlineTree}
          activeOutlineItemId={activeOutlineItemId}
        />
      );
    }

    if (activeSidebarPane.paneId === "files") {
      return (
        <div className="sidebar-scroll" ref={treeRootRef}>
          {treeClipboard ? (
            <div className="sidebar-section">
              <span className="status-pill info">
                {treeClipboard.mode === "copy" ? "Copy" : "Cut"}: {getBaseName(treeClipboard.path)}
              </span>
            </div>
          ) : null}
          <div className="sidebar-section filters-section">
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Filter files"
            />
            <div className="filter-inline-row">
              <label className="filter-inline">
                <span>Sort</span>
                <select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as SortOrder)}>
                  <option value="date-dec">Date &#8595;</option>
                  <option value="date-inc">Date &#8593;</option>
                  <option value="title-dec">Title &#8595;</option>
                  <option value="title-inc">Title &#8593;</option>
                </select>
              </label>
              <label className="filter-inline">
                <span>Tag</span>
                <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
                  <option value="all">All</option>
                  {selectedTags.map((tag) => (
                    <option key={tag.tag} value={tag.tag}>
                      {tag.tag} ({tag.count})
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="filter-inline-row">
              <label className="filter-inline">
                <span>Status</span>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
                >
                  <option value="all">All</option>
                  <option value="draft">Draft</option>
                  <option value="working">Working</option>
                  <option value="published">Published</option>
                </select>
              </label>
              <label className="filter-inline filter-checkbox-inline">
                <input type="checkbox" checked={showAssets} onChange={(event) => setShowAssets(event.target.checked)} />
                <span>Show assets</span>
              </label>
            </div>
          </div>
          <div
            className="sidebar-section tree-section"
            onContextMenu={(event) => {
              event.preventDefault();
              setContextMenuState({ path: "", x: event.clientX, y: event.clientY });
            }}
          >
            {sortTreeNodes(treePayload?.fileTree ?? [], sortOrder)
              .filter((node) => filterFileTreeNode(node, deferredSearchQuery, tagFilter, statusFilter, showAssets))
              .map((node) => renderFileNode(node))}
          </div>
        </div>
      );
    }

    if (activeSidebarPane.paneId === "edit-actions") {
      return (
        <div className="sidebar-scroll">
          <div className="sidebar-section">
            <strong>Edit Actions</strong>
            <div className="edit-actions">
              <button
                className="action-button accent"
                disabled={publishBusy}
                onClick={() => void publishStaticSite()}
                type="button"
              >
                {publishBusy ? "Publishing..." : "Publish Static Site"}
              </button>
              {isArticleDocument(activeDocument) ? (
                <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                  <select
                    value={activeDocument.record.status}
                    onChange={async (event) => {
                      const nextStatus = event.target.value as "draft" | "working" | "published";
                      if (nextStatus === activeDocument.record.status) return;
                      setBusyMessage("Updating status...");
                      try {
                        const updated = await api.updateStatus(activeDocument.articlePath, nextStatus);
                        const updatedDocument = withResolvedEditor(
                          buildArticleDocument(updated),
                          activeDocument.editorId
                        );
                        setDocuments((current) => upsertDocument(current, updatedDocument));
                        setActiveDocumentId(updatedDocument.id);
                        draftValuesRef.current[updatedDocument.id] = updatedDocument.value;
                        syncEditorValuePreservingView(updatedDocument.value);
                        schedulePreviewSourceUpdate(updatedDocument.value, { immediate: true });
                        await loadTree();
                        setPageError(null);
                      } catch (error) {
                        setPageError((error as Error).message);
                      } finally {
                        setBusyMessage(null);
                      }
                    }}
                  >
                    <option value="draft">Draft (dra)</option>
                    <option value="working">Working (ing)</option>
                    <option value="published">Published (pub)</option>
                  </select>
                </div>
              ) : null}
              <button
                className="action-button primary"
                disabled={!activeDocument || isHomeDocument(activeDocument)}
                onClick={() => void saveActiveDocument()}
                type="button"
              >
                Save
              </button>
            </div>
            {renderSidebarStatusPills()}
            {configPayload?.warnings.length ? (
              <span className="status-pill warning">
                {configPayload.warnings.length} config warning{configPayload.warnings.length > 1 ? "s" : ""}
              </span>
            ) : null}
          </div>
        </div>
      );
    }

    return (
      <div className="sidebar-scroll">
        <div className="sidebar-section plugin-list">
          {builtInPlugins.map((plugin) => {
            const enabled = !disabledPluginIds.includes(plugin.id);
            return (
              <div className="plugin-card" key={plugin.id}>
                <div className="plugin-card-header">
                  <div>
                    <strong>{plugin.label}</strong>
                    <p>{plugin.description}</p>
                  </div>
                  <button
                    className={`action-button ${enabled ? "ghost" : "primary"}`}
                    onClick={() =>
                      setDisabledPluginIds((current) =>
                        enabled ? [...current, plugin.id] : current.filter((id) => id !== plugin.id)
                      )
                    }
                    type="button"
                  >
                    {enabled ? "Disable" : "Enable"}
                  </button>
                </div>
                <div className="plugin-card-meta">
                  <span className={`status-pill ${enabled ? "info" : "warning"}`}>
                    {enabled ? "Enabled" : "Disabled"}
                  </span>
                  <span className="body-muted">{plugin.id}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  const ActiveEditorComponent = activeEditorContribution?.component ?? null;

  if (!authenticated) {
    return (
      <LoginView
        busy={loginBusy}
        error={loginError}
        onLogin={async (username, password) => {
          setLoginBusy(true);
          setLoginError(null);
          try {
            await api.login(username, password);
            requestWorkbenchKeyboardLock();
            setAuthenticated(true);
          } catch (error) {
            setLoginError((error as Error).message);
          } finally {
            setLoginBusy(false);
          }
        }}
      />
    );
  }

  return (
    <div className="workbench-shell" onPointerDown={() => requestWorkbenchKeyboardLock()}>
      <CommandPalette
        emptyMessage={
          commandPaletteMode === "themeGroupCreate"
            ? "Type a theme group id such as atlas-notes or sketch/blueprint."
            : undefined
        }
        open={commandPaletteOpen}
        onSubmitQuery={() => {
          if (commandPaletteMode !== "themeGroupCreate") {
            return;
          }

          const normalizedGroupId = normalizeThemeGroupId(commandQuery);
          if (!normalizedGroupId) {
            return;
          }

          setCommandPaletteOpen(false);
          if ((themeGroupsPayload?.groups ?? []).some((group) => group.groupId === normalizedGroupId)) {
            void openThemeGroupConfigDocument(normalizedGroupId);
            return;
          }

          void createThemeGroupDocument(normalizedGroupId);
        }}
        title={
          commandPaletteMode === "commands"
            ? "Command Palette"
            : commandPaletteMode === "themes"
              ? "Choose Theme"
              : commandPaletteMode === "editors"
                ? "Reopen With Editor"
                : "Create Theme Group"
        }
        placeholder={
          commandPaletteMode === "commands"
            ? "Type a command"
            : commandPaletteMode === "themes"
              ? "Type a theme"
              : commandPaletteMode === "editors"
                ? "Type an editor"
                : "Type a theme group id"
        }
        query={commandQuery}
        selectedIndex={selectedPaletteIndex}
        items={paletteItems}
        onQueryChange={setCommandQuery}
        onClose={() => setCommandPaletteOpen(false)}
        onSelectIndex={setSelectedPaletteIndex}
        onExecute={(id) => {
          if (commandPaletteMode === "themes") {
            setThemeId(id);
            setCommandPaletteOpen(false);
            return;
          }
          if (commandPaletteMode === "themeGroupCreate") {
            setCommandPaletteOpen(false);
            const normalizedGroupId = normalizeThemeGroupId(commandQuery);
            if (!normalizedGroupId) {
              return;
            }

            if ((themeGroupsPayload?.groups ?? []).some((group) => group.groupId === normalizedGroupId)) {
              void openThemeGroupConfigDocument(normalizedGroupId);
              return;
            }

            void createThemeGroupDocument(normalizedGroupId);
            return;
          }
          if (commandPaletteMode === "editors") {
            setCommandPaletteOpen(false);
            workbenchApiRef.current?.reopenActiveDocumentWithEditor(id);
            return;
          }
          const command = pluginRuntime.getCommand(id);
          if (!command || !workbenchApiRef.current) {
            return;
          }
          setCommandPaletteOpen(false);
          void command.handler(workbenchApiRef.current);
        }}
      />

      {fileDialog ? (
        <div className="dialog-backdrop" onClick={() => setFileDialog(null)} role="presentation">
          <div className="dialog-card" onClick={(event) => event.stopPropagation()}>
            <p className="title-overline">File System</p>
            <h2>
              {fileDialog.mode === "create-file"
                ? "New File"
                : fileDialog.mode === "create-directory"
                  ? "New Folder"
                  : fileDialog.mode === "rename"
                    ? "Rename Entry"
                    : "Delete Entry"}
            </h2>
            {fileDialog.mode === "delete" ? (
              <p className="body-muted">Delete "{fileDialog.value}" and its nested content if applicable?</p>
            ) : (
              <>
                <label>
                  <span>{fileDialog.entryType === "file" && fileDialog.fileKind === "article" ? "Title" : "Name"}</span>
                  <input value={fileDialog.value} onChange={(event) => setFileDialog({ ...fileDialog, value: event.target.value })} />
                </label>
                {fileDialog.entryType === "file" && fileDialog.fileKind === "article" ? (
                  <p className="body-muted">File name: {deriveArticleFileName(fileDialog.value)}</p>
                ) : null}
                {activeMetadataDialogFields.map((field) => (
                  <label key={field.id}>
                    <span>{field.label}</span>
                    <input
                      type={field.input === "number" ? "number" : "text"}
                      placeholder={field.placeholder}
                      value={fileDialog.metadata[field.id] ?? ""}
                      onChange={(event) =>
                        setFileDialog({
                          ...fileDialog,
                          metadata: {
                            ...fileDialog.metadata,
                            [field.id]: event.target.value
                          }
                        })
                      }
                    />
                  </label>
                ))}
              </>
            )}
            <div className="dialog-actions">
              <button className="action-button ghost" onClick={() => setFileDialog(null)} type="button">
                Cancel
              </button>
              <button
                className={`action-button ${fileDialog.mode === "delete" ? "danger" : "primary"}`}
                onClick={async () => {
                  setBusyMessage("Applying file system change...");
                  try {
                    await executeFileDialogOperation(fileDialog);
                    setPageError(null);
                    setFileDialog(null);
                  } catch (error) {
                    if (error instanceof ApiRequestError && error.code === "duplicate_article_title") {
                      setTitleConflictState({
                        conflicts: error.conflicts ?? [],
                        fileDialog
                      });
                    } else {
                      setPageError((error as Error).message);
                    }
                  } finally {
                    setBusyMessage(null);
                  }
                }}
                type="button"
              >
                {fileDialog.mode === "delete" ? "Delete" : "Confirm"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {folderMetadataDialog ? (
        <div className="dialog-backdrop" onClick={() => setFolderMetadataDialog(null)} role="presentation">
          <div className="dialog-card" onClick={(event) => event.stopPropagation()}>
            <p className="title-overline">Folder Metadata</p>
            <h2>{folderMetadataDialog.name}</h2>
            <p className="body-muted">Values set here are inherited by articles in this folder (deepest ancestor wins).</p>
            {(["title", "tags", "status", "top", "date", "summary", "slug", "password"] as const).map((key) => (
              <label key={key}>
                <span>{key}</span>
                <input
                  type={key === "top" ? "number" : "text"}
                  placeholder={key === "tags" ? "tag-a, tag-b" : key === "status" ? "draft / working / published" : ""}
                  value={folderMetadataDialog[key]}
                  onChange={(event) => setFolderMetadataDialog({ ...folderMetadataDialog, [key]: event.target.value })}
                />
              </label>
            ))}
            <label>
              <span>extra (JSON)</span>
              <textarea
                rows={3}
                placeholder='{"customKey": "value"}'
                value={folderMetadataDialog.extraJson}
                onChange={(event) => setFolderMetadataDialog({ ...folderMetadataDialog, extraJson: event.target.value })}
              />
            </label>
            <div className="dialog-actions">
              <button className="action-button ghost" onClick={() => setFolderMetadataDialog(null)} type="button">
                Cancel
              </button>
              <button
                className="action-button primary"
                onClick={async () => {
                  setBusyMessage("Saving folder metadata...");
                  try {
                    const d = folderMetadataDialog;
                    const meta: Record<string, unknown> = {
                      title: d.title.trim(),
                      status: d.status.trim(),
                      date: d.date.trim(),
                      summary: d.summary.trim(),
                      slug: d.slug.trim(),
                      password: d.password.trim()
                    };
                    const tags = d.tags.split(",").map((t) => t.trim()).filter(Boolean);
                    meta.tags = tags;
                    meta.top = d.top.trim() ? Number(d.top) : "";
                    if (d.extraJson.trim()) {
                      try {
                        Object.assign(meta, JSON.parse(d.extraJson));
                      } catch {
                        setPageError("Invalid JSON in extra field.");
                        return;
                      }
                    }
                    await api.saveFileSystemMetadata(d.path, meta);
                    await loadTree();
                    setPageError(null);
                    setFolderMetadataDialog(null);
                  } catch (error) {
                    setPageError((error as Error).message);
                  } finally {
                    setBusyMessage(null);
                  }
                }}
                type="button"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {titleConflictState ? (
        <div className="dialog-backdrop" onClick={() => setTitleConflictState(null)} role="presentation">
          <div className="dialog-card" onClick={(event) => event.stopPropagation()}>
            <p className="title-overline">Duplicate Title</p>
            <h2>Article title already exists</h2>
            <p className="body-muted">
              "{titleConflictState.fileDialog.value}" already appears in these articles:
            </p>
            <div className="conflict-list">
              {titleConflictState.conflicts.map((conflict) => (
                <div className="search-result" key={conflict.path}>
                  <strong>{conflict.title}</strong>
                  <span>{conflict.path}</span>
                </div>
              ))}
            </div>
            <div className="dialog-actions">
              <button className="action-button ghost" onClick={() => setTitleConflictState(null)} type="button">
                Cancel
              </button>
              <button
                className="action-button primary"
                onClick={async () => {
                  setBusyMessage("Applying file system change...");
                  try {
                    await executeFileDialogOperation(titleConflictState.fileDialog, {
                      allowDuplicateTitle: true
                    });
                    setPageError(null);
                    setTitleConflictState(null);
                    setFileDialog(null);
                  } catch (error) {
                    setPageError((error as Error).message);
                  } finally {
                    setBusyMessage(null);
                  }
                }}
                type="button"
              >
                Continue Anyway
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {textInputDialog ? (
        <div className="dialog-backdrop" onClick={() => closeTextInputDialog(null)} role="presentation">
          <div className="dialog-card text-input-dialog" onClick={(event) => event.stopPropagation()}>
            <p className="title-overline">{textInputDialog.overline}</p>
            <h2>{textInputDialog.title}</h2>
            {textInputDialog.description ? <p className="body-muted">{textInputDialog.description}</p> : null}
            <label>
              <span>{textInputDialog.label}</span>
              <input
                placeholder={textInputDialog.placeholder}
                ref={textInputDialogInputRef}
                value={textInputDialog.value}
                onChange={(event) =>
                  setTextInputDialog({
                    ...textInputDialog,
                    error: null,
                    value: event.target.value
                  })
                }
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeTextInputDialog(null);
                    return;
                  }

                  if (event.key !== "Enter") {
                    return;
                  }

                  event.preventDefault();
                  const nextValue = textInputDialog.value.trim();
                  if (!nextValue) {
                    setTextInputDialog({
                      ...textInputDialog,
                      error: textInputDialog.emptyValueMessage
                    });
                    return;
                  }

                  closeTextInputDialog(nextValue);
                }}
              />
            </label>
            {textInputDialog.error ? <p className="body-muted">{textInputDialog.error}</p> : null}
            <div className="dialog-actions">
              <button className="action-button ghost" onClick={() => closeTextInputDialog(null)} type="button">
                Cancel
              </button>
              <button
                className="action-button primary"
                onClick={() => {
                  const nextValue = textInputDialog.value.trim();
                  if (!nextValue) {
                    setTextInputDialog({
                      ...textInputDialog,
                      error: textInputDialog.emptyValueMessage
                    });
                    return;
                  }

                  closeTextInputDialog(nextValue);
                }}
                type="button"
              >
                {textInputDialog.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {previewRenderDialogOpen ? (
        <div className="dialog-backdrop" onClick={() => setPreviewRenderDialogOpen(false)} role="presentation">
          <div className="dialog-card preview-render-dialog" onClick={(event) => event.stopPropagation()}>
            <div>
              <p className="title-overline">Preview Theme</p>
              <h2>Theme Preview Assets</h2>
              <p className="body-muted">
                Enabled theme groups contribute CSS and JS. Preview CSS follows the current workbench light or dark theme automatically.
              </p>
            </div>
            <div className="preview-render-style-list">
              {enabledThemeGroups.length === 0 ? (
                <p className="body-muted">No enabled theme groups yet.</p>
              ) : (
                enabledThemeGroups.map((group) => (
                  <div className="preview-render-style-item" key={group.groupId}>
                    <div>
                      <strong>{group.label}</strong>
                      <span>{group.groupId} | site mode {group.mode}</span>
                    </div>
                    <div className="search-result">
                      {group.files.map((file) => (
                        <span key={`${group.groupId}:${file.fileName}`}>
                          {file.fileName}
                          {file.type === "css" ? ` | ${file.colorMode}` : ""}
                          {file.adminPreview ? " | preview" : ""}
                        </span>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="dialog-actions">
              <button className="action-button primary" onClick={() => setPreviewRenderDialogOpen(false)} type="button">
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {contextMenuState ? (
        <div className="context-menu-backdrop" onClick={() => setContextMenuState(null)} role="presentation">
          <div className="context-menu" ref={contextMenuRef} style={{ left: contextMenuPos.left, top: contextMenuPos.top }} onClick={(event) => event.stopPropagation()}>
            {[
              ["new-file", "New File"],
              ["new-directory", "New Folder"],
              ["rename", "Rename"],
              ["edit-metadata", "Edit Metadata"],
              ["copy", "Copy"],
              ["cut", "Cut"],
              ["paste", "Paste"],
              ["delete", "Delete"]
            ].map(([action, label]) => (
              <button
                className={`context-menu-item ${action === "delete" ? "danger" : ""}`}
                disabled={(action === "paste" && !treeClipboard) || ((action === "rename" || action === "copy" || action === "cut" || action === "delete") && !contextTargetNode) || (action === "edit-metadata" && (!contextTargetNode || contextTargetNode.type !== "directory"))}
                key={action}
                onClick={() => {
                  const targetNode = contextTargetNode;
                  const targetDirectory =
                    !targetNode
                      ? ""
                      : targetNode.type === "directory"
                        ? targetNode.path
                        : getParentPath(targetNode.path);
                  setContextMenuState(null);
                  if (action === "copy" && targetNode) {
                    setTreeClipboard({ path: targetNode.path, mode: "copy" });
                    return;
                  }
                  if (action === "cut" && targetNode) {
                    setTreeClipboard({ path: targetNode.path, mode: "move" });
                    return;
                  }
                  if (action === "paste" && treeClipboard) {
                    setBusyMessage("Applying file operation...");
                    api.transferFileSystemEntry(treeClipboard.path, targetDirectory, treeClipboard.mode)
                      .then(async (result) => {
                        await loadTree();
                        if (treeClipboard.mode === "move") {
                          setDocuments((current) => remapDocuments(current, treeClipboard.path, result.path));
                          draftValuesRef.current = remapArticleDraftValues(
                            draftValuesRef.current,
                            treeClipboard.path,
                            result.path
                          );
                          remapStoredArticleCursorStates(treeClipboard.path, result.path);
                          setCollapsedTreePaths((current) =>
                            remapCollapsedTreePaths(current, treeClipboard.path, result.path)
                          );
                          setTreeClipboard(null);
                        }
                        setSelectedTreePath(result.path);
                      })
                      .catch((error: Error) => setPageError(error.message))
                      .finally(() => setBusyMessage(null));
                    return;
                  }
                  if (action === "edit-metadata" && targetNode && targetNode.type === "directory") {
                    void openFolderMetadataDialog(targetNode);
                    return;
                  }
                  if (action === "new-file" || action === "new-directory") {
                    setFileDialog({
                      entryType: action === "new-file" ? "file" : "directory",
                      fileKind: action === "new-file" ? "article" : undefined,
                      mode: action === "new-file" ? "create-file" : "create-directory",
                      path: targetDirectory,
                      value: action === "new-file" ? "New File" : "new-folder",
                      metadata: getCreateDialogMetadataDefaults(action === "new-file" ? "file" : "directory")
                    });
                  } else if (action === "rename" && targetNode) {
                    void openRenameDialog(targetNode);
                  } else if (action === "delete" && targetNode) {
                    setFileDialog({
                      entryType: targetNode.type === "directory" ? "directory" : "file",
                      fileKind: targetNode.type === "file" ? targetNode.fileKind : undefined,
                      mode: "delete",
                      path: targetNode.path,
                      value: targetNode.name,
                      metadata: {}
                    });
                  }
                }}
                type="button"
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="activity-bar">
        <div className="activity-brand">KB</div>
        {sidebarModules.map((group) => (
          <button
            aria-label={group.title}
            className={`activity-button ${sidebarVisible && sidebarGroupId === group.id ? "is-active" : ""}`}
            key={group.id}
            onClick={() => {
              setSidebarGroupId(group.id);
              setActivePaneByGroup((current) =>
                current[group.id]
                  ? current
                  : {
                      ...current,
                      [group.id]: groupedPanes[group.id]?.[0]?.paneId ?? ""
                    }
              );
              setSidebarVisible((current) => (sidebarGroupId === group.id ? !current : true));
            }}
            title={group.title}
            type="button"
          >
            <ActivityIcon icon={group.icon} />
          </button>
        ))}
        <button
          aria-label="Command Palette"
          className="activity-button bottom"
          onClick={() => openPalette("commands")}
          title="Command Palette"
          type="button"
        >
          <ActivityIcon icon="command" />
        </button>
      </div>

      <div
        className="main-shell"
        style={{
          gridTemplateColumns: sidebarVisible ? `${sidebarWidth}px 8px 1fr` : "0 0 1fr"
        }}
      >
        <aside
          className={`sidebar-panel ${sidebarVisible ? "" : "is-collapsed"}`}
          style={sidebarVisible ? { minWidth: `${sidebarWidth}px`, width: `${sidebarWidth}px` } : undefined}
        >
          {sidebarVisible ? (
            <div className="sidebar-host">
              <div className="sidebar-pane-tabs">
                {activeGroupPanes.map((pane) => (
                  <button
                    className={`sidebar-pane-tab ${pane.paneId === activePaneId ? "is-active" : ""}`}
                    key={`${sidebarGroupId}:${pane.paneId}`}
                    onClick={() =>
                      setActivePaneByGroup((current) => ({
                        ...current,
                        [sidebarGroupId]: pane.paneId
                      }))
                    }
                    title={pane.title}
                    type="button"
                  >
                    {pane.tabLabel}
                  </button>
                ))}
              </div>
              {renderSidebarPaneContent()}
            </div>
          ) : null}
        </aside>

        <div
          className={`panel-resizer ${sidebarVisible ? "" : "is-hidden"}`}
          onPointerDown={(event) => startResize("sidebar", event.clientX)}
          role="presentation"
        />

        <section
          className={`workspace-grid ${previewPaneVisible ? "with-preview" : ""}`}
          style={
            previewPaneVisible
              ? { gridTemplateColumns: `minmax(0, 1fr) 8px ${previewWidth}px` }
              : undefined
          }
        >
          <div className="editor-group">
            <div className="tab-bar">
              {documents.map((document) => (
                <button
                  className={`tab-button ${document.id === activeDocumentId ? "is-active" : ""}`}
                  key={document.id}
                  onClick={() => activateDocument(document.id)}
                  type="button"
                >
                  <span>{document.title}</span>
                  {document.dirty ? <span className="dirty-dot">*</span> : null}
                  {document.kind !== "home" ? (
                    <span
                      className="tab-close"
                      onClick={(event) => {
                        event.stopPropagation();
                        const nextDocuments = closeDocument(documents, document.id);
                        setDocuments(nextDocuments);
                        if (activeDocumentId === document.id) {
                          const closedIndex = documents.findIndex((candidate) => candidate.id === document.id);
                          activateDocument(nextDocuments[Math.max(0, closedIndex - 1)]?.id ?? HOME_DOCUMENT_ID);
                        }
                      }}
                      role="presentation"
                    >
                      x
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="editor-surface">
              {activeDocument ? (
                ActiveEditorComponent ? (
                  <ActiveEditorComponent
                    api={workbenchApi}
                    adminHomeValue={adminHomePayload?.value ?? null}
                    articleSummaries={treePayload?.articles ?? []}
                    document={activeDocument}
                    homeWidgets={homeWidgetContributions}
                    onChange={handleDocumentValueChange}
                    onChangeHomeConfig={updateAdminHomeConfigValue}
                    onModelContentChange={handleEditorModelContentChange}
                    onMount={handleEditorMount}
                    path={getDocumentPath(activeDocument, null)}
                    value={getRenderDraftValue(activeDocument)}
                  />
                ) : (
                  <div className="empty-editor">No editor is available for this document.</div>
                )
              ) : (
                <div className="empty-editor">Open an article or config document.</div>
              )}
            </div>
          </div>

          {previewPaneVisible ? (
            <>
              <div
                className="panel-resizer vertical"
                onPointerDown={(event) => startResize("preview", event.clientX)}
                role="presentation"
              />
              <aside className="preview-group">
                <button
                  className="action-button ghost preview-float-button"
                  onClick={() => setPreviewRenderDialogOpen(true)}
                  type="button"
                >
                  Theme Preview
                </button>
                <div className="preview-scroll" ref={attachPreviewRef}>
                  <div className="preview-shadow-host" ref={attachPreviewSurfaceRef} />
                </div>
              </aside>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}
