import type { RefObject } from "react";

import type { FileSystemNode, ThemeGroupSummary } from "@blog-system/content-core";

import { api } from "../api";
import { deriveArticleFileName } from "../utils";
import { remapArticleDraftValues, remapDocuments } from "./document-builders";
import { getParentPath } from "./path-utils";
import { remapCollapsedTreePaths } from "../workbench-session";
import type { CreateDialogFieldDefinition, WorkbenchDocument } from "./types";

export interface FileDialogState {
  entryType: "file" | "directory";
  fileKind?: "article" | "asset";
  mode: "create-file" | "create-directory" | "rename" | "delete";
  path: string;
  value: string;
  metadata: Record<string, string>;
}

export interface FolderMetadataDialogState {
  path: string;
  name: string;
  tags: string;
  title: string;
  status: string;
  top: string;
  date: string;
  summary: string;
  slug: string;
  password: string;
  extraJson: string;
}

export interface TitleConflictState {
  conflicts: Array<{ path: string; title: string }>;
  fileDialog: FileDialogState;
}

export interface TextInputDialogState {
  confirmLabel: string;
  description?: string;
  emptyValueMessage: string;
  error: string | null;
  label: string;
  overline: string;
  placeholder?: string;
  title: string;
  value: string;
}

export interface ContextMenuState {
  path: string;
  x: number;
  y: number;
}

export interface TreeClipboardState {
  path: string;
  mode: "copy" | "move";
}

interface FileEntryDialogProps {
  dialog: FileDialogState;
  metadataFields: CreateDialogFieldDefinition[];
  onChange: (next: FileDialogState | null) => void;
  onSubmit: (dialog: FileDialogState) => void | Promise<void>;
}

export function FileEntryDialog({ dialog, metadataFields, onChange, onSubmit }: FileEntryDialogProps) {
  return (
    <div className="dialog-backdrop" onClick={() => onChange(null)} role="presentation">
      <div className="dialog-card" onClick={(event) => event.stopPropagation()}>
        <p className="title-overline">File System</p>
        <h2>
          {dialog.mode === "create-file"
            ? "New File"
            : dialog.mode === "create-directory"
              ? "New Folder"
              : dialog.mode === "rename"
                ? "Rename Entry"
                : "Delete Entry"}
        </h2>
        {dialog.mode === "delete" ? (
          <p className="body-muted">Delete "{dialog.value}" and its nested content if applicable?</p>
        ) : (
          <>
            <label>
              <span>{dialog.entryType === "file" && dialog.fileKind === "article" ? "Title" : "Name"}</span>
              <input value={dialog.value} onChange={(event) => onChange({ ...dialog, value: event.target.value })} />
            </label>
            {dialog.entryType === "file" && dialog.fileKind === "article" ? (
              <p className="body-muted">File name: {deriveArticleFileName(dialog.value)}</p>
            ) : null}
            {metadataFields.map((field) => (
              <label key={field.id}>
                <span>{field.label}</span>
                <input
                  type={field.input === "number" ? "number" : "text"}
                  placeholder={field.placeholder}
                  value={dialog.metadata[field.id] ?? ""}
                  onChange={(event) =>
                    onChange({
                      ...dialog,
                      metadata: {
                        ...dialog.metadata,
                        [field.id]: event.target.value
                      }
                    })
                  }
                />
              </label>
            ))}
          </>
        )}
        <div className="dialog-actions">
          <button className="action-button ghost" onClick={() => onChange(null)} type="button">
            Cancel
          </button>
          <button
            className={`action-button ${dialog.mode === "delete" ? "danger" : "primary"}`}
            onClick={() => void onSubmit(dialog)}
            type="button"
          >
            {dialog.mode === "delete" ? "Delete" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

interface FolderMetadataDialogProps {
  dialog: FolderMetadataDialogState;
  onChange: (next: FolderMetadataDialogState | null) => void;
  onSave: (dialog: FolderMetadataDialogState) => void | Promise<void>;
}

export function FolderMetadataDialog({ dialog, onChange, onSave }: FolderMetadataDialogProps) {
  return (
    <div className="dialog-backdrop" onClick={() => onChange(null)} role="presentation">
      <div className="dialog-card" onClick={(event) => event.stopPropagation()}>
        <p className="title-overline">Folder Metadata</p>
        <h2>{dialog.name}</h2>
        <p className="body-muted">Values set here are inherited by articles in this folder (deepest ancestor wins).</p>
        {(["title", "tags", "status", "top", "date", "summary", "slug", "password"] as const).map((key) => (
          <label key={key}>
            <span>{key}</span>
            <input
              type={key === "top" ? "number" : "text"}
              placeholder={key === "tags" ? "tag-a, tag-b" : key === "status" ? "draft / working / published" : ""}
              value={dialog[key]}
              onChange={(event) => onChange({ ...dialog, [key]: event.target.value })}
            />
          </label>
        ))}
        <label>
          <span>extra (JSON)</span>
          <textarea
            rows={3}
            placeholder='{"customKey": "value"}'
            value={dialog.extraJson}
            onChange={(event) => onChange({ ...dialog, extraJson: event.target.value })}
          />
        </label>
        <div className="dialog-actions">
          <button className="action-button ghost" onClick={() => onChange(null)} type="button">
            Cancel
          </button>
          <button
            className="action-button primary"
            onClick={() => void onSave(dialog)}
            type="button"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

interface TitleConflictDialogProps {
  state: TitleConflictState;
  onClose: () => void;
  onContinue: (state: TitleConflictState) => void | Promise<void>;
}

export function TitleConflictDialog({ state, onClose, onContinue }: TitleConflictDialogProps) {
  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div className="dialog-card" onClick={(event) => event.stopPropagation()}>
        <p className="title-overline">Duplicate Title</p>
        <h2>Article title already exists</h2>
        <p className="body-muted">
          "{state.fileDialog.value}" already appears in these articles:
        </p>
        <div className="conflict-list">
          {state.conflicts.map((conflict) => (
            <div className="search-result" key={conflict.path}>
              <strong>{conflict.title}</strong>
              <span>{conflict.path}</span>
            </div>
          ))}
        </div>
        <div className="dialog-actions">
          <button className="action-button ghost" onClick={onClose} type="button">
            Cancel
          </button>
          <button
            className="action-button primary"
            onClick={() => void onContinue(state)}
            type="button"
          >
            Continue Anyway
          </button>
        </div>
      </div>
    </div>
  );
}

interface TextInputDialogProps {
  dialog: TextInputDialogState;
  inputRef: RefObject<HTMLInputElement | null>;
  onChange: (next: TextInputDialogState) => void;
  onClose: (value: string | null) => void;
}

export function TextInputDialog({ dialog, inputRef, onChange, onClose }: TextInputDialogProps) {
  return (
    <div className="dialog-backdrop" onClick={() => onClose(null)} role="presentation">
      <div className="dialog-card text-input-dialog" onClick={(event) => event.stopPropagation()}>
        <p className="title-overline">{dialog.overline}</p>
        <h2>{dialog.title}</h2>
        {dialog.description ? <p className="body-muted">{dialog.description}</p> : null}
        <label>
          <span>{dialog.label}</span>
          <input
            placeholder={dialog.placeholder}
            ref={inputRef}
            value={dialog.value}
            onChange={(event) =>
              onChange({
                ...dialog,
                error: null,
                value: event.target.value
              })
            }
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                onClose(null);
                return;
              }

              if (event.key !== "Enter") {
                return;
              }

              event.preventDefault();
              const nextValue = dialog.value.trim();
              if (!nextValue) {
                onChange({
                  ...dialog,
                  error: dialog.emptyValueMessage
                });
                return;
              }

              onClose(nextValue);
            }}
          />
        </label>
        {dialog.error ? <p className="body-muted">{dialog.error}</p> : null}
        <div className="dialog-actions">
          <button className="action-button ghost" onClick={() => onClose(null)} type="button">
            Cancel
          </button>
          <button
            className="action-button primary"
            onClick={() => {
              const nextValue = dialog.value.trim();
              if (!nextValue) {
                onChange({
                  ...dialog,
                  error: dialog.emptyValueMessage
                });
                return;
              }

              onClose(nextValue);
            }}
            type="button"
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

interface PreviewRenderDialogProps {
  groups: ThemeGroupSummary[];
  onClose: () => void;
}

export function PreviewRenderDialog({ groups, onClose }: PreviewRenderDialogProps) {
  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div className="dialog-card preview-render-dialog" onClick={(event) => event.stopPropagation()}>
        <div>
          <p className="title-overline">Preview Theme</p>
          <h2>Theme Preview Assets</h2>
          <p className="body-muted">
            Enabled theme groups contribute CSS and JS. Preview CSS follows the current workbench light or dark theme automatically.
          </p>
        </div>
        <div className="preview-render-style-list">
          {groups.length === 0 ? (
            <p className="body-muted">No enabled theme groups yet.</p>
          ) : (
            groups.map((group) => (
              <div className="preview-render-style-item" key={group.groupId}>
                <div>
                  <strong>{group.label}</strong>
                  <span>{group.groupId} | site mode {group.mode}</span>
                </div>
                <div className="search-result">
                  {group.files.map((file) => (
                    <span key={`${group.groupId}:${file.fileName}`}>
                      {file.fileName}
                      {file.type === "css" ? ` | ${file.colorMode}` : ""}
                      {file.adminPreview ? " | preview" : ""}
                    </span>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
        <div className="dialog-actions">
          <button className="action-button primary" onClick={onClose} type="button">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

interface TreeContextMenuProps {
  clipboard: TreeClipboardState | null;
  draftValuesRef: RefObject<Record<string, string>>;
  getCreateDialogMetadataDefaults: (entryType: "file" | "directory") => Record<string, string>;
  loadTree: () => Promise<unknown>;
  menuRef: RefObject<HTMLDivElement | null>;
  openFolderMetadataDialog: (node: { type: "directory"; path: string; name: string }) => void | Promise<void>;
  openRenameDialog: (node: FileSystemNode) => void | Promise<void>;
  position: { left: number; top: number };
  remapStoredArticleCursorStates: (fromPath: string, toPath: string) => void;
  setBusyMessage: (message: string | null) => void;
  setCollapsedTreePaths: (updater: (current: Set<string>) => Set<string>) => void;
  setContextMenuState: (next: ContextMenuState | null) => void;
  setDocuments: (updater: (current: WorkbenchDocument[]) => WorkbenchDocument[]) => void;
  setFileDialog: (next: FileDialogState | null) => void;
  setPageError: (message: string | null) => void;
  setSelectedTreePath: (path: string | null) => void;
  setTreeClipboard: (next: TreeClipboardState | null) => void;
  targetNode: FileSystemNode | null;
}

export function TreeContextMenu({
  clipboard: treeClipboard,
  draftValuesRef,
  getCreateDialogMetadataDefaults,
  loadTree,
  menuRef,
  openFolderMetadataDialog,
  openRenameDialog,
  position,
  remapStoredArticleCursorStates,
  setBusyMessage,
  setCollapsedTreePaths,
  setContextMenuState,
  setDocuments,
  setFileDialog,
  setPageError,
  setSelectedTreePath,
  setTreeClipboard,
  targetNode: contextTargetNode
}: TreeContextMenuProps) {
  return (
    <div className="context-menu-backdrop" onClick={() => setContextMenuState(null)} role="presentation">
      <div className="context-menu" ref={menuRef} style={{ left: position.left, top: position.top }} onClick={(event) => event.stopPropagation()}>
        {[
          ["new-file", "New File"],
          ["new-directory", "New Folder"],
          ["rename", "Rename"],
          ["edit-metadata", "Edit Metadata"],
          ["copy", "Copy"],
          ["cut", "Cut"],
          ["paste", "Paste"],
          ["delete", "Delete"]
        ].map(([action, label]) => (
          <button
            className={`context-menu-item ${action === "delete" ? "danger" : ""}`}
            disabled={(action === "paste" && !treeClipboard) || ((action === "rename" || action === "copy" || action === "cut" || action === "delete") && !contextTargetNode) || (action === "edit-metadata" && (!contextTargetNode || contextTargetNode.type !== "directory"))}
            key={action}
            onClick={() => {
              const targetNode = contextTargetNode;
              const targetDirectory =
                !targetNode
                  ? ""
                  : targetNode.type === "directory"
                    ? targetNode.path
                    : getParentPath(targetNode.path);
              setContextMenuState(null);
              if (action === "copy" && targetNode) {
                setTreeClipboard({ path: targetNode.path, mode: "copy" });
                return;
              }
              if (action === "cut" && targetNode) {
                setTreeClipboard({ path: targetNode.path, mode: "move" });
                return;
              }
              if (action === "paste" && treeClipboard) {
                setBusyMessage("Applying file operation...");
                api.transferFileSystemEntry(treeClipboard.path, targetDirectory, treeClipboard.mode)
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
                  })
                  .catch((error: Error) => setPageError(error.message))
                  .finally(() => setBusyMessage(null));
                return;
              }
              if (action === "edit-metadata" && targetNode && targetNode.type === "directory") {
                void openFolderMetadataDialog(targetNode);
                return;
              }
              if (action === "new-file" || action === "new-directory") {
                setFileDialog({
                  entryType: action === "new-file" ? "file" : "directory",
                  fileKind: action === "new-file" ? "article" : undefined,
                  mode: action === "new-file" ? "create-file" : "create-directory",
                  path: targetDirectory,
                  value: action === "new-file" ? "New File" : "new-folder",
                  metadata: getCreateDialogMetadataDefaults(action === "new-file" ? "file" : "directory")
                });
              } else if (action === "rename" && targetNode) {
                void openRenameDialog(targetNode);
              } else if (action === "delete" && targetNode) {
                setFileDialog({
                  entryType: targetNode.type === "directory" ? "directory" : "file",
                  fileKind: targetNode.type === "file" ? targetNode.fileKind : undefined,
                  mode: "delete",
                  path: targetNode.path,
                  value: targetNode.name,
                  metadata: {}
                });
              }
            }}
            type="button"
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
