import type { Dispatch, RefObject, SetStateAction } from "react";
import type * as monacoEditor from "monaco-editor";

import { getErrorMessage } from "@blog-system/content-core";

import {
  api,
  type EditorConfigPayload,
  type MarkdownBlockConfigPayload,
  type ProjectsPayload,
  type PublishConfigPayload,
  type SiteConfigPayload,
  type ThemeGroupsPayload,
  type TreePayload
} from "../../api";
import {
  buildArticleDocument,
  buildProjectDocument,
  buildProjectLogDocument,
  buildProjectTaskDocument,
  buildThemeAssetDocument,
  CONFIG_DOCUMENT_META,
  isProjectDocument,
  isProjectLogDocument,
  isProjectTaskDocument,
  isThemeAssetDocument,
  upsertDocument
} from "../document-builders";
import { emptyConfigPayload } from "../editor-config";
import type {
  WorkbenchDocument,
  WorkbenchEditorId
} from "../types";

interface DocumentSaversOptions {
  activeDocument: WorkbenchDocument | null;
  cancelPendingDirtyCheck: () => void;
  configPayload: EditorConfigPayload | null;
  documents: WorkbenchDocument[];
  draftValuesRef: RefObject<Record<string, string>>;
  editorRef: RefObject<monacoEditor.editor.IStandaloneCodeEditor | null>;
  flushDocumentDraft: (document?: WorkbenchDocument | null) => string | null;
  getDraftValue: (document: WorkbenchDocument) => string;
  loadProjects: () => Promise<ProjectsPayload>;
  loadTree: () => Promise<TreePayload>;
  markdownBlockConfigPayload: MarkdownBlockConfigPayload | null;
  openThemeGroupConfigDocument: (groupId: string, preferredEditorId?: WorkbenchEditorId) => Promise<void>;
  publishConfigPayload: PublishConfigPayload | null;
  refreshThemeGroupsPayload: () => Promise<ThemeGroupsPayload>;
  schedulePreviewSourceUpdate: (nextValue: string, options?: { immediate?: boolean }) => void;
  setActiveDocumentId: Dispatch<SetStateAction<string | null>>;
  setBusyMessage: Dispatch<SetStateAction<string | null>>;
  setConfigPayload: Dispatch<SetStateAction<EditorConfigPayload | null>>;
  setDocuments: Dispatch<SetStateAction<WorkbenchDocument[]>>;
  setMarkdownBlockConfigPayload: Dispatch<SetStateAction<MarkdownBlockConfigPayload | null>>;
  setPageError: Dispatch<SetStateAction<string | null>>;
  setPublishConfigPayload: Dispatch<SetStateAction<PublishConfigPayload | null>>;
  setSiteConfigPayload: Dispatch<SetStateAction<SiteConfigPayload | null>>;
  siteConfigPayload: SiteConfigPayload | null;
  syncEditorValuePreservingView: (nextValue: string) => void;
  withResolvedEditor: <T extends WorkbenchDocument>(document: T, preferredEditorId?: WorkbenchEditorId) => T;
}

export function useDocumentSavers({
  activeDocument,
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
}: DocumentSaversOptions) {
  const saveProjectChildDocument = async <TDocument extends WorkbenchDocument, TPayload>(
    guard: (document: WorkbenchDocument | null) => document is TDocument,
    save: (document: TDocument, raw: string) => Promise<TPayload>,
    build: (payload: TPayload) => WorkbenchDocument
  ) => {
    if (!guard(activeDocument)) {
      return;
    }

    const raw = getDraftValue(activeDocument);
    const savedPayload = await save(activeDocument, raw);
    const savedDocument = withResolvedEditor(
      build(savedPayload),
      activeDocument.editorId
    );
    draftValuesRef.current[savedDocument.id] = savedDocument.value;
    setDocuments((current) => upsertDocument(current, savedDocument));
    setActiveDocumentId(savedDocument.id);
    await loadProjects();
  };

  const saveProjectWorkbenchDocument = async () =>
    saveProjectChildDocument(
      isProjectDocument,
      (document, raw) => api.saveProject(document.projectId, raw),
      buildProjectDocument
    );

  const saveProjectTaskWorkbenchDocument = async () =>
    saveProjectChildDocument(
      isProjectTaskDocument,
      (document, raw) => api.saveProjectTask(document.projectId, document.taskId, raw),
      buildProjectTaskDocument
    );

  const saveProjectLogWorkbenchDocument = async () =>
    saveProjectChildDocument(
      isProjectLogDocument,
      (document, raw) => api.saveProjectLog(document.projectId, document.logId, raw),
      buildProjectLogDocument
    );

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
      setPageError(getErrorMessage(error));
    } finally {
      setBusyMessage(null);
    }
  };

  return {
    saveActiveDocument
  };
}
