import { useCallback, useLayoutEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import * as monacoEditor from "monaco-editor";

import { getErrorMessage } from "@blog-system/content-core";

import {
  api,
  ApiRequestError,
  type GlobalMarkdownSearchReplaceNextRequest,
  type GlobalMarkdownSearchRequest,
  type TreePayload
} from "../../api";
import {
  buildHomeDocument,
  closeProjectDocuments,
  HOME_DOCUMENT_ID,
  isDocumentInProject,
  removeProjectDraftValues
} from "../document-builders";
import type { SidebarPaneItem } from "../sidebar";
import type { TextInputDialogState } from "../dialogs";
import type {
  ConfigDocumentKind,
  PaneGroupId,
  RevealLineOptions,
  WorkbenchApi,
  WorkbenchDocument,
  WorkbenchEditorId,
  WorkbenchResourceTarget
} from "../types";

interface WorkbenchApiOptions {
  activateDocument: (nextDocumentIdOrUpdater: SetStateAction<string | null>) => void;
  activeDocument: WorkbenchDocument | null;
  draftValuesRef: RefObject<Record<string, string>>;
  editorRef: RefObject<monacoEditor.editor.IStandaloneCodeEditor | null>;
  flushDocumentDraft: (document?: WorkbenchDocument | null) => string | null;
  groupedPanes: Record<string, SidebarPaneItem[]>;
  hasDirtyArticleDocument: () => boolean;
  loadTree: () => Promise<TreePayload>;
  openConfigDocument: (kind: ConfigDocumentKind, preferredEditorId?: WorkbenchEditorId) => Promise<void>;
  openPalette: (mode: "commands" | "editors" | "themeGroupCreate" | "themes") => void;
  openResource: (target: WorkbenchResourceTarget) => Promise<void>;
  refreshOpenArticleDocuments: (changedPaths: string[]) => Promise<void>;
  refreshWorkspaceData: WorkbenchApi["refreshWorkspaceData"];
  resolveDocumentEditorId: (document: WorkbenchDocument, preferredEditorId?: WorkbenchEditorId) => WorkbenchEditorId;
  saveActiveDocument: () => Promise<void>;
  setActivePaneByGroup: Dispatch<SetStateAction<Record<string, string>>>;
  setBusyMessage: Dispatch<SetStateAction<string | null>>;
  setCommandPaletteOpen: Dispatch<SetStateAction<boolean>>;
  setCommandQuery: Dispatch<SetStateAction<string>>;
  setDocuments: Dispatch<SetStateAction<WorkbenchDocument[]>>;
  setPageError: Dispatch<SetStateAction<string | null>>;
  setPreviewVisible: Dispatch<SetStateAction<boolean>>;
  setPublishBusy: Dispatch<SetStateAction<boolean>>;
  setSidebarGroupId: Dispatch<SetStateAction<PaneGroupId>>;
  setSidebarVisible: Dispatch<SetStateAction<boolean>>;
  setTextInputDialog: Dispatch<SetStateAction<TextInputDialogState | null>>;
  setThemeId: Dispatch<SetStateAction<string>>;
  textInputDialogResolveRef: RefObject<((value: string | null) => void) | null>;
  workbenchApiRef: RefObject<WorkbenchApi | null>;
}

export function useWorkbenchApi({
  activateDocument,
  activeDocument,
  draftValuesRef,
  editorRef,
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
}: WorkbenchApiOptions) {
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
        setPageError(getErrorMessage(error));
      }
    } finally {
      setPublishBusy(false);
      setBusyMessage(null);
    }
  };

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

  return {
    publishStaticSite,
    workbenchApi
  };
}
