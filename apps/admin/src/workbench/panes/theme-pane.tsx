import { useEffect, useRef, useState } from "react";

import { api, type ThemeGroupsPayload } from "../../api";

import type { PaneComponentProps } from "../types";
import { normalizeThemeGroupId } from "../theme-utils";

export function ThemePane({ api: workbenchApi }: PaneComponentProps) {
  const [themeGroups, setThemeGroups] = useState<ThemeGroupsPayload | null>(null);
  const [contextMenu, setContextMenu] = useState<
    | { kind: "file"; groupId: string; fileName: string; x: number; y: number }
    | { kind: "group"; groupId: string; x: number; y: number }
    | null
  >(null);
  const clickTimersRef = useRef(new Map<string, number>());

  const loadThemeGroups = async () => {
    try {
      const payload = await api.listThemeGroups();
      setThemeGroups(payload);
      workbenchApi.showError(null);
      return payload;
    } catch (error) {
      workbenchApi.showError((error as Error).message);
      return null;
    }
  };

  useEffect(() => {
    void loadThemeGroups();
  }, []);

  useEffect(
    () => () => {
      clickTimersRef.current.forEach((timerId) => window.clearTimeout(timerId));
      clickTimersRef.current.clear();
    },
    []
  );

  const refreshThemeGroups = async () => {
    await Promise.all([loadThemeGroups(), workbenchApi.refreshWorkspaceData("themeGroups")]);
  };

  const runThemeAction = async (message: string, task: () => Promise<void>) => {
    setContextMenu(null);
    workbenchApi.setBusy(message);
    try {
      await task();
      await refreshThemeGroups();
      workbenchApi.showError(null);
    } catch (error) {
      workbenchApi.showError((error as Error).message);
    } finally {
      workbenchApi.setBusy(null);
    }
  };

  const createGroup = async () => {
    const rawValue = window.prompt("Theme group id");
    const normalizedGroupId = normalizeThemeGroupId(rawValue ?? "");
    if (!normalizedGroupId) {
      return;
    }

    await runThemeAction(`Creating ${normalizedGroupId}...`, async () => {
      await api.createThemeGroup(normalizedGroupId);
      await workbenchApi.openResource({
        kind: "themeGroupConfig",
        groupId: normalizedGroupId
      });
    });
  };

  const renameGroup = async (groupId: string) => {
    const nextGroupId = normalizeThemeGroupId(window.prompt("Rename theme group", groupId) ?? "");
    if (!nextGroupId || nextGroupId === groupId) {
      return;
    }

    await runThemeAction(`Renaming ${groupId}...`, async () => {
      const payload = await api.renameThemeGroup(groupId, nextGroupId);
      await workbenchApi.openResource({
        kind: "themeGroupConfig",
        groupId: payload.groupId
      });
    });
  };

  const deleteGroup = async (groupId: string) => {
    if (!window.confirm(`Delete "${groupId}"?`)) {
      return;
    }

    await runThemeAction(`Deleting ${groupId}...`, async () => {
      await api.deleteThemeGroup(groupId);
    });
  };

  const clearPendingClick = (key: string) => {
    const timerId = clickTimersRef.current.get(key);
    if (timerId !== undefined) {
      window.clearTimeout(timerId);
      clickTimersRef.current.delete(key);
    }
  };

  const queueSingleClick = (key: string, action: () => void) => {
    clearPendingClick(key);
    const timerId = window.setTimeout(() => {
      clickTimersRef.current.delete(key);
      action();
    }, 220);
    clickTimersRef.current.set(key, timerId);
  };

  const setGroupEnabled = async (groupId: string, enable: boolean) => {
    await runThemeAction(`${enable ? "Enabling" : "Disabling"} ${groupId}...`, async () => {
      const group = await api.getThemeGroup(groupId);
      await api.saveThemeGroup(
        groupId,
        `${JSON.stringify(
          {
            ...group.value,
            enable
          },
          null,
          2
        )}\n`
      );
    });
  };

  const createAsset = async (groupId: string, type: "css" | "js") => {
    const group = themeGroups?.groups.find((item) => item.groupId === groupId) ?? null;
    const defaultFileName = type === "css" ? `custom.${group?.mode ?? "light"}.css` : "custom.js";
    const fileName = window.prompt(`Create ${type.toUpperCase()} file`, defaultFileName);
    if (!fileName?.trim()) {
      return;
    }

    await runThemeAction(`Creating ${fileName}...`, async () => {
      const payload = await api.createThemeAsset(
        groupId,
        fileName.trim(),
        type,
        false,
        type === "css" ? group?.mode : undefined
      );
      await workbenchApi.openResource({
        kind: "themeAsset",
        groupId: payload.groupId,
        fileName: payload.fileName
      });
    });
  };

  const renameAsset = async (groupId: string, fileName: string) => {
    const nextFileName = window.prompt("Rename theme asset", fileName)?.trim();
    if (!nextFileName || nextFileName === fileName) {
      return;
    }

    await runThemeAction(`Renaming ${fileName}...`, async () => {
      const payload = await api.renameThemeAsset(groupId, fileName, nextFileName);
      await workbenchApi.openResource({
        kind: "themeAsset",
        groupId: payload.groupId,
        fileName: payload.fileName
      });
    });
  };

  const deleteAsset = async (groupId: string, fileName: string) => {
    if (!window.confirm(`Delete "${fileName}" from "${groupId}"?`)) {
      return;
    }

    await runThemeAction(`Deleting ${fileName}...`, async () => {
      await api.deleteThemeAsset(groupId, fileName);
    });
  };

  const setAssetAdminPreview = async (groupId: string, fileName: string, adminPreview: boolean) => {
    await runThemeAction(`${adminPreview ? "Enabling" : "Disabling"} preview for ${fileName}...`, async () => {
      const group = await api.getThemeGroup(groupId);
      await api.saveThemeGroup(
        groupId,
        `${JSON.stringify(
          {
            ...group.value,
            files: group.value.files.map((file) =>
              file.fileName === fileName
                ? {
                    ...file,
                    adminPreview
                  }
                : file
            )
          },
          null,
          2
        )}\n`
      );
    });
  };

  return (
    <div className="sidebar-scroll">
      <div className="sidebar-section">
        <div className="edit-actions">
          <button className="action-button primary" onClick={() => void createGroup()} type="button">
            Create Theme Group
          </button>
          <button className="action-button ghost" onClick={() => void refreshThemeGroups()} type="button">
            Refresh
          </button>
        </div>
      </div>
      <div className="sidebar-section search-results">
        {!themeGroups ? (
          <div className="empty-state">Loading theme groups...</div>
        ) : themeGroups.groups.length === 0 ? (
          <div className="empty-state">No groups yet.</div>
        ) : (
          <div className="theme-group-list">
            {themeGroups.groups.map((group) => {
              const groupKey = `group:${group.groupId}`;

              return (
                <div className="theme-group-card" key={group.groupId}>
                  <button
                    className={`theme-group-row ${group.enable ? "is-enabled" : "is-disabled"}`}
                    onClick={() =>
                      queueSingleClick(groupKey, () => {
                        void setGroupEnabled(group.groupId, !group.enable);
                      })
                    }
                    onContextMenu={(event) => {
                      event.preventDefault();
                      clearPendingClick(groupKey);
                      setContextMenu({
                        groupId: group.groupId,
                        kind: "group",
                        x: event.clientX,
                        y: event.clientY
                      });
                    }}
                    onDoubleClick={() => {
                      clearPendingClick(groupKey);
                      void workbenchApi.openResource({
                        kind: "themeGroupConfig",
                        groupId: group.groupId
                      });
                    }}
                    title={`${group.label} (${group.groupId})`}
                    type="button"
                  >
                    <span>{group.label}</span>
                  </button>
                  <div className="theme-group-card__files">
                    {group.files.length === 0 ? (
                      <div className="empty-state">No files.</div>
                    ) : (
                      group.files.map((file) => {
                        const fileKey = `file:${group.groupId}:${file.fileName}`;

                        return (
                          <button
                            className={`theme-file-row ${file.adminPreview ? "is-preview" : "is-normal"}`}
                            key={`${group.groupId}:${file.fileName}`}
                            onClick={() =>
                              queueSingleClick(fileKey, () => {
                                void setAssetAdminPreview(group.groupId, file.fileName, !file.adminPreview);
                              })
                            }
                            onContextMenu={(event) => {
                              event.preventDefault();
                              clearPendingClick(fileKey);
                              setContextMenu({
                                fileName: file.fileName,
                                groupId: group.groupId,
                                kind: "file",
                                x: event.clientX,
                                y: event.clientY
                              });
                            }}
                            onDoubleClick={() => {
                              clearPendingClick(fileKey);
                              void workbenchApi.openResource({
                                kind: "themeAsset",
                                groupId: group.groupId,
                                fileName: file.fileName
                              });
                            }}
                            title={file.fileName}
                            type="button"
                          >
                            <span>{file.fileName}</span>
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {contextMenu ? (
        <div className="context-menu-backdrop" onClick={() => setContextMenu(null)} role="presentation">
          <div
            className="context-menu"
            onClick={(event) => event.stopPropagation()}
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            {contextMenu.kind === "group" ? (
              <>
                <button
                  className="context-menu-item"
                  onClick={() => void createAsset(contextMenu.groupId, "css")}
                  type="button"
                >
                  New CSS
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => void createAsset(contextMenu.groupId, "js")}
                  type="button"
                >
                  New JS
                </button>
                <button
                  className="context-menu-item"
                  onClick={() => void renameGroup(contextMenu.groupId)}
                  type="button"
                >
                  Rename
                </button>
                <button
                  className="context-menu-item danger"
                  onClick={() => void deleteGroup(contextMenu.groupId)}
                  type="button"
                >
                  Delete
                </button>
              </>
            ) : (
              <>
                <button
                  className="context-menu-item"
                  onClick={() => void renameAsset(contextMenu.groupId, contextMenu.fileName)}
                  type="button"
                >
                  Rename
                </button>
                <button
                  className="context-menu-item danger"
                  onClick={() => void deleteAsset(contextMenu.groupId, contextMenu.fileName)}
                  type="button"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
