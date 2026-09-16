import type {
  ConfigDocumentKind,
  WorkbenchDocument,
  WorkbenchResourceTarget
} from "./workbench/types";

const CONFIG_DOCUMENT_KINDS = new Set<ConfigDocumentKind>([
  "aiCompletion",
  "markdownBlockConfig",
  "markdownSnippets",
  "latexSnippets",
  "keybindings",
  "editorAssociations",
  "publishConfig",
  "siteConfig"
]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function matchesPathPrefix(path: string, prefix: string) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function replacePathPrefix(path: string, fromPrefix: string, toPrefix: string) {
  if (path === fromPrefix) {
    return toPrefix;
  }

  return `${toPrefix}${path.slice(fromPrefix.length)}`;
}

export function serializeWorkbenchResource(document: WorkbenchDocument | null): WorkbenchResourceTarget | null {
  if (!document) {
    return null;
  }

  switch (document.kind) {
    case "home":
      return { kind: "home" };
    case "usageStats":
      return {
        kind: "usageStats",
        preferredEditorId: document.editorId
      };
    case "article":
      return {
        kind: "article",
        articlePath: document.articlePath,
        preferredEditorId: document.editorId
      };
    case "config":
      return {
        kind: "config",
        configKind: document.configKind,
        preferredEditorId: document.editorId
      };
    case "project":
      return {
        kind: "project",
        projectId: document.projectId,
        preferredEditorId: document.editorId
      };
    case "projectTask":
      return {
        kind: "projectTask",
        projectId: document.projectId,
        taskId: document.taskId,
        preferredEditorId: document.editorId
      };
    case "projectLog":
      return {
        kind: "projectLog",
        logId: document.logId,
        projectId: document.projectId,
        preferredEditorId: document.editorId
      };
    case "themeAsset":
      return document.fileName === "theme.json"
        ? {
            kind: "themeGroupConfig",
            groupId: document.groupId,
            preferredEditorId: document.editorId
          }
        : {
            kind: "themeAsset",
            fileName: document.fileName,
            groupId: document.groupId,
            preferredEditorId: document.editorId
          };
    default:
      return null;
  }
}

export function parseStoredWorkbenchResource(rawValue: string | null): WorkbenchResourceTarget | null {
  if (!rawValue) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawValue) as Record<string, unknown>;
    const preferredEditorId = isNonEmptyString(parsed.preferredEditorId)
      ? parsed.preferredEditorId
      : undefined;

    switch (parsed.kind) {
      case "home":
        return { kind: "home" };
      case "usageStats":
        return { kind: "usageStats", preferredEditorId };
      case "article":
        return isNonEmptyString(parsed.articlePath)
          ? {
              kind: "article",
              articlePath: parsed.articlePath,
              preferredEditorId
            }
          : null;
      case "config":
        return isNonEmptyString(parsed.configKind) && CONFIG_DOCUMENT_KINDS.has(parsed.configKind as ConfigDocumentKind)
          ? {
              kind: "config",
              configKind: parsed.configKind as ConfigDocumentKind,
              preferredEditorId
            }
          : null;
      case "project":
        return isNonEmptyString(parsed.projectId)
          ? {
              kind: "project",
              projectId: parsed.projectId,
              preferredEditorId
            }
          : null;
      case "projectTask":
        return isNonEmptyString(parsed.projectId) && isNonEmptyString(parsed.taskId)
          ? {
              kind: "projectTask",
              projectId: parsed.projectId,
              taskId: parsed.taskId,
              preferredEditorId
            }
          : null;
      case "projectLog":
        return isNonEmptyString(parsed.projectId) && isNonEmptyString(parsed.logId)
          ? {
              kind: "projectLog",
              logId: parsed.logId,
              projectId: parsed.projectId,
              preferredEditorId
            }
          : null;
      case "themeAsset":
        return isNonEmptyString(parsed.groupId) && isNonEmptyString(parsed.fileName)
          ? {
              kind: "themeAsset",
              fileName: parsed.fileName,
              groupId: parsed.groupId,
              preferredEditorId
            }
          : null;
      case "themeGroupConfig":
        return isNonEmptyString(parsed.groupId)
          ? {
              kind: "themeGroupConfig",
              groupId: parsed.groupId,
              preferredEditorId
            }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function parseStoredCollapsedTreePaths(rawValue: string | null) {
  if (!rawValue) {
    return new Set<string>();
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;
    return new Set(
      Array.isArray(parsed)
        ? parsed.filter((entry): entry is string => isNonEmptyString(entry))
        : []
    );
  } catch {
    return new Set<string>();
  }
}

export function serializeCollapsedTreePaths(paths: Iterable<string>) {
  return JSON.stringify(
    Array.from(
      new Set(Array.from(paths).filter((path) => path.length > 0))
    ).sort((left, right) => left.localeCompare(right))
  );
}

export function remapCollapsedTreePaths(
  paths: ReadonlySet<string>,
  fromPath: string,
  toPath: string
) {
  const nextPaths = new Set<string>();

  for (const path of paths) {
    nextPaths.add(
      matchesPathPrefix(path, fromPath)
        ? replacePathPrefix(path, fromPath, toPath)
        : path
    );
  }

  return nextPaths;
}

export function removeCollapsedTreePaths(paths: ReadonlySet<string>, targetPath: string) {
  return new Set(
    Array.from(paths).filter((path) => !matchesPathPrefix(path, targetPath))
  );
}

export type SortOrder = "date-inc" | "date-dec" | "title-inc" | "title-dec";
export type StatusFilter = "all" | "draft" | "working" | "published";

export interface FilePaneFilters {
  searchQuery: string;
  tagFilter: string;
  statusFilter: StatusFilter;
  sortOrder: SortOrder;
  showAssets: boolean;
}

export const DEFAULT_FILE_PANE_FILTERS: FilePaneFilters = {
  searchQuery: "",
  tagFilter: "all",
  statusFilter: "all",
  sortOrder: "date-dec",
  showAssets: false
};

const VALID_SORT_ORDERS: ReadonlySet<string> = new Set(["date-inc", "date-dec", "title-inc", "title-dec"]);
const VALID_STATUS_FILTERS: ReadonlySet<string> = new Set(["all", "draft", "working", "published"]);

export function serializeFilePaneFilters(filters: FilePaneFilters): string {
  return JSON.stringify(filters);
}

export function parseStoredFilePaneFilters(rawValue: string | null): FilePaneFilters {
  if (!rawValue) {
    return { ...DEFAULT_FILE_PANE_FILTERS };
  }

  try {
    const parsed = JSON.parse(rawValue) as Record<string, unknown>;
    return {
      searchQuery: typeof parsed.searchQuery === "string" ? parsed.searchQuery : "",
      tagFilter: typeof parsed.tagFilter === "string" ? parsed.tagFilter : "all",
      statusFilter: typeof parsed.statusFilter === "string" && VALID_STATUS_FILTERS.has(parsed.statusFilter)
        ? parsed.statusFilter as StatusFilter
        : "all",
      sortOrder: typeof parsed.sortOrder === "string" && VALID_SORT_ORDERS.has(parsed.sortOrder)
        ? parsed.sortOrder as SortOrder
        : "date-dec",
      showAssets: typeof parsed.showAssets === "boolean" ? parsed.showAssets : false
    };
  } catch {
    return { ...DEFAULT_FILE_PANE_FILTERS };
  }
}
