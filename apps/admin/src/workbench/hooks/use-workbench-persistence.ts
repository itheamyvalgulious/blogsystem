import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import * as monacoEditor from "monaco-editor";

import {
  serializeCollapsedTreePaths,
  serializeFilePaneFilters,
  serializeWorkbenchResource,
  type SortOrder,
  type StatusFilter
} from "../../workbench-session";
import {
  ACTIVE_RESOURCE_STORAGE_KEY,
  COLLAPSED_TREE_PATHS_STORAGE_KEY,
  DISABLED_PLUGINS_STORAGE_KEY,
  FILE_PANE_FILTERS_STORAGE_KEY,
  PREVIEW_WIDTH_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  THEME_STORAGE_KEY
} from "../storage-keys";
import { applyCmTheme, defineCmTheme } from "../codemirror/cm-theme";
import type {
  ThemeDefinition,
  WorkbenchApi,
  WorkbenchDocument,
  WorkbenchResourceTarget
} from "../types";

interface WorkbenchPersistenceOptions {
  activeDocument: WorkbenchDocument | null;
  activeTheme: ThemeDefinition | null;
  authenticated: boolean;
  collapsedTreePaths: Set<string>;
  disabledPluginIds: string[];
  initialActiveResourceRef: RefObject<WorkbenchResourceTarget | null>;
  previewWidth: number;
  refreshWorkspace: () => Promise<void>;
  restoredSessionRef: RefObject<boolean>;
  searchQuery: string;
  setPageError: Dispatch<SetStateAction<string | null>>;
  showAssets: boolean;
  sidebarWidth: number;
  sortOrder: SortOrder;
  statusFilter: StatusFilter;
  tagFilter: string;
  workbenchApiRef: RefObject<WorkbenchApi | null>;
}

export function useWorkbenchPersistence({
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
}: WorkbenchPersistenceOptions) {
  useEffect(() => {
    try {
      window.localStorage.setItem(DISABLED_PLUGINS_STORAGE_KEY, JSON.stringify(disabledPluginIds));
    } catch {
      // Ignore storage failures and keep the in-memory plugin state.
    }
  }, [disabledPluginIds]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        FILE_PANE_FILTERS_STORAGE_KEY,
        serializeFilePaneFilters({ searchQuery, tagFilter, statusFilter, sortOrder, showAssets })
      );
    } catch {
      // Ignore storage failures and keep the in-memory filter state.
    }
  }, [searchQuery, tagFilter, statusFilter, sortOrder, showAssets]);

  useEffect(() => {
    try {
      window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(sidebarWidth));
    } catch {
      // Ignore storage failures and keep the in-memory layout state.
    }
  }, [sidebarWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(PREVIEW_WIDTH_STORAGE_KEY, String(previewWidth));
    } catch {
      // Ignore storage failures and keep the in-memory layout state.
    }
  }, [previewWidth]);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        COLLAPSED_TREE_PATHS_STORAGE_KEY,
        serializeCollapsedTreePaths(collapsedTreePaths)
      );
    } catch {
      // Ignore storage failures and keep the in-memory tree state.
    }
  }, [collapsedTreePaths]);

  useEffect(() => {
    if (!authenticated) {
      return;
    }
    try {
      const target = serializeWorkbenchResource(activeDocument);
      if (target) {
        window.localStorage.setItem(ACTIVE_RESOURCE_STORAGE_KEY, JSON.stringify(target));
      } else {
        window.localStorage.removeItem(ACTIVE_RESOURCE_STORAGE_KEY);
      }
    } catch {
      // Ignore storage failures and keep the in-memory workbench state.
    }
  }, [activeDocument, authenticated]);

  useEffect(() => {
    if (!activeTheme) {
      return;
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, activeTheme.id);
    } catch {
      // Ignore storage failures and keep the in-memory theme state.
    }
    document.documentElement.dataset.themeAppearance = activeTheme.appearance;
    Object.entries(activeTheme.cssVariables).forEach(([key, value]) => document.documentElement.style.setProperty(key, value));
    monacoEditor.editor.defineTheme(activeTheme.id, activeTheme.monacoTheme);
    monacoEditor.editor.setTheme(activeTheme.id);
    // CodeMirror engine theme (parallel to the Monaco calls above): build and
    // register the converted theme, then activate it in all live CM views.
    defineCmTheme(activeTheme);
    applyCmTheme(activeTheme.id);
  }, [activeTheme]);

  useEffect(() => {
    if (authenticated) {
      refreshWorkspace()
        .then(async () => {
          if (restoredSessionRef.current) {
            return;
          }
          restoredSessionRef.current = true;

          const target = initialActiveResourceRef.current;
          if (!target || target.kind === "home") {
            return;
          }

          await workbenchApiRef.current?.openResource(target);
        })
        .catch((error: Error) => setPageError(error.message));
    }
  }, [authenticated]);
}
