import { useCallback, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { loader } from "@monaco-editor/react";
import * as monacoEditor from "monaco-editor";
import "katex/dist/katex.min.css";
import { getErrorMessage, type FileSystemNode, type ThemeCssAssetConfig } from "@blog-system/content-core";
import "./monaco-environment";

import { LoginView } from "./components/LoginView";
import { PdfExportDialog } from "./workbench/pdf-export-dialog";
import type { PdfExportSettings } from "./workbench/pdf-types";
import { exportArticlePdf, resolveArticleContent } from "./workbench/pdf-export";

import {
  api,
  type AdminHomeConfigPayload,
  type AiCompletionConfigPayload,
  type EditorConfigPayload,
  type MarkdownBlockConfigPayload,
  type ProjectsPayload,
  type PublishConfigPayload,
  type SiteConfigPayload,
  type ThemeGroupsPayload,
  type TreePayload,
  type UsageStatsPayload
} from "./api";
import type { MathPair } from "./markdown-math-scanner";
import {
  parseStoredCollapsedTreePaths,
  parseStoredFilePaneFilters,
  parseStoredWorkbenchResource
} from "./workbench-session";
import type { FilePaneFilters, SortOrder, StatusFilter } from "./workbench-session";
import { getSnippetLanguageFromMathPairs } from "./snippet-context";
import {
  buildOutlineTree,
  findActiveMarkdownOutlineItemId,
  type CachedHeading
} from "./markdown-outline";
import { builtInPlugins } from "./workbench/builtins";
import { WorkbenchCommandPalette } from "./workbench/command-palette";
import type {
  EditorEngineServices,
  EditorPosition,
  WorkbenchEditorHandle,
  WorkbenchTextModelHandle
} from "./workbench/editor-engine";
import {
  FileEntryDialog,
  FolderMetadataDialog,
  PreviewRenderDialog,
  TextInputDialog,
  TitleConflictDialog,
  TreeContextMenu,
  type ContextMenuState,
  type FileDialogState,
  type FolderMetadataDialogState,
  type TextInputDialogState,
  type TitleConflictState,
  type TreeClipboardState
} from "./workbench/dialogs";
import {
  buildHomeDocument,
  HOME_DOCUMENT_ID,
  isArticleDocument
} from "./workbench/document-builders";
import { resolvePreferredEditorId } from "./workbench/editor-associations";
import {
  buildNormalizedEditorConfig,
  emptyConfigPayload
} from "./workbench/editor-config";
import { useArticleCursorStates } from "./workbench/hooks/use-article-cursor-states";
import { useDocumentDrafts } from "./workbench/hooks/use-document-drafts";
import { useDocumentOpeners, type PendingArticleReveal } from "./workbench/hooks/use-document-openers";
import { useDocumentSavers } from "./workbench/hooks/use-document-savers";
import { useEditorContentChange } from "./workbench/hooks/use-editor-content-change";
import { useEditorIntegration } from "./workbench/hooks/use-editor-integration";
import { useEditorValueSync } from "./workbench/hooks/use-editor-value-sync";
import { useFileDialogOperations } from "./workbench/hooks/use-file-dialog-operations";
import { usePreviewSync } from "./workbench/hooks/use-preview-sync";
import { parsePreviewSourceForDocument } from "./workbench/preview-utils";
import { setWorkbenchLivePreviewContext } from "./workbench/codemirror/cm-context";
import { useUsageStatsTracking } from "./workbench/hooks/use-usage-stats-tracking";
import { useWorkbenchApi } from "./workbench/hooks/use-workbench-api";
import { useWorkbenchPersistence } from "./workbench/hooks/use-workbench-persistence";
import { useWorkbenchShortcuts } from "./workbench/hooks/use-workbench-shortcuts";
import { useWorkspaceData } from "./workbench/hooks/use-workspace-data";
import { requestWorkbenchKeyboardLock } from "./workbench/keyboard-lock";
import { PluginRuntime } from "./workbench/plugin-runtime";
import { CORE_MODULES, type SidebarModuleItem, type SidebarPaneItem } from "./workbench/sidebar";
import { SidebarPaneContent } from "./workbench/sidebar-pane-content";
import {
  ACTIVE_RESOURCE_STORAGE_KEY,
  COLLAPSED_TREE_PATHS_STORAGE_KEY,
  DISABLED_PLUGINS_STORAGE_KEY,
  FILE_PANE_FILTERS_STORAGE_KEY,
  PREVIEW_WIDTH_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  THEME_STORAGE_KEY
} from "./workbench/storage-keys";
import { buildFileTreeMap } from "./workbench/tree-utils";
import type {
  CreateDialogContributionDefinition,
  HomeWidgetContributionDefinition,
  ModuleContributionDefinition,
  PaneContributionDefinition,
  PaneGroupId,
  RevealLineOptions,
  WorkbenchApi,
  WorkbenchDocument,
  WorkbenchEditorId
} from "./workbench/types";
import {
  ActivityBar,
  EditorSurface,
  EditorTabBar,
  PreviewPane,
  SidebarPanel
} from "./workbench/workbench-layout";

loader.config({ monaco: monacoEditor });

const PREVIEW_UPDATE_DEBOUNCE_MS = 0;

export function App() {
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
  const [previewVisible, setPreviewVisible] = useState(false);
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
  const [aiCompletionConfigPayload, setAiCompletionConfigPayload] = useState<AiCompletionConfigPayload | null>(null);
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
  const [themeId, setThemeId] = useState(() => window.localStorage.getItem(THEME_STORAGE_KEY) ?? "eva-dark");
  const [disabledPluginIds, setDisabledPluginIds] = useState<string[]>(() => {
    try {
      const rawValue = window.localStorage.getItem(DISABLED_PLUGINS_STORAGE_KEY);
      return rawValue ? (JSON.parse(rawValue) as string[]) : [];
    } catch {
      return [];
    }
  });
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);
  const [collapsedTreePaths, setCollapsedTreePaths] = useState<Set<string>>(initialCollapsedTreePaths);
  const [contextMenuState, setContextMenuState] = useState<ContextMenuState | null>(null);
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
  const [treeClipboard, setTreeClipboard] = useState<TreeClipboardState | null>(null);
  const [fileDialog, setFileDialog] = useState<FileDialogState | null>(null);
  const [folderMetadataDialog, setFolderMetadataDialog] = useState<FolderMetadataDialogState | null>(null);
  const [titleConflictState, setTitleConflictState] = useState<TitleConflictState | null>(null);
  const [textInputDialog, setTextInputDialog] = useState<TextInputDialogState | null>(null);
  const [pdfExportTarget, setPdfExportTarget] = useState<{
    articlePath: string;
    articleTitle: string;
  } | null>(null);
  const [editorReadyVersion, setEditorReadyVersion] = useState(0);
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const editorRef = useRef<WorkbenchEditorHandle | null>(null);
  const editorServicesRef = useRef<EditorEngineServices | null>(null);
  const headingsRef = useRef<CachedHeading[]>([]);
  const mathPairsRef = useRef<MathPair[]>([]);
  const dirtyCheckTimerRef = useRef<number | null>(null);
  const draftValueSyncTimerRef = useRef<number | null>(null);
  const activeDocumentIdRef = useRef<string | null>(activeDocumentId);
  const dirtyDocumentIdsRef = useRef<Set<string>>(new Set());
  const textInputDialogResolveRef = useRef<((value: string | null) => void) | null>(null);
  const textInputDialogInputRef = useRef<HTMLInputElement | null>(null);
  const draftValuesRef = useRef<Record<string, string>>({});
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

  const [outlineHeadings, setOutlineHeadings] = useState<CachedHeading[]>([]);
  const syncOutlineHeadings = useCallback(() => {
    setOutlineHeadings([...headingsRef.current]);
  }, []);

  const outlineTree = useMemo(
    () => buildOutlineTree(outlineHeadings),
    [outlineHeadings]
  );

  const activeOutlineItemId = useMemo(
    () => findActiveMarkdownOutlineItemId(outlineHeadings, activeArticleLineNumber),
    [outlineHeadings, activeArticleLineNumber]
  );

  const getSnippetLanguageForEditor = useCallback(
    (model: WorkbenchTextModelHandle, position: EditorPosition) => {
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
  const selectedTags = treePayload?.tags ?? [];
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
  const [prevGroupedPanes, setPrevGroupedPanes] = useState<Record<string, SidebarPaneItem[]> | null>(null);
  if (prevGroupedPanes !== groupedPanes) {
    setPrevGroupedPanes(groupedPanes);
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
  }
  const previewThemeCssAssets = useMemo(
    () =>
      enabledThemeGroups.flatMap((group) =>
        group.files
          .filter(
            (file): file is ThemeCssAssetConfig =>
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

  const syncEditorValuePreservingView = useEditorValueSync(editorRef, editorServicesRef);

  const {
    activateDocument,
    cancelPendingDirtyCheck,
    flushDocumentDraft,
    getDraftValue,
    getRenderDraftValue,
    scheduleDocumentDirtyCheck
  } = useDocumentDrafts({
    activeDocument,
    activeDocumentId,
    activeDocumentIdRef,
    dirtyCheckTimerRef,
    dirtyDocumentIdsRef,
    draftValuesRef,
    draftValueSyncTimerRef,
    editorRef,
    pluginRuntime,
    setActiveDocumentId,
    setDocuments
  });

  const {
    articleCursorPersistTimerRef,
    articleCursorStatesRef,
    discardStoredArticleCursorStates,
    flushArticleCursorStates,
    lastStoredArticleLineNumberRef,
    remapStoredArticleCursorStates,
    storeArticleCursorState
  } = useArticleCursorStates({ editorRef, setActiveArticleLineNumber });

  const jumpToActiveArticleLineImplRef = useRef<(lineNumber: number, options?: RevealLineOptions) => void>(() => undefined);
  const jumpToActiveArticleLine = useCallback((lineNumber: number, options?: RevealLineOptions) => {
    jumpToActiveArticleLineImplRef.current(lineNumber, options);
  }, []);

  const {
    attachPreviewRef,
    attachPreviewSurfaceRef,
    previewBlocksRef,
    previewCursorSyncRafRef,
    previewProseRef,
    previewUpdateTimerRef,
    scheduleDocumentPreviewUpdate,
    schedulePreviewCursorSyncRef,
    schedulePreviewSourceUpdate,
    suppressPreviewFollowFromEditorScrollRef
  } = usePreviewSync({
    activeDocument,
    activeDocumentSupportsPreview,
    activePreviewFenceRenderers,
    draftValuesRef,
    editorReadyVersion,
    editorRef,
    jumpToActiveArticleLine,
    markdownBlockConfigPayload,
    pluginRuntime,
    previewPaneVisible,
    previewThemeCssAssets,
    previewThemeScriptAssets,
    renderStyleAssetVersion,
    setPageError
  });

  // Feed the CM live preview (module singleton, read lazily at decoration /
  // widget render time) with the same data sources as the preview pane:
  // article directory for image URL resolution, active fence renderers and
  // the markdown block config.
  useEffect(() => {
    setWorkbenchLivePreviewContext({
      articleDirectory: activeDocument
        ? parsePreviewSourceForDocument(activeDocument, "")?.directory ?? null
        : null,
      fenceRenderers: activePreviewFenceRenderers,
      markdownBlockConfig: markdownBlockConfigPayload?.value ?? null
    });
  }, [activeDocument, activePreviewFenceRenderers, markdownBlockConfigPayload]);

  const jumpToActiveArticleLineImpl = useCallback(
    (lineNumber: number, options?: RevealLineOptions) => {
      if (!isArticleDocument(activeDocument)) {
        return;
      }

      const editor = editorRef.current;
      const services = editorServicesRef.current;
      const model = editor?.getModel();
      if (!editor || !services || !model) {
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
        const selection = new services.Selection(
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
    [
      activeDocument,
      lastStoredArticleLineNumberRef,
      schedulePreviewCursorSyncRef,
      setActiveArticleLineNumber,
      storeArticleCursorState,
      suppressPreviewFollowFromEditorScrollRef
    ]
  );
  useEffect(() => {
    jumpToActiveArticleLineImplRef.current = jumpToActiveArticleLineImpl;
  }, [jumpToActiveArticleLineImpl]);

  const {
    adminHomeSaveTimerRef,
    loadAiCompletionConfig,
    loadConfig,
    loadMarkdownBlockConfig,
    loadProjects,
    loadPublishConfig,
    loadSiteConfig,
    loadTree,
    loadUsageStats,
    refreshOpenArticleDocuments,
    refreshThemeGroupsPayload,
    refreshWorkspace,
    refreshWorkspaceData,
    updateAdminHomeConfigValue
  } = useWorkspaceData({
    activateDocument,
    activeDocument,
    documents,
    draftValuesRef,
    schedulePreviewSourceUpdate,
    setAdminHomePayload,
    setAiCompletionConfigPayload,
    setConfigPayload,
    setDocuments,
    setMarkdownBlockConfigPayload,
    setPageError,
    setProjectsPayload,
    setPublishConfigPayload,
    setRenderStyleAssetVersion,
    setSiteConfigPayload,
    setThemeGroupsPayload,
    setTreePayload,
    setUsageStatsPayload,
    syncEditorValuePreservingView,
    withResolvedEditor
  });

  const {
    createThemeGroupDocument,
    openArticleDocument,
    openConfigDocument,
    openResource,
    openThemeGroupConfigDocument
  } = useDocumentOpeners({
    activateDocument,
    activeDocument,
    aiCompletionConfigPayload,
    configPayload,
    documents,
    draftValuesRef,
    jumpToActiveArticleLine,
    loadAiCompletionConfig,
    loadConfig,
    loadMarkdownBlockConfig,
    loadPublishConfig,
    loadSiteConfig,
    loadUsageStats,
    markdownBlockConfigPayload,
    pendingArticleRevealRef,
    publishConfigPayload,
    refreshThemeGroupsPayload,
    resolveDocumentEditorId,
    setBusyMessage,
    setDocuments,
    setPageError,
    setSelectedTreePath,
    setSidebarGroupId,
    siteConfigPayload,
    usageStatsPayload,
    withResolvedEditor
  });

  const { handleEditorMount } = useEditorIntegration({
    activeDocument,
    activeEditorContribution,
    articleCursorStatesRef,
    editorReadyVersion,
    editorRef,
    editorServicesRef,
    getSnippetLanguageForEditor,
    headingsRef,
    jumpToActiveArticleLine,
    lastStoredArticleLineNumberRef,
    loadTree,
    mathPairsRef,
    normalizedConfig,
    pendingArticleRevealRef,
    pluginRuntime,
    setActiveArticleLineNumber,
    setEditorReadyVersion,
    storeArticleCursorState,
    syncOutlineHeadings,
    treePayload,
    workbenchApiRef
  });

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

  const { saveActiveDocument } = useDocumentSavers({
    activeDocument,
    aiCompletionConfigPayload,
    cancelPendingDirtyCheck,
    configPayload,
    documents,
    draftValuesRef,
    editorRef,
    flushDocumentDraft,
    getDraftValue,
    loadProjects,
    loadTree,
    markdownBlockConfigPayload,
    openThemeGroupConfigDocument,
    publishConfigPayload,
    refreshThemeGroupsPayload,
    schedulePreviewSourceUpdate,
    setActiveDocumentId,
    setAiCompletionConfigPayload,
    setBusyMessage,
    setConfigPayload,
    setDocuments,
    setMarkdownBlockConfigPayload,
    setPageError,
    setPublishConfigPayload,
    setSiteConfigPayload,
    siteConfigPayload,
    syncEditorValuePreservingView,
    withResolvedEditor
  });

  const {
    activeMetadataDialogFields,
    getCreateDialogMetadataDefaults,
    handleFileDialogSubmit,
    handleFolderMetadataSave,
    handleTitleConflictContinue,
    openFolderMetadataDialog,
    openRenameDialog
  } = useFileDialogOperations({
    activateDocument,
    createDialogContributions,
    discardStoredArticleCursorStates,
    draftValuesRef,
    fileDialog,
    loadTree,
    openArticleDocument,
    remapStoredArticleCursorStates,
    schedulePreviewSourceUpdate,
    setBusyMessage,
    setCollapsedTreePaths,
    setDocuments,
    setFileDialog,
    setFolderMetadataDialog,
    setPageError,
    setSelectedTreePath,
    setTitleConflictState,
    syncEditorValuePreservingView
  });

  const { publishStaticSite, workbenchApi } = useWorkbenchApi({
    activateDocument,
    activeDocument,
    draftValuesRef,
    editorRef,
    editorServicesRef,
    flushDocumentDraft,
    groupedPanes,
    hasDirtyArticleDocument,
    loadTree,
    openConfigDocument,
    openPalette,
    openResource,
    refreshOpenArticleDocuments,
    refreshWorkspaceData,
    resolveDocumentEditorId,
    saveActiveDocument,
    setActivePaneByGroup,
    setBusyMessage,
    setCommandPaletteOpen,
    setCommandQuery,
    setDocuments,
    setPageError,
    setPreviewVisible,
    setPublishBusy,
    setSidebarGroupId,
    setSidebarVisible,
    setTextInputDialog,
    setThemeId,
    textInputDialogResolveRef,
    workbenchApiRef
  });

  useWorkbenchPersistence({
    activeDocument,
    activeTheme,
    authenticated,
    collapsedTreePaths,
    disabledPluginIds,
    initialActiveResourceRef,
    previewWidth,
    refreshWorkspace,
    restoredSessionRef,
    searchQuery,
    setPageError,
    showAssets,
    sidebarWidth,
    sortOrder,
    statusFilter,
    tagFilter,
    workbenchApiRef
  });

  const {
    flushUsageStats,
    markUsageActivity,
    queueUsageDocumentDelta,
    usageStatsActivityTimerRef,
    usageStatsFlushTimerRef
  } = useUsageStatsTracking({
    authenticated,
    setDocuments,
    setPageError,
    setUsageStatsPayload,
    withResolvedEditor
  });

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

  const [prevCommandPaletteOpen, setPrevCommandPaletteOpen] = useState(commandPaletteOpen);
  if (prevCommandPaletteOpen !== commandPaletteOpen) {
    setPrevCommandPaletteOpen(commandPaletteOpen);
    if (!commandPaletteOpen) {
      setCommandQuery("");
      setSelectedPaletteIndex(0);
      setCommandPaletteMode("commands");
    }
  }

  const [prevSupportsPreview, setPrevSupportsPreview] = useState(activeDocumentSupportsPreview);
  if (prevSupportsPreview !== activeDocumentSupportsPreview) {
    setPrevSupportsPreview(activeDocumentSupportsPreview);
    if (!activeDocumentSupportsPreview) {
      setPreviewRenderDialogOpen(false);
    }
  }

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

  useWorkbenchShortcuts({
    activateDocument,
    activeDocument,
    activeDocumentId,
    activePaneId,
    commandPaletteOpen,
    documents,
    draftValuesRef,
    editorRef,
    getSnippetLanguageForEditor,
    loadTree,
    normalizedConfig,
    pluginRuntime,
    remapStoredArticleCursorStates,
    selectedTreeNode,
    setBusyMessage,
    setCollapsedTreePaths,
    setDocuments,
    setFileDialog,
    setPageError,
    setSelectedTreePath,
    setTreeClipboard,
    sidebarGroupId,
    treeClipboard,
    treeRootRef,
    workbenchApiRef
  });

  const onExportPdf = useCallback(async (targetNode: FileSystemNode) => {
    if (targetNode.type !== "file" || targetNode.fileKind !== "article") return;
    setPdfExportTarget({
      articlePath: targetNode.path,
      articleTitle: targetNode.article?.title ?? targetNode.name
    });
  }, []);

  const handlePdfExportConfirm = useCallback(
    async (settings: PdfExportSettings, info: { articlePath: string }) => {
      setBusyMessage("Preparing PDF export...");
      try {
        // 1. Resolve content (prefer draft, fall back to API)
        const record = await resolveArticleContent(info.articlePath, draftValuesRef);
        const title = (record.title || info.articlePath.split("/").pop()) ?? "article";
        const directory = record.directory;

        // 2. Export PDF (marksdown rendering happens inside exportArticlePdf)
        const result = await exportArticlePdf(info.articlePath, settings, {
          markdown: record.body,
          title,
          directory,
          themeGroups: enabledThemeGroups,
          colorMode: activeTheme?.appearance ?? "dark",
          renderStyleAssetVersion
        });

        if (result.canceled) {
          setPageError(null);
        } else if (result.filePath) {
          setPageError(null);
        }
      } catch (error) {
        setPageError(getErrorMessage(error));
      } finally {
        setBusyMessage(null);
      }
    },
    [draftValuesRef, enabledThemeGroups, activeTheme?.appearance, renderStyleAssetVersion, setBusyMessage, setPageError]
  );

  const { handleDocumentValueChange, handleEditorModelContentChange } = useEditorContentChange({
    activeDocument,
    activeDocumentSupportsPreview,
    dirtyDocumentIdsRef,
    draftValuesRef,
    editorRef,
    headingsRef,
    markUsageActivity,
    mathPairsRef,
    queueUsageDocumentDelta,
    scheduleDocumentDirtyCheck,
    scheduleDocumentPreviewUpdate,
    scheduleDraftValueSync,
    setDocuments,
    syncOutlineHeadings
  });

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
            setLoginError(getErrorMessage(error));
          } finally {
            setLoginBusy(false);
          }
        }}
      />
    );
  }

  return (
    <div className="workbench-shell" onPointerDown={() => requestWorkbenchKeyboardLock()}>
      <WorkbenchCommandPalette
        activeDocument={activeDocument}
        availableCommands={availableCommands}
        availableEditors={availableEditors}
        availableThemes={availableThemes}
        createThemeGroupDocument={createThemeGroupDocument}
        mode={commandPaletteMode}
        onClose={() => setCommandPaletteOpen(false)}
        onQueryChange={setCommandQuery}
        onSelectIndex={setSelectedPaletteIndex}
        open={commandPaletteOpen}
        openThemeGroupConfigDocument={openThemeGroupConfigDocument}
        pluginRuntime={pluginRuntime}
        query={commandQuery}
        selectedIndex={selectedPaletteIndex}
        setThemeId={setThemeId}
        themeGroupsPayload={themeGroupsPayload}
        workbenchApiRef={workbenchApiRef}
      />

      {fileDialog ? (
        <FileEntryDialog
          dialog={fileDialog}
          metadataFields={activeMetadataDialogFields}
          onChange={setFileDialog}
          onSubmit={handleFileDialogSubmit}
        />
      ) : null}

      {folderMetadataDialog ? (
        <FolderMetadataDialog
          dialog={folderMetadataDialog}
          onChange={setFolderMetadataDialog}
          onSave={handleFolderMetadataSave}
        />
      ) : null}

      {titleConflictState ? (
        <TitleConflictDialog
          state={titleConflictState}
          onClose={() => setTitleConflictState(null)}
          onContinue={handleTitleConflictContinue}
        />
      ) : null}

      {textInputDialog ? (
        <TextInputDialog
          dialog={textInputDialog}
          inputRef={textInputDialogInputRef}
          onChange={setTextInputDialog}
          onClose={closeTextInputDialog}
        />
      ) : null}

      {previewRenderDialogOpen ? (
        <PreviewRenderDialog groups={enabledThemeGroups} onClose={() => setPreviewRenderDialogOpen(false)} />
      ) : null}

      {pdfExportTarget ? (
        <PdfExportDialog
          articlePath={pdfExportTarget.articlePath}
          articleTitle={pdfExportTarget.articleTitle}
          onClose={() => setPdfExportTarget(null)}
          onExport={handlePdfExportConfirm}
        />
      ) : null}

      {contextMenuState ? (
        <TreeContextMenu
          clipboard={treeClipboard}
          draftValuesRef={draftValuesRef}
          getCreateDialogMetadataDefaults={getCreateDialogMetadataDefaults}
          loadTree={loadTree}
          menuRef={contextMenuRef}
          onExportPdf={onExportPdf}
          openFolderMetadataDialog={openFolderMetadataDialog}
          openRenameDialog={openRenameDialog}
          position={contextMenuPos}
          remapStoredArticleCursorStates={remapStoredArticleCursorStates}
          setBusyMessage={setBusyMessage}
          setCollapsedTreePaths={setCollapsedTreePaths}
          setContextMenuState={setContextMenuState}
          setDocuments={setDocuments}
          setFileDialog={setFileDialog}
          setPageError={setPageError}
          setSelectedTreePath={setSelectedTreePath}
          setTreeClipboard={setTreeClipboard}
          targetNode={contextTargetNode}
        />
      ) : null}

      <ActivityBar
        groupedPanes={groupedPanes}
        openPalette={openPalette}
        setActivePaneByGroup={setActivePaneByGroup}
        setSidebarGroupId={setSidebarGroupId}
        setSidebarVisible={setSidebarVisible}
        sidebarGroupId={sidebarGroupId}
        sidebarModules={sidebarModules}
        sidebarVisible={sidebarVisible}
      />

      <div
        className="main-shell"
        style={{
          gridTemplateColumns: sidebarVisible ? `${sidebarWidth}px 8px 1fr` : "0 0 1fr"
        }}
      >
        <SidebarPanel
          activeGroupPanes={activeGroupPanes}
          activePaneId={activePaneId}
          setActivePaneByGroup={setActivePaneByGroup}
          sidebarGroupId={sidebarGroupId}
          sidebarVisible={sidebarVisible}
          sidebarWidth={sidebarWidth}
        >
          <SidebarPaneContent
            activeArticleLineNumber={activeArticleLineNumber}
            activeDocument={activeDocument}
            activeOutlineItemId={activeOutlineItemId}
            activeSidebarPane={activeSidebarPane}
            busyMessage={busyMessage}
            collapsedTreePaths={collapsedTreePaths}
            configPayload={configPayload}
            deferredSearchQuery={deferredSearchQuery}
            disabledPluginIds={disabledPluginIds}
            draftValuesRef={draftValuesRef}
            getDraftValue={getDraftValue}
            loadTree={loadTree}
            openArticleDocument={openArticleDocument}
            outlineTree={outlineTree}
            pageError={pageError}
            projects={projectsPayload?.projects ?? []}
            publishBusy={publishBusy}
            publishStaticSite={publishStaticSite}
            remapStoredArticleCursorStates={remapStoredArticleCursorStates}
            saveActiveDocument={saveActiveDocument}
            schedulePreviewSourceUpdate={schedulePreviewSourceUpdate}
            searchQuery={searchQuery}
            selectedTags={selectedTags}
            selectedTreePath={selectedTreePath}
            setActiveDocumentId={setActiveDocumentId}
            setBusyMessage={setBusyMessage}
            setCollapsedTreePaths={setCollapsedTreePaths}
            setContextMenuState={setContextMenuState}
            setDisabledPluginIds={setDisabledPluginIds}
            setDocuments={setDocuments}
            setPageError={setPageError}
            setSearchQuery={setSearchQuery}
            setSelectedTreePath={setSelectedTreePath}
            setShowAssets={setShowAssets}
            setSortOrder={setSortOrder}
            setStatusFilter={setStatusFilter}
            setTagFilter={setTagFilter}
            showAssets={showAssets}
            sortOrder={sortOrder}
            statusFilter={statusFilter}
            syncEditorValuePreservingView={syncEditorValuePreservingView}
            tagFilter={tagFilter}
            treeClipboard={treeClipboard}
            treePayload={treePayload}
            treeRootRef={treeRootRef}
            withResolvedEditor={withResolvedEditor}
            workbenchApi={workbenchApi}
          />
        </SidebarPanel>

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
            <EditorTabBar
              activateDocument={activateDocument}
              activeDocumentId={activeDocumentId}
              documents={documents}
              setDocuments={setDocuments}
            />
            <EditorSurface
              activeDocument={activeDocument}
              activeEditorContribution={activeEditorContribution}
              adminHomeValue={adminHomePayload?.value ?? null}
              articleSummaries={treePayload?.articles ?? []}
              getRenderDraftValue={getRenderDraftValue}
              homeWidgetContributions={homeWidgetContributions}
              onChange={handleDocumentValueChange}
              onChangeHomeConfig={updateAdminHomeConfigValue}
              onModelContentChange={handleEditorModelContentChange}
              onMount={handleEditorMount}
              workbenchApi={workbenchApi}
            />
          </div>

          {previewPaneVisible ? (
            <PreviewPane
              attachPreviewRef={attachPreviewRef}
              attachPreviewSurfaceRef={attachPreviewSurfaceRef}
              setPreviewRenderDialogOpen={setPreviewRenderDialogOpen}
              startResize={startResize}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}
