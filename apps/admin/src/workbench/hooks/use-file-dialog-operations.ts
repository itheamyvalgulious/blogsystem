import { useCallback, useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";

import { getErrorMessage, type FileSystemNode } from "@blog-system/content-core";

import { api, ApiRequestError, type TreePayload } from "../../api";
import { deriveArticleFileName } from "../../utils";
import {
  remapCollapsedTreePaths,
  removeCollapsedTreePaths
} from "../../workbench-session";
import {
  buildArticleDocument,
  HOME_DOCUMENT_ID,
  remapDocuments,
  removeArticleDraftValues,
  removeDocuments,
  upsertDocument
} from "../document-builders";
import { matchesPathPrefix } from "../path-utils";
import type {
  CreateDialogContributionDefinition,
  WorkbenchDocument,
  WorkbenchEditorId
} from "../types";
import type {
  FileDialogState,
  FolderMetadataDialogState,
  TitleConflictState
} from "../dialogs";

interface FileDialogOperationsOptions {
  activateDocument: (nextDocumentIdOrUpdater: SetStateAction<string | null>) => void;
  createDialogContributions: CreateDialogContributionDefinition[];
  discardStoredArticleCursorStates: (targetPath: string) => void;
  draftValuesRef: RefObject<Record<string, string>>;
  fileDialog: FileDialogState | null;
  loadTree: () => Promise<TreePayload>;
  openArticleDocument: (articlePath: string, preferredEditorId?: WorkbenchEditorId) => Promise<void>;
  remapStoredArticleCursorStates: (fromPath: string, toPath: string) => void;
  schedulePreviewSourceUpdate: (nextValue: string, options?: { immediate?: boolean }) => void;
  setBusyMessage: Dispatch<SetStateAction<string | null>>;
  setCollapsedTreePaths: Dispatch<SetStateAction<Set<string>>>;
  setDocuments: Dispatch<SetStateAction<WorkbenchDocument[]>>;
  setFileDialog: Dispatch<SetStateAction<FileDialogState | null>>;
  setFolderMetadataDialog: Dispatch<SetStateAction<FolderMetadataDialogState | null>>;
  setPageError: Dispatch<SetStateAction<string | null>>;
  setSelectedTreePath: Dispatch<SetStateAction<string | null>>;
  setTitleConflictState: Dispatch<SetStateAction<TitleConflictState | null>>;
  syncEditorValuePreservingView: (nextValue: string) => void;
}

export function useFileDialogOperations({
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
}: FileDialogOperationsOptions) {
  const activeMetadataDialogFields = useMemo(() => {
    if (!fileDialog || fileDialog.mode === "delete") {
      return [];
    }

    const entryType = fileDialog.entryType;
    return createDialogContributions.flatMap((contribution) =>
      contribution.fields.filter(
        (field) => field.appliesTo === "both" || field.appliesTo === entryType
      )
    );
  }, [createDialogContributions, fileDialog]);

  const getCreateDialogMetadataDefaults = useCallback(
    (entryType: "file" | "directory") => {
      const defaults: Record<string, string> = {};

      for (const contribution of createDialogContributions) {
        for (const field of contribution.fields) {
          if (field.appliesTo !== "both" && field.appliesTo !== entryType) {
            continue;
          }

          defaults[field.id] = field.defaultValue ?? "";
        }
      }

      return defaults;
    },
    [createDialogContributions]
  );

  const openRenameDialog = useCallback(
    async (targetNode: FileSystemNode) => {
      const baseMetadata =
        targetNode.type === "file" && targetNode.fileKind === "article" && targetNode.article
          ? {
              tags: targetNode.article.tags.join(", "),
              top: String(targetNode.article.top)
            }
          : {};

      const metadataPayload =
        targetNode.type === "directory"
          ? await api.getFileSystemMetadata(targetNode.path)
          : targetNode.type === "file" && targetNode.fileKind === "article"
            ? await api.getFileSystemMetadata(targetNode.path)
            : null;

      setFileDialog({
        entryType: targetNode.type === "directory" ? "directory" : "file",
        fileKind: targetNode.type === "file" ? targetNode.fileKind : undefined,
        mode: "rename",
        path: targetNode.path,
        value:
          targetNode.type === "file" && targetNode.fileKind === "article" && metadataPayload?.metadata.title
            ? String(metadataPayload.metadata.title)
            : targetNode.name,
        metadata: {
          ...getCreateDialogMetadataDefaults(targetNode.type === "directory" ? "directory" : "file"),
          ...baseMetadata,
          ...(metadataPayload?.metadata.tags
            ? { tags: Array.isArray(metadataPayload.metadata.tags) ? metadataPayload.metadata.tags.join(", ") : String(metadataPayload.metadata.tags) }
            : {}),
          ...(metadataPayload?.metadata.top !== undefined ? { top: String(metadataPayload.metadata.top) } : {})
        }
      });
    },
    [getCreateDialogMetadataDefaults]
  );

  const openFolderMetadataDialog = useCallback(
    async (targetNode: { type: "directory"; path: string; name: string }) => {
      const metadataPayload = await api.getFileSystemMetadata(targetNode.path);
      const rawMeta = metadataPayload.metadata ?? {};
      const knownKeys = ["tags", "title", "status", "top", "date", "summary", "slug", "password"];
      const extraEntries = Object.entries(rawMeta).filter(([k]) => !knownKeys.includes(k));
      setFolderMetadataDialog({
        path: targetNode.path,
        name: targetNode.name,
        tags: Array.isArray(rawMeta.tags) ? rawMeta.tags.join(", ") : String(rawMeta.tags ?? ""),
        title: String(rawMeta.title ?? ""),
        status: String(rawMeta.status ?? ""),
        top: String(rawMeta.top ?? ""),
        date: String(rawMeta.date ?? ""),
        summary: String(rawMeta.summary ?? ""),
        slug: String(rawMeta.slug ?? ""),
        password: String(rawMeta.password ?? ""),
        extraJson: extraEntries.length > 0 ? JSON.stringify(Object.fromEntries(extraEntries), null, 2) : ""
      });
    },
    []
  );

  const executeFileDialogOperation = async (
    dialog: NonNullable<typeof fileDialog>,
    options?: { allowDuplicateTitle?: boolean }
  ) => {
    if (dialog.mode === "create-file" || dialog.mode === "create-directory") {
      const result = await api.createFileSystemEntry(
        dialog.path,
        dialog.mode === "create-file" ? "file" : "directory",
        dialog.entryType === "file" && dialog.fileKind === "article"
          ? deriveArticleFileName(dialog.value)
          : dialog.value,
        dialog.entryType === "file" && dialog.fileKind === "article"
          ? {
              ...dialog.metadata,
              title: dialog.value
            }
          : dialog.metadata,
        {
          allowDuplicateTitle: options?.allowDuplicateTitle
        }
      );
      await loadTree();
      setSelectedTreePath(result.path);
      if (result.path.toLowerCase().endsWith(".md")) {
        await openArticleDocument(result.path);
      }
      return;
    }

    if (dialog.mode === "rename") {
      const result = await api.renameFileSystemEntry(
        dialog.path,
        dialog.entryType === "file" && dialog.fileKind === "article"
          ? deriveArticleFileName(dialog.value)
          : dialog.value,
        dialog.entryType === "file" && dialog.fileKind === "article"
          ? {
              allowDuplicateTitle: options?.allowDuplicateTitle,
              title: dialog.value
            }
          : undefined
      );
      // For directories, the rename dialog only carries its editable fields
      // (tags/top). Merge with the folder's existing metadata so renaming does
      // not silently drop status/password/summary/etc.
      const renameMetadataBase =
        dialog.entryType === "directory"
          ? (await api.getFileSystemMetadata(result.path)).metadata
          : {};
      await api.saveFileSystemMetadata(result.path, {
        ...renameMetadataBase,
        ...dialog.metadata,
        ...(dialog.entryType === "file" && dialog.fileKind === "article"
          ? { title: dialog.value }
          : {})
      });
      await loadTree();
      setDocuments((current) => remapDocuments(current, dialog.path, result.path));
      remapStoredArticleCursorStates(dialog.path, result.path);
      setCollapsedTreePaths((current) => remapCollapsedTreePaths(current, dialog.path, result.path));
      setSelectedTreePath(result.path);
      if (dialog.entryType === "file" && dialog.fileKind === "article") {
        const updatedArticle = await api.getArticle(result.path);
        const updatedDocument = buildArticleDocument(updatedArticle);
        draftValuesRef.current[updatedDocument.id] = updatedDocument.value;
        setDocuments((current) => upsertDocument(remapDocuments(current, dialog.path, result.path), updatedDocument));
        activateDocument(updatedDocument.id);
        syncEditorValuePreservingView(updatedDocument.value);
        schedulePreviewSourceUpdate(updatedDocument.value, { immediate: true });
      }
      return;
    }

    await api.deleteFileSystemEntry(dialog.path);
    await loadTree();
    setDocuments((current) => removeDocuments(current, dialog.path));
    draftValuesRef.current = removeArticleDraftValues(draftValuesRef.current, dialog.path);
    discardStoredArticleCursorStates(dialog.path);
    setCollapsedTreePaths((current) => removeCollapsedTreePaths(current, dialog.path));
    activateDocument((current) =>
      current?.startsWith("article:") && matchesPathPrefix(current.slice("article:".length), dialog.path)
        ? HOME_DOCUMENT_ID
        : current
    );
    setSelectedTreePath(null);
  };

  const handleFileDialogSubmit = async (dialog: FileDialogState) => {
    setBusyMessage("Applying file system change...");
    try {
      await executeFileDialogOperation(dialog);
      setPageError(null);
      setFileDialog(null);
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === "duplicate_article_title") {
        setTitleConflictState({
          conflicts: error.conflicts ?? [],
          fileDialog: dialog
        });
      } else {
        setPageError(getErrorMessage(error));
      }
    } finally {
      setBusyMessage(null);
    }
  };

  const handleFolderMetadataSave = async (dialog: FolderMetadataDialogState) => {
    setBusyMessage("Saving folder metadata...");
    try {
      const d = dialog;
      const meta: Record<string, unknown> = {
        title: d.title.trim(),
        status: d.status.trim(),
        date: d.date.trim(),
        summary: d.summary.trim(),
        slug: d.slug.trim(),
        password: d.password.trim()
      };
      const tags = d.tags.split(",").map((t) => t.trim()).filter(Boolean);
      meta.tags = tags;
      meta.top = d.top.trim() ? Number(d.top) : "";
      if (d.extraJson.trim()) {
        try {
          Object.assign(meta, JSON.parse(d.extraJson));
        } catch {
          setPageError("Invalid JSON in extra field.");
          return;
        }
      }
      await api.saveFileSystemMetadata(d.path, meta);
      await loadTree();
      setPageError(null);
      setFolderMetadataDialog(null);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setBusyMessage(null);
    }
  };

  const handleTitleConflictContinue = async (state: TitleConflictState) => {
    setBusyMessage("Applying file system change...");
    try {
      await executeFileDialogOperation(state.fileDialog, {
        allowDuplicateTitle: true
      });
      setPageError(null);
      setTitleConflictState(null);
      setFileDialog(null);
    } catch (error) {
      setPageError(getErrorMessage(error));
    } finally {
      setBusyMessage(null);
    }
  };

  return {
    activeMetadataDialogFields,
    getCreateDialogMetadataDefaults,
    handleFileDialogSubmit,
    handleFolderMetadataSave,
    handleTitleConflictContinue,
    openFolderMetadataDialog,
    openRenameDialog
  };
}
