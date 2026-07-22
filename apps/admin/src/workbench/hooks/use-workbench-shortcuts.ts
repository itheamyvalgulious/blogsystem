import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import type * as monacoEditor from "monaco-editor";

import type { FileSystemNode } from "@blog-system/content-core";

import { api, type TreePayload } from "../../api";
import {
  getActiveKeybinding,
  isWorkbenchKeybindingCommand
} from "../../keybindings";
import {
  remapCollapsedTreePaths
} from "../../workbench-session";
import {
  closeDocument,
  HOME_DOCUMENT_ID,
  isArticleDocument,
  remapArticleDraftValues,
  remapDocuments
} from "../document-builders";
import { getParentPath } from "../path-utils";
import type { PluginRuntime } from "../plugin-runtime";
import type { FileDialogState, TreeClipboardState } from "../dialogs";
import type {
  NormalizedEditorConfig,
  SnippetLanguageId,
  WorkbenchApi,
  WorkbenchDocument
} from "../types";

function isWorkbenchTabShortcutEvent(event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "code" | "key">) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) {
    return false;
  }

  return (
    /^Digit[1-9]$/.test(event.code) ||
    event.code === "PageUp" ||
    event.code === "PageDown" ||
    event.key === "PageUp" ||
    event.key === "PageDown" ||
    event.code === "KeyW" ||
    event.key.toLowerCase() === "w"
  );
}

interface WorkbenchShortcutsOptions {
  activateDocument: (nextDocumentIdOrUpdater: SetStateAction<string | null>) => void;
  activeDocument: WorkbenchDocument | null;
  activeDocumentId: string | null;
  activePaneId: string | null;
  commandPaletteOpen: boolean;
  documents: WorkbenchDocument[];
  draftValuesRef: RefObject<Record<string, string>>;
  editorRef: RefObject<monacoEditor.editor.IStandaloneCodeEditor | null>;
  getSnippetLanguageForEditor: (
    model: monacoEditor.editor.ITextModel,
    position: monacoEditor.Position
  ) => SnippetLanguageId;
  loadTree: () => Promise<TreePayload>;
  normalizedConfig: NormalizedEditorConfig;
  pluginRuntime: PluginRuntime;
  remapStoredArticleCursorStates: (fromPath: string, toPath: string) => void;
  selectedTreeNode: FileSystemNode | null;
  setBusyMessage: Dispatch<SetStateAction<string | null>>;
  setCollapsedTreePaths: Dispatch<SetStateAction<Set<string>>>;
  setDocuments: Dispatch<SetStateAction<WorkbenchDocument[]>>;
  setFileDialog: Dispatch<SetStateAction<FileDialogState | null>>;
  setPageError: Dispatch<SetStateAction<string | null>>;
  setSelectedTreePath: Dispatch<SetStateAction<string | null>>;
  setTreeClipboard: Dispatch<SetStateAction<TreeClipboardState | null>>;
  sidebarGroupId: string;
  treeClipboard: TreeClipboardState | null;
  treeRootRef: RefObject<HTMLDivElement | null>;
  workbenchApiRef: RefObject<WorkbenchApi | null>;
}

export function useWorkbenchShortcuts({
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
}: WorkbenchShortcutsOptions) {
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (isWorkbenchTabShortcutEvent(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };

    document.addEventListener("keydown", listener, true);
    window.addEventListener("keydown", listener, true);
    return () => {
      document.removeEventListener("keydown", listener, true);
      window.removeEventListener("keydown", listener, true);
    };
  }, []);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (commandPaletteOpen) {
        return;
      }

      const editor = editorRef.current;
      const model = editor?.getModel();
      const position = editor?.getPosition();
      const snippetLanguage =
        editor && model && position && isArticleDocument(activeDocument) ? getSnippetLanguageForEditor(model, position) : "markdown";
      const context = {
        editorLangId: snippetLanguage,
        editorTextFocus: Boolean(editor?.hasTextFocus()),
        textInputFocus: Boolean(editor?.hasTextFocus()),
        inputFocus: Boolean(editor?.hasTextFocus()),
        suggestWidgetVisible: Boolean(document.querySelector(".suggest-widget.visible"))
      };
      const binding = getActiveKeybinding(normalizedConfig.keybindings, event, context);
      if (!binding || !workbenchApiRef.current || !isWorkbenchKeybindingCommand(binding.command)) {
        return;
      }

      const command = pluginRuntime.getCommand(
        binding.command === "workbench.action.showCommands" ? "workbench.showCommandPalette" : binding.command
      );
      if (!command) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void command.handler(workbenchApiRef.current);
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [activeDocument, commandPaletteOpen, normalizedConfig.keybindings, pluginRuntime]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (sidebarGroupId !== "explorer" || activePaneId !== "files") {
        return;
      }
      const activeElement = document.activeElement;
      if (!treeRootRef.current?.contains(activeElement) || activeElement instanceof HTMLInputElement || activeElement instanceof HTMLTextAreaElement) {
        return;
      }
      const targetNode = selectedTreeNode;
      const targetDirectoryPath = !targetNode ? "" : targetNode.type === "directory" ? targetNode.path : getParentPath(targetNode.path);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "c" && targetNode) {
        event.preventDefault();
        setTreeClipboard({ path: targetNode.path, mode: "copy" });
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "x" && targetNode) {
        event.preventDefault();
        setTreeClipboard({ path: targetNode.path, mode: "move" });
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v" && treeClipboard) {
        event.preventDefault();
        setBusyMessage("Applying file operation...");
        api.transferFileSystemEntry(treeClipboard.path, targetDirectoryPath, treeClipboard.mode)
          .then(async (result) => {
            await loadTree();
            if (treeClipboard.mode === "move") {
              setDocuments((current) => remapDocuments(current, treeClipboard.path, result.path));
              draftValuesRef.current = remapArticleDraftValues(
                draftValuesRef.current,
                treeClipboard.path,
                result.path
              );
              remapStoredArticleCursorStates(treeClipboard.path, result.path);
              setCollapsedTreePaths((current) =>
                remapCollapsedTreePaths(current, treeClipboard.path, result.path)
              );
              setTreeClipboard(null);
            }
            setSelectedTreePath(result.path);
            setPageError(null);
          })
          .catch((error: Error) => setPageError(error.message))
          .finally(() => setBusyMessage(null));
      } else if (event.key === "Delete" && targetNode) {
        event.preventDefault();
        setFileDialog({
          entryType: targetNode.type === "directory" ? "directory" : "file",
          fileKind: targetNode.type === "file" ? targetNode.fileKind : undefined,
          mode: "delete",
          path: targetNode.path,
          value: targetNode.name,
          metadata: {}
        });
      }
    };
    window.addEventListener("keydown", listener, true);
    return () => window.removeEventListener("keydown", listener, true);
  }, [activePaneId, remapStoredArticleCursorStates, selectedTreeNode, sidebarGroupId, treeClipboard]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (commandPaletteOpen) {
        return;
      }

      if (!isWorkbenchTabShortcutEvent(event)) {
        return;
      }

      const tabIndexMatch = /^Digit([1-9])$/.exec(event.code);
      if (tabIndexMatch) {
        const index = Number(tabIndexMatch[1]) - 1;
        const targetDocument = documents[index];
        if (targetDocument) {
          activateDocument(targetDocument.id);
        }
        return;
      }

      const isPageUp = event.code === "PageUp" || event.key === "PageUp";
      const isPageDown = event.code === "PageDown" || event.key === "PageDown";

      if (isPageUp || isPageDown) {
        const activeIndex = documents.findIndex((document) => document.id === activeDocumentId);
        if (activeIndex === -1 || documents.length === 0) {
          return;
        }

        const delta = isPageUp ? -1 : 1;
        const nextIndex = (activeIndex + delta + documents.length) % documents.length;
        activateDocument(documents[nextIndex]?.id ?? activeDocumentId);
        return;
      }

      if (event.key.toLowerCase() === "w") {
        if (activeDocumentId === HOME_DOCUMENT_ID) {
          return;
        }

        const nextDocuments = closeDocument(documents, activeDocumentId ?? "");
        setDocuments(nextDocuments);
        if (activeDocumentId) {
          const closedIndex = documents.findIndex((document) => document.id === activeDocumentId);
          const fallbackIndex = Math.max(0, closedIndex - 1);
          activateDocument(nextDocuments[fallbackIndex]?.id ?? HOME_DOCUMENT_ID);
        }
      }
    };

    document.addEventListener("keydown", listener, true);
    window.addEventListener("keydown", listener, true);
    return () => {
      document.removeEventListener("keydown", listener, true);
      window.removeEventListener("keydown", listener, true);
    };
  }, [activateDocument, activeDocumentId, commandPaletteOpen, documents]);
}
