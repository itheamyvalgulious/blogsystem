import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";

import { getErrorMessage } from "@blog-system/content-core";

import {
  api,
  type AiCompletionConfigPayload,
  type EditorConfigPayload,
  type MarkdownBlockConfigPayload,
  type PublishConfigPayload,
  type SiteConfigPayload,
  type ThemeGroupsPayload,
  type UsageStatsPayload
} from "../../api";
import {
  buildArticleDocument,
  buildConfigDocument,
  buildHomeDocument,
  buildProjectDocument,
  buildProjectLogDocument,
  buildProjectTaskDocument,
  buildThemeAssetDocument,
  buildUsageStatsDocument,
  HOME_DOCUMENT_ID,
  upsertDocument
} from "../document-builders";
import { PROJECT_MODULE_ID } from "../project-utils";
import { normalizeThemeGroupId } from "../theme-utils";
import type {
  ConfigDocumentKind,
  PaneGroupId,
  RevealLineOptions,
  WorkbenchDocument,
  WorkbenchEditorId,
  WorkbenchResourceTarget
} from "../types";

export interface PendingArticleReveal {
  articlePath: string;
  column?: number;
  focus?: boolean;
  lineNumber: number;
  moveCursor?: boolean;
}

interface DocumentOpenersOptions {
  activateDocument: (nextDocumentIdOrUpdater: SetStateAction<string | null>) => void;
  activeDocument: WorkbenchDocument | null;
  aiCompletionConfigPayload: AiCompletionConfigPayload | null;
  configPayload: EditorConfigPayload | null;
  documents: WorkbenchDocument[];
  draftValuesRef: RefObject<Record<string, string>>;
  jumpToActiveArticleLine: (lineNumber: number, options?: RevealLineOptions) => void;
  loadAiCompletionConfig: () => Promise<AiCompletionConfigPayload>;
  loadConfig: () => Promise<EditorConfigPayload>;
  loadMarkdownBlockConfig: () => Promise<MarkdownBlockConfigPayload>;
  loadPublishConfig: () => Promise<PublishConfigPayload>;
  loadSiteConfig: () => Promise<SiteConfigPayload>;
  loadUsageStats: () => Promise<UsageStatsPayload>;
  markdownBlockConfigPayload: MarkdownBlockConfigPayload | null;
  pendingArticleRevealRef: RefObject<PendingArticleReveal | null>;
  publishConfigPayload: PublishConfigPayload | null;
  refreshThemeGroupsPayload: () => Promise<ThemeGroupsPayload>;
  resolveDocumentEditorId: (document: WorkbenchDocument, preferredEditorId?: WorkbenchEditorId) => WorkbenchEditorId;
  setBusyMessage: Dispatch<SetStateAction<string | null>>;
  setDocuments: Dispatch<SetStateAction<WorkbenchDocument[]>>;
  setPageError: (message: string | null) => void;
  setSelectedTreePath: Dispatch<SetStateAction<string | null>>;
  setSidebarGroupId: Dispatch<SetStateAction<PaneGroupId>>;
  siteConfigPayload: SiteConfigPayload | null;
  usageStatsPayload: UsageStatsPayload | null;
  withResolvedEditor: <T extends WorkbenchDocument>(document: T, preferredEditorId?: WorkbenchEditorId) => T;
}

export function useDocumentOpeners({
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
}: DocumentOpenersOptions) {
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
      setPageError(getErrorMessage(error));
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
      setPageError(getErrorMessage(error));
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
      setPageError(getErrorMessage(error));
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
      setPageError(getErrorMessage(error));
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
      setPageError(getErrorMessage(error));
    }
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
      kind === "aiCompletion"
        ? aiCompletionConfigPayload ?? (await loadAiCompletionConfig())
        : kind === "markdownBlockConfig"
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
      setPageError(getErrorMessage(error));
    } finally {
      setBusyMessage(null);
    }
  };

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

  return {
    createThemeGroupDocument,
    openArticleDocument,
    openConfigDocument,
    openResource,
    openThemeGroupConfigDocument
  };
}
