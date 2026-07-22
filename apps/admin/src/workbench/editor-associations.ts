import {
  getProjectDocumentPath,
  getProjectLogDocumentPath,
  getProjectTaskDocumentPath
} from "./project-utils";
import type {
  ConfigDocumentKind,
  EditorContributionDefinition,
  WorkbenchBaseDocument,
  WorkbenchDocument
} from "./types";

const CONFIG_DOCUMENT_PATHS: Record<ConfigDocumentKind, string> = {
  editorAssociations: "config/editor.associations.json",
  keybindings: "config/keybindings.json",
  latexSnippets: "config/latex.snippets.json",
  markdownBlockConfig: "config/markdown-blocks.json",
  markdownSnippets: "config/markdown.snippets.json",
  publishConfig: "config/site-publish.local.json",
  siteConfig: "config/site.json"
};

function normalizePath(value: string) {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function getFileExtension(filePath: string) {
  const normalizedPath = normalizePath(filePath);
  const lastSlashIndex = normalizedPath.lastIndexOf("/");
  const fileName = lastSlashIndex >= 0 ? normalizedPath.slice(lastSlashIndex + 1) : normalizedPath;
  const lastDotIndex = fileName.lastIndexOf(".");

  return lastDotIndex >= 0 ? fileName.slice(lastDotIndex).toLowerCase() : "";
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function getWorkbenchDocumentPath(document: WorkbenchDocument) {
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
    return CONFIG_DOCUMENT_PATHS[document.configKind] ?? document.title;
  }

  if (document.kind === "home") {
    return "home";
  }

  if (document.kind === "usageStats") {
    return "usage-stats";
  }

  return (document as WorkbenchBaseDocument).title;
}

export function matchesEditorAssociationPattern(pattern: string, documentPath: string) {
  const normalizedPattern = normalizePath(pattern);
  const normalizedPath = normalizePath(documentPath);

  if (!normalizedPattern) {
    return false;
  }

  if (normalizedPattern.startsWith("*.")) {
    return getFileExtension(normalizedPath) === normalizedPattern.slice(1).toLowerCase();
  }

  if (normalizedPattern.includes("*")) {
    const regex = new RegExp(
      `^${normalizedPattern
        .split("*")
        .map((segment) => escapeRegex(segment))
        .join(".*")}$`,
      "i"
    );
    return regex.test(normalizedPath);
  }

  return normalizedPath.toLowerCase() === normalizedPattern.toLowerCase();
}

export function resolvePreferredEditorId(
  document: WorkbenchDocument,
  editors: EditorContributionDefinition[],
  associations: Record<string, string>
) {
  const candidateEditors = editors.filter((editor) => editor.canHandle(document));
  if (candidateEditors.length === 0) {
    return null;
  }

  const documentPath = getWorkbenchDocumentPath(document);

  for (const [pattern, editorId] of Object.entries(associations)) {
    if (!matchesEditorAssociationPattern(pattern, documentPath)) {
      continue;
    }

    const matchedEditor = candidateEditors.find((editor) => editor.editorId === editorId);
    if (matchedEditor) {
      return matchedEditor.editorId;
    }
  }

  const preferredEditor = candidateEditors.find((editor) => editor.matches?.(document));
  return preferredEditor?.editorId ?? candidateEditors[0].editorId;
}
