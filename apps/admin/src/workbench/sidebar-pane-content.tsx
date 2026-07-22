import type { Dispatch, ReactElement, RefObject, SetStateAction } from "react";

import { getErrorMessage, type FileSystemNode, type ProjectSummary } from "@blog-system/content-core";
import { api, type EditorConfigPayload, type TreePayload } from "../api";
import type { MarkdownOutlineItem } from "../markdown-outline";
import { remapCollapsedTreePaths, type SortOrder, type StatusFilter } from "../workbench-session";
import { builtInPlugins } from "./builtins";
import type { ContextMenuState, TreeClipboardState } from "./dialogs";
import {
  buildArticleDocument,
  isArticleDocument,
  isHomeDocument,
  remapArticleDraftValues,
  remapDocuments,
  upsertDocument
} from "./document-builders";
import { getBaseName } from "./path-utils";
import type { SidebarPaneItem } from "./sidebar";
import { filterFileTreeNode, sortTreeNodes } from "./tree-utils";
import type {
  WorkbenchApi,
  WorkbenchDocument,
  WorkbenchEditorId
} from "./types";

interface SidebarPaneContentProps {
  activeArticleLineNumber: number | null;
  activeDocument: WorkbenchDocument | null;
  activeOutlineItemId: string | null;
  activeSidebarPane: SidebarPaneItem | null;
  busyMessage: string | null;
  collapsedTreePaths: Set<string>;
  configPayload: EditorConfigPayload | null;
  deferredSearchQuery: string;
  disabledPluginIds: string[];
  draftValuesRef: RefObject<Record<string, string>>;
  getDraftValue: (document: WorkbenchDocument) => string;
  loadTree: () => Promise<TreePayload>;
  openArticleDocument: (articlePath: string, preferredEditorId?: WorkbenchEditorId) => Promise<void>;
  outlineTree: MarkdownOutlineItem[];
  pageError: string | null;
  projects: ProjectSummary[];
  publishBusy: boolean;
  publishStaticSite: () => Promise<void>;
  remapStoredArticleCursorStates: (fromPath: string, toPath: string) => void;
  saveActiveDocument: () => Promise<void>;
  schedulePreviewSourceUpdate: (nextValue: string, options?: { immediate?: boolean }) => void;
  searchQuery: string;
  selectedTags: TreePayload["tags"];
  selectedTreePath: string | null;
  setActiveDocumentId: Dispatch<SetStateAction<string | null>>;
  setBusyMessage: Dispatch<SetStateAction<string | null>>;
  setCollapsedTreePaths: Dispatch<SetStateAction<Set<string>>>;
  setContextMenuState: Dispatch<SetStateAction<ContextMenuState | null>>;
  setDisabledPluginIds: Dispatch<SetStateAction<string[]>>;
  setDocuments: Dispatch<SetStateAction<WorkbenchDocument[]>>;
  setPageError: (message: string | null) => void;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setSelectedTreePath: Dispatch<SetStateAction<string | null>>;
  setShowAssets: Dispatch<SetStateAction<boolean>>;
  setSortOrder: Dispatch<SetStateAction<SortOrder>>;
  setStatusFilter: Dispatch<SetStateAction<StatusFilter>>;
  setTagFilter: Dispatch<SetStateAction<string>>;
  showAssets: boolean;
  sortOrder: SortOrder;
  statusFilter: StatusFilter;
  syncEditorValuePreservingView: (nextValue: string) => void;
  tagFilter: string;
  treeClipboard: TreeClipboardState | null;
  treePayload: TreePayload | null;
  treeRootRef: RefObject<HTMLDivElement | null>;
  withResolvedEditor: <T extends WorkbenchDocument>(document: T, preferredEditorId?: WorkbenchEditorId) => T;
  workbenchApi: WorkbenchApi;
}

export function SidebarPaneContent({
  activeArticleLineNumber,
  activeDocument,
  activeOutlineItemId,
  activeSidebarPane,
  busyMessage,
  collapsedTreePaths,
  configPayload,
  deferredSearchQuery,
  disabledPluginIds,
  draftValuesRef,
  getDraftValue,
  loadTree,
  openArticleDocument,
  outlineTree,
  pageError,
  projects,
  publishBusy,
  publishStaticSite,
  remapStoredArticleCursorStates,
  saveActiveDocument,
  schedulePreviewSourceUpdate,
  searchQuery,
  selectedTags,
  selectedTreePath,
  setActiveDocumentId,
  setBusyMessage,
  setCollapsedTreePaths,
  setContextMenuState,
  setDisabledPluginIds,
  setDocuments,
  setPageError,
  setSearchQuery,
  setSelectedTreePath,
  setShowAssets,
  setSortOrder,
  setStatusFilter,
  setTagFilter,
  showAssets,
  sortOrder,
  statusFilter,
  syncEditorValuePreservingView,
  tagFilter,
  treeClipboard,
  treePayload,
  treeRootRef,
  withResolvedEditor,
  workbenchApi
}: SidebarPaneContentProps) {
  const renderFileNode = (node: FileSystemNode): ReactElement | null => {
    if (node.type === "directory") {
      const hasActiveFilters = deferredSearchQuery.trim().length > 0 || tagFilter !== "all" || statusFilter !== "all" || showAssets;
      const isExpanded = hasActiveFilters || !collapsedTreePaths.has(node.path);
      return (
        <details
          className="tree-group"
          key={node.path}
          onToggle={(event) => {
            const nextOpen = (event.currentTarget as HTMLDetailsElement).open;
            if (hasActiveFilters) {
              return;
            }
            setCollapsedTreePaths((current) => {
              const nextPaths = new Set(current);
              if (nextOpen) {
                nextPaths.delete(node.path);
              } else {
                nextPaths.add(node.path);
              }
              return nextPaths;
            });
          }}
          open={isExpanded}
        >
          <summary
            className={`tree-directory ${selectedTreePath === node.path ? "is-active" : ""}`}
            onClick={() => setSelectedTreePath(node.path)}
            onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSelectedTreePath(node.path);
              setContextMenuState({ path: node.path, x: event.clientX, y: event.clientY });
            }}
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              const sourcePath = event.dataTransfer.getData("text/plain");
              if (sourcePath) {
                setBusyMessage("Moving file...");
                api.transferFileSystemEntry(sourcePath, node.path, "move")
                  .then(async (result) => {
                    await loadTree();
                    setDocuments((current) => remapDocuments(current, sourcePath, result.path));
                    draftValuesRef.current = remapArticleDraftValues(
                      draftValuesRef.current,
                      sourcePath,
                      result.path
                    );
                    remapStoredArticleCursorStates(sourcePath, result.path);
                    setCollapsedTreePaths((current) =>
                      remapCollapsedTreePaths(current, sourcePath, result.path)
                    );
                    setSelectedTreePath(result.path);
                  })
                  .catch((error: Error) => setPageError(error.message))
                  .finally(() => setBusyMessage(null));
              }
            }}
          >
            {node.name}{node.hasMetadata ? <span className="folder-metadata-dot" /> : null}
          </summary>
          <div className="tree-children">{node.children.map((child) => renderFileNode(child))}</div>
        </details>
      );
    }

    return (
      <button
        className={`tree-file ${selectedTreePath === node.path ? "is-active" : ""}`}
        draggable
        key={node.path}
        onClick={() => {
          setSelectedTreePath(node.path);
          if (node.fileKind === "article") {
            void openArticleDocument(node.path);
          }
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setSelectedTreePath(node.path);
          setContextMenuState({ path: node.path, x: event.clientX, y: event.clientY });
        }}
        onDragStart={(event) => event.dataTransfer.setData("text/plain", node.path)}
        type="button"
      >
        <span className="tree-file-title">{node.article?.title ?? node.name}</span>
        {node.article ? (
          <span className={`status-badge ${node.article.status}`}>
            {node.article.status === "draft" ? "dra" : node.article.status === "working" ? "ing" : "pub"}
          </span>
        ) : (
          <span className="tag-chip">{node.extension || "file"}</span>
        )}
      </button>
    );
  };

  const renderSidebarStatusPills = () => (
    <>
      {busyMessage ? <span className="status-pill info">{busyMessage}</span> : null}
      {pageError ? <span className="status-pill error">{pageError}</span> : null}
    </>
  );

  if (!activeSidebarPane) {
    return (
      <div className="sidebar-scroll">
        <div className="empty-state">No pane available.</div>
      </div>
    );
  }

  if (activeSidebarPane.kind === "plugin" && activeSidebarPane.component) {
    const PaneComponent = activeSidebarPane.component;
    return (
      <PaneComponent
        activeArticleLineNumber={activeArticleLineNumber ?? 1}
        activeDocument={activeDocument}
        api={workbenchApi}
        getDocumentValue={getDraftValue}
        projects={projects}
        outlineTree={outlineTree}
        activeOutlineItemId={activeOutlineItemId}
      />
    );
  }

  if (activeSidebarPane.paneId === "files") {
    return (
      <div className="sidebar-scroll" ref={treeRootRef}>
        {treeClipboard ? (
          <div className="sidebar-section">
            <span className="status-pill info">
              {treeClipboard.mode === "copy" ? "Copy" : "Cut"}: {getBaseName(treeClipboard.path)}
            </span>
          </div>
        ) : null}
        <div className="sidebar-section filters-section">
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Filter files"
          />
          <div className="filter-inline-row">
            <label className="filter-inline">
              <span>Sort</span>
              <select value={sortOrder} onChange={(event) => setSortOrder(event.target.value as SortOrder)}>
                <option value="date-dec">Date &#8595;</option>
                <option value="date-inc">Date &#8593;</option>
                <option value="title-dec">Title &#8595;</option>
                <option value="title-inc">Title &#8593;</option>
              </select>
            </label>
            <label className="filter-inline">
              <span>Tag</span>
              <select value={tagFilter} onChange={(event) => setTagFilter(event.target.value)}>
                <option value="all">All</option>
                {selectedTags.map((tag) => (
                  <option key={tag.tag} value={tag.tag}>
                    {tag.tag} ({tag.count})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="filter-inline-row">
            <label className="filter-inline">
              <span>Status</span>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
              >
                <option value="all">All</option>
                <option value="draft">Draft</option>
                <option value="working">Working</option>
                <option value="published">Published</option>
              </select>
            </label>
            <label className="filter-inline filter-checkbox-inline">
              <input type="checkbox" checked={showAssets} onChange={(event) => setShowAssets(event.target.checked)} />
              <span>Show assets</span>
            </label>
          </div>
        </div>
        <div
          className="sidebar-section tree-section"
          onContextMenu={(event) => {
            event.preventDefault();
            setContextMenuState({ path: "", x: event.clientX, y: event.clientY });
          }}
        >
          {sortTreeNodes(treePayload?.fileTree ?? [], sortOrder)
            .filter((node) => filterFileTreeNode(node, deferredSearchQuery, tagFilter, statusFilter, showAssets))
            .map((node) => renderFileNode(node))}
        </div>
      </div>
    );
  }

  if (activeSidebarPane.paneId === "edit-actions") {
    return (
      <div className="sidebar-scroll">
        <div className="sidebar-section">
          <strong>Edit Actions</strong>
          <div className="edit-actions">
            <button
              className="action-button accent"
              disabled={publishBusy}
              onClick={() => void publishStaticSite()}
              type="button"
            >
              {publishBusy ? "Publishing..." : "Publish Static Site"}
            </button>
            {isArticleDocument(activeDocument) ? (
              <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                <select
                  value={activeDocument.record.status}
                  onChange={async (event) => {
                    const nextStatus = event.target.value as "draft" | "working" | "published";
                    if (nextStatus === activeDocument.record.status) return;
                    setBusyMessage("Updating status...");
                    try {
                      const updated = await api.updateStatus(activeDocument.articlePath, nextStatus);
                      const updatedDocument = withResolvedEditor(
                        buildArticleDocument(updated),
                        activeDocument.editorId
                      );
                      setDocuments((current) => upsertDocument(current, updatedDocument));
                      setActiveDocumentId(updatedDocument.id);
                      draftValuesRef.current[updatedDocument.id] = updatedDocument.value;
                      syncEditorValuePreservingView(updatedDocument.value);
                      schedulePreviewSourceUpdate(updatedDocument.value, { immediate: true });
                      await loadTree();
                      setPageError(null);
                    } catch (error) {
                      setPageError(getErrorMessage(error));
                    } finally {
                      setBusyMessage(null);
                    }
                  }}
                >
                  <option value="draft">Draft (dra)</option>
                  <option value="working">Working (ing)</option>
                  <option value="published">Published (pub)</option>
                </select>
              </div>
            ) : null}
            <button
              className="action-button primary"
              disabled={!activeDocument || isHomeDocument(activeDocument)}
              onClick={() => void saveActiveDocument()}
              type="button"
            >
              Save
            </button>
          </div>
          {renderSidebarStatusPills()}
          {configPayload?.warnings.length ? (
            <span className="status-pill warning">
              {configPayload.warnings.length} config warning{configPayload.warnings.length > 1 ? "s" : ""}
            </span>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="sidebar-scroll">
      <div className="sidebar-section plugin-list">
        {builtInPlugins.map((plugin) => {
          const enabled = !disabledPluginIds.includes(plugin.id);
          return (
            <div className="plugin-card" key={plugin.id}>
              <div className="plugin-card-header">
                <div>
                  <strong>{plugin.label}</strong>
                  <p>{plugin.description}</p>
                </div>
                <button
                  className={`action-button ${enabled ? "ghost" : "primary"}`}
                  onClick={() =>
                    setDisabledPluginIds((current) =>
                      enabled ? [...current, plugin.id] : current.filter((id) => id !== plugin.id)
                    )
                  }
                  type="button"
                >
                  {enabled ? "Disable" : "Enable"}
                </button>
              </div>
              <div className="plugin-card-meta">
                <span className={`status-pill ${enabled ? "info" : "warning"}`}>
                  {enabled ? "Enabled" : "Disabled"}
                </span>
                <span className="body-muted">{plugin.id}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
