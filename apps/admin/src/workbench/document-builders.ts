import type { ArticleRecord } from "@blog-system/content-core";

import type {
  AiCompletionConfigPayload,
  EditorConfigPayload,
  MarkdownBlockConfigPayload,
  ProjectLogPayload,
  ProjectPayload,
  ProjectTaskPayload,
  PublishConfigPayload,
  SiteConfigPayload,
  ThemeAssetPayload,
  UsageStatsPayload
} from "../api";
import { getBaseName, getParentPath, matchesPathPrefix, replacePathPrefix } from "./path-utils";
import {
  getProjectDocumentPath,
  getProjectLogDocumentPath,
  getProjectTaskDocumentPath
} from "./project-utils";
import type {
  ArticleWorkbenchDocument,
  ConfigDocumentKind,
  ConfigWorkbenchDocument,
  HomeWorkbenchDocument,
  ProjectLogWorkbenchDocument,
  ProjectTaskWorkbenchDocument,
  ProjectWorkbenchDocument,
  ThemeAssetWorkbenchDocument,
  UsageStatsWorkbenchDocument,
  WorkbenchBaseDocument,
  WorkbenchDocument
} from "./types";

export const HOME_DOCUMENT_ID = "home:dashboard";
export const USAGE_STATS_DOCUMENT_ID = "usage-stats:overview";

export const CONFIG_DOCUMENT_META: Record<Exclude<ConfigDocumentKind, "aiCompletion" | "markdownBlockConfig" | "publishConfig" | "siteConfig">, { title: string; path: string; read: (payload: EditorConfigPayload) => string }> = {
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

const AI_COMPLETION_CONFIG_DOCUMENT_META = {
  title: "ai-completion.local.json",
  path: "config/ai-completion.local.json"
} as const;

export function getThemeAssetDocumentPath(groupId: string, fileName: string) {
  return `config/theme/${groupId}/${fileName}`;
}

export function getConfigDocumentPath(kind: ConfigDocumentKind) {
  switch (kind) {
    case "aiCompletion":
      return AI_COMPLETION_CONFIG_DOCUMENT_META.path;
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

export function getConfigDocumentTitle(kind: ConfigDocumentKind) {
  switch (kind) {
    case "aiCompletion":
      return AI_COMPLETION_CONFIG_DOCUMENT_META.title;
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

export function getJsonSchemaPaths() {
  return {
    markdownSnippetsPath: CONFIG_DOCUMENT_META.markdownSnippets.path,
    latexSnippetsPath: CONFIG_DOCUMENT_META.latexSnippets.path,
    keybindingsPath: CONFIG_DOCUMENT_META.keybindings.path,
    editorAssociationsPath: CONFIG_DOCUMENT_META.editorAssociations.path,
    markdownBlockConfigPath: MARKDOWN_BLOCK_CONFIG_DOCUMENT_META.path,
    siteConfigPath: SITE_CONFIG_DOCUMENT_META.path,
    aiCompletionConfigPath: AI_COMPLETION_CONFIG_DOCUMENT_META.path
  };
}

export function getDocumentPath(document: WorkbenchDocument | null, fallbackPath: string | null) {
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

  return fallbackPath ?? (document as WorkbenchBaseDocument).title;
}

export function shouldStoreLiveDocumentValue(document: WorkbenchDocument) {
  return (
    document.kind !== "article" &&
    document.kind !== "config" &&
    document.kind !== "themeAsset" &&
    document.kind !== "usageStats"
  );
}

export function canReadFullDocumentValueFromEditor(document: WorkbenchDocument) {
  return !shouldStoreLiveDocumentValue(document);
}

export function isArticleDocument(document: WorkbenchDocument | null): document is ArticleWorkbenchDocument {
  return Boolean(document && document.kind === "article");
}

export function isHomeDocument(document: WorkbenchDocument | null): document is HomeWorkbenchDocument {
  return Boolean(document && document.kind === "home");
}

export function isThemeAssetDocument(document: WorkbenchDocument | null): document is ThemeAssetWorkbenchDocument {
  return Boolean(document && document.kind === "themeAsset");
}

export function isProjectDocument(document: WorkbenchDocument | null): document is ProjectWorkbenchDocument {
  return Boolean(document && document.kind === "project");
}

export function isProjectTaskDocument(document: WorkbenchDocument | null): document is ProjectTaskWorkbenchDocument {
  return Boolean(document && document.kind === "projectTask");
}

export function isProjectLogDocument(document: WorkbenchDocument | null): document is ProjectLogWorkbenchDocument {
  return Boolean(document && document.kind === "projectLog");
}

export function isMarkdownCompletionDocument(document: WorkbenchDocument | null) {
  return isArticleDocument(document) || isProjectTaskDocument(document);
}

export function buildConfigDocument(
  kind: ConfigDocumentKind,
  payload:
    | AiCompletionConfigPayload
    | EditorConfigPayload
    | MarkdownBlockConfigPayload
    | PublishConfigPayload
    | SiteConfigPayload
): ConfigWorkbenchDocument {
  const value =
    kind === "aiCompletion"
      ? (payload as AiCompletionConfigPayload).raw
      : kind === "markdownBlockConfig"
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

export function buildHomeDocument(): HomeWorkbenchDocument {
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

export function buildUsageStatsDocument(payload: UsageStatsPayload): UsageStatsWorkbenchDocument {
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

export function buildArticleDocument(record: ArticleRecord): ArticleWorkbenchDocument {
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

export function buildThemeAssetDocument(payload: ThemeAssetPayload): ThemeAssetWorkbenchDocument {
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

export function buildProjectDocument(payload: ProjectPayload): ProjectWorkbenchDocument {
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

export function buildProjectTaskDocument(payload: ProjectTaskPayload): ProjectTaskWorkbenchDocument {
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

export function buildProjectLogDocument(payload: ProjectLogPayload): ProjectLogWorkbenchDocument {
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

export function upsertDocument(documents: WorkbenchDocument[], nextDocument: WorkbenchDocument) {
  const index = documents.findIndex((document) => document.id === nextDocument.id);
  if (index === -1) {
    return [...documents, nextDocument];
  }
  const nextDocuments = [...documents];
  nextDocuments[index] = nextDocument;
  return nextDocuments;
}

export function closeDocument(documents: WorkbenchDocument[], documentId: string) {
  return documents.filter((document) => document.id === HOME_DOCUMENT_ID || document.id !== documentId);
}

export function isDocumentInProject(document: WorkbenchDocument, projectId: string) {
  return (
    (document.kind === "project" ||
      document.kind === "projectTask" ||
      document.kind === "projectLog") &&
    document.projectId === projectId
  );
}

export function closeProjectDocuments(documents: WorkbenchDocument[], projectId: string) {
  return documents.filter((document) => document.kind === "home" || !isDocumentInProject(document, projectId));
}

export function removeProjectDraftValues(draftValues: Record<string, string>, projectId: string) {
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

export function remapArticleDraftValues(
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

export function removeArticleDraftValues(draftValues: Record<string, string>, targetPath: string) {
  return Object.fromEntries(
    Object.entries(draftValues).filter(
      ([key]) =>
        !key.startsWith("article:") || !matchesPathPrefix(key.slice("article:".length), targetPath)
    )
  );
}

export function remapDocuments(documents: WorkbenchDocument[], fromPath: string, toPath: string) {
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

export function removeDocuments(documents: WorkbenchDocument[], targetPath: string) {
  return documents.filter((document) => document.kind !== "article" || !matchesPathPrefix(document.articlePath, targetPath));
}
