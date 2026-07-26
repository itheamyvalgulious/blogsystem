import { startTransition, useCallback, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";

import { normalizeAdminHomeConfig } from "@blog-system/content-core";
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
} from "../../api";
import {
  buildArticleDocument,
  buildHomeDocument,
  buildUsageStatsDocument,
  HOME_DOCUMENT_ID
} from "../document-builders";
import type {
  ArticleWorkbenchDocument,
  WorkbenchDocument,
  WorkbenchEditorId
} from "../types";

interface WorkspaceDataOptions {
  activateDocument: (nextDocumentIdOrUpdater: SetStateAction<string | null>) => void;
  activeDocument: WorkbenchDocument | null;
  documents: WorkbenchDocument[];
  draftValuesRef: RefObject<Record<string, string>>;
  schedulePreviewSourceUpdate: (nextValue: string, options?: { immediate?: boolean }) => void;
  setAdminHomePayload: Dispatch<SetStateAction<AdminHomeConfigPayload | null>>;
  setAiCompletionConfigPayload: Dispatch<SetStateAction<AiCompletionConfigPayload | null>>;
  setConfigPayload: Dispatch<SetStateAction<EditorConfigPayload | null>>;
  setDocuments: Dispatch<SetStateAction<WorkbenchDocument[]>>;
  setMarkdownBlockConfigPayload: Dispatch<SetStateAction<MarkdownBlockConfigPayload | null>>;
  setPageError: (message: string | null) => void;
  setProjectsPayload: Dispatch<SetStateAction<ProjectsPayload | null>>;
  setPublishConfigPayload: Dispatch<SetStateAction<PublishConfigPayload | null>>;
  setRenderStyleAssetVersion: Dispatch<SetStateAction<number>>;
  setSiteConfigPayload: Dispatch<SetStateAction<SiteConfigPayload | null>>;
  setThemeGroupsPayload: Dispatch<SetStateAction<ThemeGroupsPayload | null>>;
  setTreePayload: Dispatch<SetStateAction<TreePayload | null>>;
  setUsageStatsPayload: Dispatch<SetStateAction<UsageStatsPayload | null>>;
  syncEditorValuePreservingView: (nextValue: string) => void;
  withResolvedEditor: <T extends WorkbenchDocument>(document: T, preferredEditorId?: WorkbenchEditorId) => T;
}

export function useWorkspaceData({
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
}: WorkspaceDataOptions) {
  const adminHomeSaveTimerRef = useRef<number | null>(null);

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

  const loadAiCompletionConfig = async () => {
    const payload = await api.getAiCompletionConfig();
    startTransition(() => {
      setAiCompletionConfigPayload(payload);
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
      loadSiteConfig(),
      loadAiCompletionConfig()
    ]);
    setDocuments((current) => (current.some((document) => document.kind === "home") ? current : [buildHomeDocument(), ...current]));
    activateDocument((current) => current ?? HOME_DOCUMENT_ID);
  };

  const refreshWorkspaceData = useCallback(
    async (
      target:
        | "adminHome"
        | "aiCompletion"
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
            | "aiCompletion"
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
            case "aiCompletion":
              return loadAiCompletionConfig();
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

  return {
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
  };
}
