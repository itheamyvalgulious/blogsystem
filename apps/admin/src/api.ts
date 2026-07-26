import type {
  AdminHomeConfig,
  AiCompletionConfig,
  ArticleRecord,
  ArticleSummary,
  ContentTreeNode,
  EditorKeybinding,
  EditorSnippet,
  FileSystemNode,
  MarkdownBlockConfig,
  ProjectLogRecord,
  ProjectSummary,
  ProjectTaskRecord,
  ThemeGroupConfig,
  ThemeGroupSummary,
  TagInfo,
  UsageStats
} from "@blog-system/content-core";

export class ApiRequestError extends Error {
  readonly code?: string;
  readonly conflicts?: Array<{ path: string; title: string }>;
  readonly status: number;
  /** Publish target identifier (e.g. "github", "cloudflare") when the failure originated in publish. */
  readonly target?: string;
  /** Phase within the target where the failure occurred (e.g. "upload-assets"). */
  readonly phase?: string;
  /** Provider HTTP status code, if any. */
  readonly providerStatus?: number;
  /** Provider error body excerpt, if any. */
  readonly detail?: string;

  constructor(
    status: number,
    payload:
      | {
          code?: string;
          conflicts?: Array<{ path: string; title: string }>;
          error?: string;
          target?: string;
          phase?: string;
          status?: number;
          detail?: string;
        }
      | null
  ) {
    super(payload?.error ?? `Request failed with ${status}`);
    this.status = status;
    this.code = payload?.code;
    this.conflicts = payload?.conflicts;
    this.target = payload?.target;
    this.phase = payload?.phase;
    this.providerStatus = payload?.status;
    this.detail = payload?.detail;
  }
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as {
      code?: string;
      conflicts?: Array<{ path: string; title: string }>;
      error?: string;
      target?: string;
      phase?: string;
      status?: number;
      detail?: string;
    } | null;
    throw new ApiRequestError(response.status, payload);
  }

  return (await response.json()) as T;
}

export interface TreePayload {
  articles: ArticleSummary[];
  tree: ContentTreeNode[];
  fileTree: FileSystemNode[];
  tags: TagInfo[];
}

export type GlobalMarkdownSearchScope = "body" | "wholeFile";

export interface GlobalMarkdownSearchRequest {
  flags?: string;
  pattern: string;
  replace: string;
  scope: GlobalMarkdownSearchScope;
}

export interface GlobalMarkdownSearchReplaceNextRequest extends GlobalMarkdownSearchRequest {
  matchKey: string;
}

export interface GlobalMarkdownSearchMatch {
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

export interface GlobalMarkdownSearchFileResult {
  matchCount: number;
  matches: GlobalMarkdownSearchMatch[];
  path: string;
}

export interface GlobalMarkdownSearchSkippedFile {
  path: string;
  reason: string;
}

export interface GlobalMarkdownSearchSummary {
  filesMatched: number;
  filesScanned: number;
  matchesFound: number;
  skippedCount: number;
}

export interface GlobalMarkdownSearchApplied {
  changedPaths: string[];
  nextSelectionKey: string | null;
  replacementsMade: number;
}

export interface GlobalMarkdownSearchResponse {
  applied?: GlobalMarkdownSearchApplied;
  results: GlobalMarkdownSearchFileResult[];
  skipped: GlobalMarkdownSearchSkippedFile[];
  summary: GlobalMarkdownSearchSummary;
}

export interface EditorConfigPayload {
  editorAssociations: Record<string, string>;
  editorAssociationsRaw: string;
  markdownSnippets: EditorSnippet[];
  latexSnippets: EditorSnippet[];
  keybindings: EditorKeybinding[];
  markdownSnippetsRaw: string;
  latexSnippetsRaw: string;
  keybindingsRaw: string;
  warnings: string[];
}

export interface SiteConfigPayload {
  raw: string;
  value: Record<string, unknown>;
}

export interface PublishConfigPayload {
  raw: string;
  value: {
    defaultTarget: "github" | "cloudflare";
    targets: {
      cloudflare?: Record<string, unknown>;
      github?: Record<string, unknown>;
    };
  };
}

export interface MarkdownBlockConfigPayload {
  raw: string;
  value: MarkdownBlockConfig;
}

export interface AiCompletionConfigPayload {
  raw: string;
  value: AiCompletionConfig;
  status: {
    enabled: boolean;
    model: string;
    baseUrl: string;
  };
}

export interface ThemeGroupsPayload {
  groups: ThemeGroupSummary[];
}

export interface ThemeGroupPayload {
  groupId: string;
  raw: string;
  value: ThemeGroupConfig;
}

export interface ThemeAssetPayload {
  adminPreview: boolean;
  assetPath: string;
  colorMode?: "light" | "dark";
  fileName: string;
  groupId: string;
  // Server payloads are only css/javascript; "json" appears in the
  // client-built payload for a group's theme.json document.
  language: "css" | "javascript" | "json";
  raw: string;
  type: "css" | "js";
}

export interface AdminHomeConfigPayload {
  raw: string;
  value: AdminHomeConfig;
}

export interface UsageStatsPayload {
  raw: string;
  value: UsageStats;
}

export interface ClipboardAssetPayload {
  fileName: string;
  relativePath: string;
  markdownPath: string;
}

export interface MediaAssetPayload {
  fileName: string;
  mimeType: string;
  relativePath: string;
  size: number;
  urlPath: string;
}

export interface GitChangedFilePayload {
  path: string;
  status: string;
}

export interface GitCommitPayload {
  hash: string;
  message: string;
  timestamp: string;
}

export interface FileSystemMetadataPayload {
  metadata: Record<string, unknown>;
  type: "directory" | "file";
}

export interface ProjectsPayload {
  projects: ProjectSummary[];
}

export interface ProjectPayload {
  raw: string;
  value: ProjectSummary;
}

export interface ProjectTasksPayload {
  projectId: string;
  tasks: ProjectTaskRecord[];
}

export interface ProjectTaskPayload {
  projectId: string;
  raw: string;
  value: ProjectTaskRecord;
}

export interface ProjectLogsPayload {
  logs: ProjectLogRecord[];
  projectId: string;
}

export interface ProjectLogPayload {
  projectId: string;
  raw: string;
  value: ProjectLogRecord;
}

export const api = {
  login(username: string, password: string) {
    return request<{ ok: true; username: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    });
  },
  logout() {
    return request<{ ok: true }>("/api/auth/logout", {
      method: "POST"
    });
  },
  getTree() {
    return request<TreePayload>("/api/tree");
  },
  previewGlobalMarkdownSearch(input: GlobalMarkdownSearchRequest) {
    return request<GlobalMarkdownSearchResponse>("/api/search/markdown/preview", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  replaceNextGlobalMarkdownMatch(input: GlobalMarkdownSearchReplaceNextRequest) {
    return request<GlobalMarkdownSearchResponse>("/api/search/markdown/replace-next", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  replaceAllGlobalMarkdownMatches(input: GlobalMarkdownSearchRequest) {
    return request<GlobalMarkdownSearchResponse>("/api/search/markdown/replace-all", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  getArticle(articlePath: string) {
    return request<ArticleRecord>(`/api/article?path=${encodeURIComponent(articlePath)}`);
  },
  saveArticle(articlePath: string, rawContent: string) {
    return request<ArticleRecord>("/api/article", {
      method: "PUT",
      body: JSON.stringify({
        path: articlePath,
        rawContent
      })
    });
  },
  updateStatus(articlePath: string, status: "draft" | "working" | "published") {
    return request<ArticleRecord>("/api/article/status", {
      method: "POST",
      body: JSON.stringify({
        path: articlePath,
        status
      })
    });
  },
  getEditorConfig() {
    return request<EditorConfigPayload>("/api/editor-config");
  },
  saveEditorConfig(
    markdownSnippetsRaw: string,
    latexSnippetsRaw: string,
    keybindingsRaw: string,
    editorAssociationsRaw: string
  ) {
    return request<EditorConfigPayload>("/api/editor-config", {
      method: "PUT",
      body: JSON.stringify({
        markdownSnippetsRaw,
        latexSnippetsRaw,
        keybindingsRaw,
        editorAssociationsRaw
      })
    });
  },
  getSiteConfig() {
    return request<SiteConfigPayload>("/api/site-config");
  },
  saveSiteConfig(raw: string) {
    return request<SiteConfigPayload>("/api/site-config", {
      method: "PUT",
      body: JSON.stringify({ raw })
    });
  },
  getPublishConfig() {
    return request<PublishConfigPayload>("/api/publish-config");
  },
  savePublishConfig(raw: string) {
    return request<PublishConfigPayload>("/api/publish-config", {
      method: "PUT",
      body: JSON.stringify({ raw })
    });
  },
  getAiCompletionConfig() {
    return request<AiCompletionConfigPayload>("/api/ai/completion-config");
  },
  saveAiCompletionConfig(raw: string) {
    return request<AiCompletionConfigPayload>("/api/ai/completion-config", {
      method: "PUT",
      body: JSON.stringify({ raw })
    });
  },
  requestAiInlineCompletion(input: { prefix: string; suffix: string; language: "markdown" | "latex" }) {
    return request<{ completion: string }>("/api/ai/completion", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  getMarkdownBlockConfig() {
    return request<MarkdownBlockConfigPayload>("/api/markdown-block-config");
  },
  saveMarkdownBlockConfig(raw: string) {
    return request<MarkdownBlockConfigPayload>("/api/markdown-block-config", {
      method: "PUT",
      body: JSON.stringify({ raw })
    });
  },
  getAdminHomeConfig() {
    return request<AdminHomeConfigPayload>("/api/admin-home-config");
  },
  saveAdminHomeConfig(raw: string) {
    return request<AdminHomeConfigPayload>("/api/admin-home-config", {
      method: "PUT",
      body: JSON.stringify({ raw })
    });
  },
  getUsageStats() {
    return request<UsageStatsPayload>("/api/usage-stats");
  },
  recordUsageStats(input: {
    activeMilliseconds?: number;
    documents?: Array<{
      documentId: string;
      documentKind: string;
      title: string;
      netCharacterDelta: number;
    }>;
  }) {
    return request<UsageStatsPayload>("/api/usage-stats", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  listProjects() {
    return request<ProjectsPayload>("/api/projects");
  },
  createProject(input: { title: string; goal?: string; targetDate?: string }) {
    return request<ProjectPayload>("/api/project/create", {
      method: "POST",
      body: JSON.stringify(input)
    });
  },
  getProject(projectId: string) {
    return request<ProjectPayload>(`/api/project?projectId=${encodeURIComponent(projectId)}`);
  },
  saveProject(projectId: string, raw: string) {
    return request<ProjectPayload>("/api/project", {
      method: "PUT",
      body: JSON.stringify({ projectId, raw })
    });
  },
  deleteProject(projectId: string) {
    return request<{ projectId: string }>("/api/project/delete", {
      method: "POST",
      body: JSON.stringify({ projectId })
    });
  },
  listProjectTasks(projectId: string) {
    return request<ProjectTasksPayload>(`/api/project/tasks?projectId=${encodeURIComponent(projectId)}`);
  },
  createProjectTask(projectId: string, title: string) {
    return request<ProjectTaskPayload>("/api/project/task/create", {
      method: "POST",
      body: JSON.stringify({ projectId, title })
    });
  },
  getProjectTask(projectId: string, taskId: string) {
    return request<ProjectTaskPayload>(
      `/api/project/task?projectId=${encodeURIComponent(projectId)}&taskId=${encodeURIComponent(taskId)}`
    );
  },
  saveProjectTask(projectId: string, taskId: string, raw: string) {
    return request<ProjectTaskPayload>("/api/project/task", {
      method: "PUT",
      body: JSON.stringify({ projectId, taskId, raw })
    });
  },
  listProjectLogs(projectId: string) {
    return request<ProjectLogsPayload>(`/api/project/logs?projectId=${encodeURIComponent(projectId)}`);
  },
  createProjectLog(projectId: string, input?: { taskId?: string; taskIds?: string[]; type?: string }) {
    return request<ProjectLogPayload>("/api/project/log/create", {
      method: "POST",
      body: JSON.stringify({
        projectId,
        taskId: input?.taskId,
        taskIds: input?.taskIds,
        type: input?.type
      })
    });
  },
  getProjectLog(projectId: string, logId: string) {
    return request<ProjectLogPayload>(
      `/api/project/log?projectId=${encodeURIComponent(projectId)}&logId=${encodeURIComponent(logId)}`
    );
  },
  saveProjectLog(projectId: string, logId: string, raw: string) {
    return request<ProjectLogPayload>("/api/project/log", {
      method: "PUT",
      body: JSON.stringify({ projectId, logId, raw })
    });
  },
  listThemeGroups() {
    return request<ThemeGroupsPayload>("/api/theme-groups");
  },
  getThemeGroup(groupId: string) {
    return request<ThemeGroupPayload>(`/api/theme-group?group=${encodeURIComponent(groupId)}`);
  },
  saveThemeGroup(groupId: string, raw: string) {
    return request<ThemeGroupPayload>("/api/theme-group", {
      method: "PUT",
      body: JSON.stringify({ groupId, raw })
    });
  },
  createThemeGroup(groupId: string) {
    return request<ThemeGroupPayload>("/api/theme-group/create", {
      method: "POST",
      body: JSON.stringify({ groupId })
    });
  },
  renameThemeGroup(groupId: string, nextGroupId: string) {
    return request<ThemeGroupPayload>("/api/theme-group/rename", {
      method: "POST",
      body: JSON.stringify({ groupId, nextGroupId })
    });
  },
  deleteThemeGroup(groupId: string) {
    return request<{ groupId: string }>("/api/theme-group/delete", {
      method: "POST",
      body: JSON.stringify({ groupId })
    });
  },
  getThemeAsset(groupId: string, fileName: string) {
    return request<ThemeAssetPayload>(
      `/api/theme-asset?group=${encodeURIComponent(groupId)}&file=${encodeURIComponent(fileName)}`
    );
  },
  saveThemeAsset(groupId: string, fileName: string, raw: string) {
    return request<ThemeAssetPayload>("/api/theme-asset", {
      method: "PUT",
      body: JSON.stringify({ groupId, fileName, raw })
    });
  },
  createThemeAsset(
    groupId: string,
    fileName: string,
    type: "css" | "js",
    adminPreview: boolean,
    colorMode?: "light" | "dark"
  ) {
    return request<ThemeAssetPayload>("/api/theme-asset/create", {
      method: "POST",
      body: JSON.stringify({ groupId, fileName, type, adminPreview, colorMode })
    });
  },
  renameThemeAsset(groupId: string, fileName: string, nextFileName: string) {
    return request<ThemeAssetPayload>("/api/theme-asset/rename", {
      method: "POST",
      body: JSON.stringify({ groupId, fileName, nextFileName })
    });
  },
  deleteThemeAsset(groupId: string, fileName: string) {
    return request<{ assetPath: string; fileName: string; groupId: string }>("/api/theme-asset/delete", {
      method: "POST",
      body: JSON.stringify({ groupId, fileName })
    });
  },
  createFileSystemEntry(
    parentPath: string,
    entryType: "file" | "directory",
    name: string,
    metadata?: Record<string, string>,
    options?: {
      allowDuplicateTitle?: boolean;
    }
  ) {
    return request<{ path: string }>("/api/fs/create", {
      method: "POST",
      body: JSON.stringify({
        parentPath,
        entryType,
        name,
        metadata,
        allowDuplicateTitle: options?.allowDuplicateTitle
      })
    });
  },
  renameFileSystemEntry(
    path: string,
    nextName: string,
    options?: {
      allowDuplicateTitle?: boolean;
      title?: string;
    }
  ) {
    return request<{ path: string }>("/api/fs/rename", {
      method: "POST",
      body: JSON.stringify({
        path,
        nextName,
        title: options?.title,
        allowDuplicateTitle: options?.allowDuplicateTitle
      })
    });
  },
  getFileSystemMetadata(path: string) {
    return request<FileSystemMetadataPayload>(`/api/fs/metadata?path=${encodeURIComponent(path)}`);
  },
  saveFileSystemMetadata(path: string, metadata: Record<string, unknown>) {
    return request<{ type: "directory" | "file" }>("/api/fs/metadata", {
      method: "POST",
      body: JSON.stringify({ path, metadata })
    });
  },
  deleteFileSystemEntry(path: string) {
    return request<{ ok: true }>("/api/fs/delete", {
      method: "POST",
      body: JSON.stringify({ path })
    });
  },
  transferFileSystemEntry(sourcePath: string, targetDirectoryPath: string, mode: "copy" | "move") {
    return request<{ path: string }>("/api/fs/transfer", {
      method: "POST",
      body: JSON.stringify({
        sourcePath,
        targetDirectoryPath,
        mode
      })
    });
  },
  uploadPastedImages(
    articlePath: string,
    images: Array<{ mimeType: string; base64Data: string; fileName?: string }>
  ) {
    return request<{ assets: ClipboardAssetPayload[] }>("/api/assets/paste-image", {
      method: "POST",
      body: JSON.stringify({
        articlePath,
        images
      })
    });
  },
  listMediaAssets() {
    return request<{ assets: MediaAssetPayload[] }>("/api/media");
  },
  uploadMediaAssets(images: Array<{ mimeType: string; base64Data: string; fileName?: string }>) {
    return request<{ assets: ClipboardAssetPayload[] }>("/api/media", {
      method: "POST",
      body: JSON.stringify({ images })
    });
  },
  getGitStatus() {
    return request<{ files: GitChangedFilePayload[]; initialized: boolean }>("/api/git/status");
  },
  getGitHistory() {
    return request<{ commits: GitCommitPayload[]; initialized: boolean }>("/api/git/history");
  },
  initGitRepository() {
    return request<{ message: string }>("/api/git/init", {
      method: "POST"
    });
  },
  createGitCommit(message: string) {
    return request<{ message: string }>("/api/git/commit", {
      method: "POST",
      body: JSON.stringify({ message })
    });
  },
  pushGitChanges() {
    return request<{ message: string }>("/api/git/push", {
      method: "POST"
    });
  },
  publishSite() {
    return request<{
      stdout: string;
      stderr: string;
      target: string;
      url?: string;
      deploymentId?: string;
      uploaded: number;
      skipped: number;
      durationMs: number;
    }>("/api/publish", {
      method: "POST"
    });
  }
};
