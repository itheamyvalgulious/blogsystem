import type { ComponentType } from "react";
import type * as monacoEditor from "monaco-editor";
import type {
  EditorContentChangedEvent,
  EditorEngineServices,
  WorkbenchEditorHandle
} from "./editor-engine";
import type { SnippetCompletionMatch } from "../snippet-completion";
import type { MarkdownOutlineItem } from "../markdown-outline";

import type {
  AdminHomeConfig,
  ArticleRecord,
  ArticleSummary,
  EditorKeybinding,
  EditorSnippet,
  MarkdownFenceRendererDefinition,
  ProjectLogRecord,
  ProjectSummary,
  ProjectTaskRecord,
  UsageStats
} from "@blog-system/content-core";
import type {
  GlobalMarkdownSearchReplaceNextRequest,
  GlobalMarkdownSearchRequest,
  GlobalMarkdownSearchResponse
} from "../api";

export type PaneGroupId = string;
export type ConfigDocumentKind =
  | "aiCompletion"
  | "markdownBlockConfig"
  | "markdownSnippets"
  | "latexSnippets"
  | "keybindings"
  | "editorAssociations"
  | "siteConfig"
  | "publishConfig";
export type WorkbenchDocumentKind = string;
export type WorkbenchEditorId = string;
export type SnippetLanguageId = "markdown" | "latex";
export type WorkbenchRefreshTarget =
  | "adminHome"
  | "aiCompletion"
  | "config"
  | "markdownBlockConfig"
  | "publishConfig"
  | "usageStats"
  | "projects"
  | "siteConfig"
  | "themeGroups"
  | "tree";

export interface WorkbenchBaseDocument {
  id: string;
  kind: WorkbenchDocumentKind;
  editorId: WorkbenchEditorId;
  title: string;
  language: string;
  value: string;
  savedValue: string;
  dirty: boolean;
  previewable: boolean;
}

export interface ArticleWorkbenchDocument extends WorkbenchBaseDocument {
  kind: "article";
  articlePath: string;
  record: ArticleRecord;
}

export interface HomeWorkbenchDocument extends WorkbenchBaseDocument {
  kind: "home";
}

export interface UsageStatsWorkbenchDocument extends WorkbenchBaseDocument {
  kind: "usageStats";
  stats: UsageStats;
}

export interface ConfigWorkbenchDocument extends WorkbenchBaseDocument {
  kind: "config";
  configKind: ConfigDocumentKind;
}

export interface ThemeAssetWorkbenchDocument extends WorkbenchBaseDocument {
  kind: "themeAsset";
  assetPath: string;
  fileName: string;
  groupId: string;
  editorPath: string;
}

export interface ProjectWorkbenchDocument extends WorkbenchBaseDocument {
  kind: "project";
  projectId: string;
  record: ProjectSummary;
}

export interface ProjectTaskWorkbenchDocument extends WorkbenchBaseDocument {
  kind: "projectTask";
  projectId: string;
  record: ProjectTaskRecord;
  taskId: string;
}

export interface ProjectLogWorkbenchDocument extends WorkbenchBaseDocument {
  kind: "projectLog";
  logId: string;
  projectId: string;
  record: ProjectLogRecord;
}

// Extension point for plugin-defined documents. Kept out of the
// WorkbenchDocument union: its loose `kind: string` + index signature would
// otherwise defeat discriminated-union narrowing at every `document.kind`
// check. Nothing in the current workbench constructs generic documents.
export interface GenericWorkbenchDocument extends WorkbenchBaseDocument {
  kind: WorkbenchDocumentKind;
  [key: string]: unknown;
}

export type WorkbenchDocument =
  | ArticleWorkbenchDocument
  | ConfigWorkbenchDocument
  | HomeWorkbenchDocument
  | ProjectLogWorkbenchDocument
  | ProjectTaskWorkbenchDocument
  | ProjectWorkbenchDocument
  | ThemeAssetWorkbenchDocument
  | UsageStatsWorkbenchDocument;

export interface ThemeDefinition {
  id: string;
  label: string;
  appearance: "dark" | "light";
  cssVariables: Record<string, string>;
  monacoTheme: monacoEditor.editor.IStandaloneThemeData;
}

export interface CommandDefinition {
  id: string;
  title: string;
  keywords?: string[];
  handler: (api: WorkbenchApi) => void | Promise<void>;
}

export interface EditorActionDefinition {
  id: string;
  title: string;
  handler: (api: EditorActionApi) => boolean | Promise<boolean>;
}

export interface PasteHandlerDefinition {
  id: string;
  handle: (api: PasteHandlerApi) => boolean | Promise<boolean>;
}

export type WorkbenchContributionKind = "create-dialog" | "home-widget" | "module" | "pane";
export type CreateDialogFieldInput = "text" | "tags" | "number";

export interface CreateDialogFieldDefinition {
  id: string;
  label: string;
  appliesTo: "file" | "directory" | "both";
  input: CreateDialogFieldInput;
  defaultValue?: string;
  placeholder?: string;
}

export interface WorkbenchContributionDefinition {
  id: string;
  kind: WorkbenchContributionKind;
}

export interface CreateDialogContributionDefinition extends WorkbenchContributionDefinition {
  kind: "create-dialog";
  fields: CreateDialogFieldDefinition[];
}

export interface PaneComponentProps {
  activeDocument: WorkbenchDocument | null;
  activeArticleLineNumber: number;
  api: WorkbenchApi;
  getDocumentValue: (document: WorkbenchDocument) => string;
  projects: ProjectSummary[];
  outlineTree?: MarkdownOutlineItem[];
  activeOutlineItemId?: string | null;
}

export interface RevealLineOptions {
  column?: number;
  focus?: boolean;
  moveCursor?: boolean;
}

export interface PaneContributionDefinition extends WorkbenchContributionDefinition {
  component: ComponentType<PaneComponentProps>;
  defaultGroupId: PaneGroupId;
  kind: "pane";
  paneId: string;
  tabLabel: string;
  title: string;
}

export interface ModuleContributionDefinition extends WorkbenchContributionDefinition {
  icon: string;
  kind: "module";
  moduleId: PaneGroupId;
  order?: number;
  title: string;
}

export interface HomeWidgetComponentProps<TState = unknown> {
  setState: (nextState: TState) => void;
  state: TState | undefined;
  widgetId: string;
}

export interface HomeWidgetContributionDefinition extends WorkbenchContributionDefinition {
  component: ComponentType<HomeWidgetComponentProps>;
  kind: "home-widget";
  label: string;
  widgetId: string;
}

export type AnyWorkbenchContributionDefinition =
  | CreateDialogContributionDefinition
  | HomeWidgetContributionDefinition
  | ModuleContributionDefinition
  | PaneContributionDefinition;

export interface WorkbenchEditorComponentProps {
  api: WorkbenchApi;
  adminHomeValue: AdminHomeConfig | null;
  articleSummaries: ArticleSummary[];
  document: WorkbenchDocument;
  homeWidgets: HomeWidgetContributionDefinition[];
  onChange: (nextValue: string) => void;
  onChangeHomeConfig: (nextValue: AdminHomeConfig) => void;
  onModelContentChange?: (event: EditorContentChangedEvent) => void;
  onMount: (
    editor: WorkbenchEditorHandle,
    services: EditorEngineServices
  ) => void;
  path: string;
  value: string;
}

export interface EditorContributionDefinition {
  canHandle: (document: WorkbenchDocument) => boolean;
  component: ComponentType<WorkbenchEditorComponentProps>;
  editorId: WorkbenchEditorId;
  isDirty?: (document: WorkbenchDocument, nextValue: string) => boolean;
  label: string;
  load?: (document: WorkbenchDocument) => Promise<WorkbenchDocument> | WorkbenchDocument;
  matches?: (document: WorkbenchDocument) => boolean;
  previewSource?: (document: WorkbenchDocument, value: string) => string | null;
  save?: (
    document: WorkbenchDocument,
    nextValue: string
  ) => Promise<WorkbenchDocument | null | void> | WorkbenchDocument | null | void;
  supportsPreview?: boolean;
}

export interface MarkdownEditorFeatureDefinition {
  id: string;
  matches: (document: WorkbenchDocument) => boolean;
  onMount?: (
    editor: WorkbenchEditorHandle,
    services: EditorEngineServices,
    document: WorkbenchDocument
  ) => void | (() => void);
}

export type MarkdownFenceRendererFeatureDefinition = MarkdownFenceRendererDefinition;

export interface PluginDefinition {
  id: string;
  label: string;
  description: string;
  activate: (context: PluginSetupContext) => void;
}

export interface ClipboardImageInput {
  mimeType: string;
  base64Data: string;
  fileName?: string;
}

export interface ClipboardImageResult {
  fileName: string;
  relativePath: string;
  markdownPath: string;
}

export type ClipboardImageUploadTarget =
  | { kind: "article"; articlePath: string }
  | { kind: "media" };

export type WorkbenchResourceTarget =
  | {
      kind: "article";
      articlePath: string;
      column?: number;
      lineNumber?: number;
      preferredEditorId?: WorkbenchEditorId;
    }
  | { kind: "config"; configKind: ConfigDocumentKind; preferredEditorId?: WorkbenchEditorId }
  | { kind: "home" }
  | { kind: "usageStats"; preferredEditorId?: WorkbenchEditorId }
  | { kind: "project"; projectId: string; preferredEditorId?: WorkbenchEditorId }
  | { kind: "projectLog"; logId: string; projectId: string; preferredEditorId?: WorkbenchEditorId }
  | { kind: "projectTask"; projectId: string; preferredEditorId?: WorkbenchEditorId; taskId: string }
  | { kind: "themeAsset"; fileName: string; groupId: string; preferredEditorId?: WorkbenchEditorId }
  | { kind: "themeGroupConfig"; groupId: string; preferredEditorId?: WorkbenchEditorId };

export interface WorkbenchTextInputOptions {
  confirmLabel?: string;
  defaultValue?: string;
  description?: string;
  emptyValueMessage?: string;
  label: string;
  overline?: string;
  placeholder?: string;
  title: string;
}

export interface WorkbenchApi {
  closeProjectDocuments: (projectId: string) => void;
  hasDirtyArticleDocument: () => boolean;
  hideCommandPalette: () => void;
  openConfigDocument: (kind: ConfigDocumentKind) => Promise<void>;
  openHome: () => void;
  openResource: (target: WorkbenchResourceTarget) => Promise<void>;
  previewGlobalMarkdownSearch: (input: GlobalMarkdownSearchRequest) => Promise<GlobalMarkdownSearchResponse>;
  publishStaticSite: () => Promise<void>;
  requestTextInput: (options: WorkbenchTextInputOptions) => Promise<string | null>;
  refreshWorkspaceData: (
    target: WorkbenchRefreshTarget | WorkbenchRefreshTarget[]
  ) => Promise<void>;
  replaceAllGlobalMarkdownMatches: (input: GlobalMarkdownSearchRequest) => Promise<GlobalMarkdownSearchResponse>;
  replaceNextGlobalMarkdownMatch: (
    input: GlobalMarkdownSearchReplaceNextRequest
  ) => Promise<GlobalMarkdownSearchResponse>;
  revealLine: (lineNumber: number, options?: RevealLineOptions) => void;
  reopenActiveDocumentWithEditor: (editorId: WorkbenchEditorId) => void;
  saveActiveDocument: () => Promise<void>;
  setBusy: (message: string | null) => void;
  setTheme: (themeId: string) => void;
  showCommandPalette: () => void;
  showError: (message: string | null) => void;
  showSidebarModule: (moduleId: PaneGroupId, paneId?: string) => void;
  showReopenWithEditor: () => void;
  showThemePicker: () => void;
  startThemeGroupCreate: () => void;
  togglePreview: () => void;
  toggleSidebar: () => void;
}

export interface EditorActionApi {
  activeDocument: WorkbenchDocument | null;
  activeSnippetMatches: SnippetCompletionMatch[];
  editor: WorkbenchEditorHandle;
  services: EditorEngineServices;
  snippets: EditorSnippet[];
}

export interface PasteHandlerApi {
  activeDocument: WorkbenchDocument | null;
  editor: WorkbenchEditorHandle;
  event: ClipboardEvent;
  uploadClipboardImages: (
    target: ClipboardImageUploadTarget,
    images: ClipboardImageInput[]
  ) => Promise<ClipboardImageResult[]>;
}

export interface PluginSetupContext {
  registerCommand: (command: CommandDefinition) => void;
  registerEditorAction: (action: EditorActionDefinition) => void;
  registerEditorContribution: (contribution: EditorContributionDefinition) => void;
  registerMarkdownEditorFeature: (feature: MarkdownEditorFeatureDefinition) => void;
  registerMarkdownFenceRenderer: (renderer: MarkdownFenceRendererFeatureDefinition) => void;
  registerPasteHandler: (handler: PasteHandlerDefinition) => void;
  registerTheme: (theme: ThemeDefinition) => void;
  registerWorkbenchContribution: (contribution: AnyWorkbenchContributionDefinition) => void;
}

export interface NormalizedSnippet extends EditorSnippet {
  environment: SnippetLanguageId;
  prefix: string[];
}

export interface NormalizedEditorConfig {
  keybindings: EditorKeybinding[];
  latexSnippets: NormalizedSnippet[];
  markdownSnippets: NormalizedSnippet[];
}
