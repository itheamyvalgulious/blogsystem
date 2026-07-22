import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  PROJECT_RECENT_ACTIVITY_WINDOW_DAYS,
  PROJECT_STATUS_VALUES,
  PROJECT_TASK_STATUS_VALUES,
  getErrorMessage,
  isProjectTaskCompletedStatus,
  parseProjectLogRecord,
  parseProjectRecord,
  parseProjectTaskRecord,
  serializeProjectLogRecord,
  serializeProjectRecord,
  serializeProjectTaskRecord,
  type ProjectLogRecord,
  type ProjectTaskRecord
} from "@blog-system/content-core";

import { api } from "../../api";

import {
  addProjectHomeWidget,
  formatProjectDate,
  formatProjectDateTime,
  isProjectPinnedToHome,
  notifyProjectHomeWidgetsChanged,
  removeProjectHomeWidget
} from "../project-utils";
import { subscribeProjectHomeWidgetsChanged } from "../project-utils";
import {
  buildProjectTaskRows,
  findProjectTaskDescendantIds,
  formatProjectTaskOptionLabel,
  formatProjectTaskReferences,
  resolveProjectTaskNoteLinks
} from "../project-task-utils";
import type { WorkbenchEditorComponentProps } from "../types";
import type {
  EditorContributionDefinition,
  ProjectLogWorkbenchDocument,
  ProjectTaskWorkbenchDocument,
  ProjectWorkbenchDocument
} from "../types";
import { MonacoMarkdownEditor } from "./monaco-markdown-editor";
import {
  ProjectLogCreateDialog,
  promptCreateProjectTaskTitle,
  useProjectTasks
} from "../panes/project-pane-shared";

type ProjectOverviewTab = "overview" | "tasks" | "logs" | "stats";

function renderMarkdownBodyEditor(
  editorKey: string,
  path: string,
  value: string,
  onChange: (nextValue: string) => void,
  onMount: WorkbenchEditorComponentProps["onMount"]
) {
  return (
    <MonacoMarkdownEditor
      editorKey={editorKey}
      onChange={onChange}
      onMount={onMount}
      path={path}
      value={value}
    />
  );
}

function updateProjectDocument(
  document: ProjectWorkbenchDocument,
  rawValue: string,
  update: Partial<ReturnType<typeof parseProjectRecord>>
) {
  const parsed = parseProjectRecord(document.projectId, rawValue);
  return serializeProjectRecord({
    ...parsed,
    ...update
  });
}

function updateTaskDocument(
  document: ProjectTaskWorkbenchDocument,
  rawValue: string,
  update: Partial<ReturnType<typeof parseProjectTaskRecord>>
) {
  const parsed = parseProjectTaskRecord(document.taskId, rawValue);
  return serializeProjectTaskRecord({
    ...parsed,
    ...update
  });
}

function updateLogDocument(
  document: ProjectLogWorkbenchDocument,
  rawValue: string,
  update: Partial<ReturnType<typeof parseProjectLogRecord>>
) {
  const parsed = parseProjectLogRecord(document.logId, rawValue);
  return serializeProjectLogRecord({
    ...parsed,
    ...update
  });
}

function buildProjectStats(tasks: ProjectTaskRecord[], logs: ProjectLogRecord[]) {
  const cutoff = Date.now() - PROJECT_RECENT_ACTIVITY_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  return {
    completedTaskCount: tasks.filter((task) => isProjectTaskCompletedStatus(task.status)).length,
    recentActivityCount: logs.filter((entry) => {
      const timestamp = Date.parse(entry.occurredAt || entry.updatedAt || entry.createdAt);
      return Number.isFinite(timestamp) && timestamp >= cutoff;
    }).length,
    taskCount: tasks.length
  };
}

function ProjectOverviewSection({
  children,
  title,
  toolbar
}: {
  children: ReactNode;
  title: string;
  toolbar?: ReactNode;
}) {
  return (
    <section className="project-overview-section">
      <div className="project-overview-section__header">
        <strong>{title}</strong>
        {toolbar ? <div className="render-style-actions">{toolbar}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function ProjectOverviewEditor({
  api: workbenchApi,
  document,
  onChange,
  onMount,
  path,
  value
}: WorkbenchEditorComponentProps) {
  const projectDocument = document as ProjectWorkbenchDocument;
  const parsed = parseProjectRecord(projectDocument.projectId, value);
  const projectId = projectDocument.projectId;
  const [activeTab, setActiveTab] = useState<ProjectOverviewTab>("overview");
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [tasks, setTasks] = useState<ProjectTaskRecord[]>([]);
  const [logs, setLogs] = useState<ProjectLogRecord[]>([]);
  const [isPinnedToHome, setIsPinnedToHome] = useState(false);
  const [updatingHome, setUpdatingHome] = useState(false);
  const [createLogDialogOpen, setCreateLogDialogOpen] = useState(false);
  const showWorkbenchError = workbenchApi.showError;

  const stats = useMemo(() => buildProjectStats(tasks, logs), [logs, tasks]);
  const taskRows = useMemo(() => buildProjectTaskRows(tasks), [tasks]);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  const loadHomePinState = useCallback(async () => {
    try {
      const payload = await api.getAdminHomeConfig();
      setIsPinnedToHome(isProjectPinnedToHome(payload.value, projectId));
    } catch {
      setIsPinnedToHome(false);
    }
  }, [projectId]);

  const loadProjectWorkspace = useCallback(async () => {
    setLoadingWorkspace(true);
    try {
      const [taskPayload, logPayload] = await Promise.all([
        api.listProjectTasks(projectId),
        api.listProjectLogs(projectId)
      ]);
      setTasks(taskPayload.tasks);
      setLogs(logPayload.logs);
      showWorkbenchError(null);
    } catch (error) {
      showWorkbenchError(getErrorMessage(error));
    } finally {
      setLoadingWorkspace(false);
    }
  }, [projectId, showWorkbenchError]);

  const [prevWorkspaceLoaders, setPrevWorkspaceLoaders] = useState({
    loadHomePinState,
    loadProjectWorkspace,
    projectId
  });
  if (
    prevWorkspaceLoaders.loadHomePinState !== loadHomePinState ||
    prevWorkspaceLoaders.loadProjectWorkspace !== loadProjectWorkspace ||
    prevWorkspaceLoaders.projectId !== projectId
  ) {
    setPrevWorkspaceLoaders({ loadHomePinState, loadProjectWorkspace, projectId });
    setActiveTab("overview");
  }

  useEffect(() => {
    queueMicrotask(() => {
      void loadProjectWorkspace();
      void loadHomePinState();
    });
  }, [loadHomePinState, loadProjectWorkspace, projectId]);

  useEffect(() => {
    const unsubscribe = subscribeProjectHomeWidgetsChanged((config) => {
      if (config) {
        setIsPinnedToHome(isProjectPinnedToHome(config, projectId));
        return;
      }

      void loadHomePinState();
    });

    return unsubscribe;
  }, [loadHomePinState, projectId]);

  const refreshProjectWorkspace = async () => {
    await Promise.all([loadProjectWorkspace(), workbenchApi.refreshWorkspaceData("projects")]);
  };

  const handleDeleteProject = async () => {
    if (!window.confirm(`Delete project "${parsed.title}"? This will remove its tasks and logs.`)) {
      return;
    }

    workbenchApi.setBusy(`Deleting ${parsed.title}...`);
    try {
      await api.deleteProject(projectId);
      await workbenchApi.refreshWorkspaceData("projects");
      workbenchApi.closeProjectDocuments(projectId);
      workbenchApi.showError(null);
    } catch (error) {
      workbenchApi.showError(getErrorMessage(error));
    } finally {
      workbenchApi.setBusy(null);
    }
  };

  const tabs: Array<{ id: ProjectOverviewTab; label: string }> = [
    { id: "overview", label: "Overview" },
    { id: "tasks", label: "Tasks" },
    { id: "logs", label: "Logs" },
    { id: "stats", label: "Stats" }
  ];

  return (
    <div className="project-editor project-editor--overview">
      <div className="project-editor__header">
        <div className="project-editor__header-row">
          <strong>{parsed.title}</strong>
          <span className="status-pill info">{parsed.status}</span>
        </div>
        <div className="project-editor__tabs" role="tablist" aria-label="Project overview sections">
          {tabs.map((tab) => (
            <button
              aria-selected={activeTab === tab.id}
              className={`project-editor__tab ${activeTab === tab.id ? "is-active" : ""}`}
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              role="tab"
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="project-editor__content">
        {activeTab === "overview" ? (
          <div className="project-overview-stack">
            <ProjectOverviewSection title="Project Details">
              <div className="project-editor__form-rows">
                <div className="project-editor__field-row">
                  <label className="project-editor__field">
                    <span>Title</span>
                    <input
                      className="project-editor__control"
                      value={parsed.title}
                      onChange={(event) =>
                        onChange(
                          updateProjectDocument(projectDocument, value, {
                            title: event.target.value
                          })
                        )
                      }
                    />
                  </label>
                  <label className="project-editor__field">
                    <span>Status</span>
                    <select
                      className="project-editor__control"
                      value={parsed.status}
                      onChange={(event) =>
                        onChange(
                          updateProjectDocument(projectDocument, value, {
                            status: event.target.value as (typeof PROJECT_STATUS_VALUES)[number]
                          })
                        )
                      }
                    >
                      {PROJECT_STATUS_VALUES.map((status) => (
                        <option key={status} value={status}>
                          {status}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="project-editor__field-row">
                  <label className="project-editor__field">
                    <span>Start Date</span>
                    <input
                      className="project-editor__control"
                      type="date"
                      value={parsed.startDate}
                      onChange={(event) =>
                        onChange(
                          updateProjectDocument(projectDocument, value, {
                            startDate: event.target.value
                          })
                        )
                      }
                    />
                  </label>
                  <label className="project-editor__field">
                    <span>Target Date</span>
                    <input
                      className="project-editor__control"
                      type="date"
                      value={parsed.targetDate}
                      onChange={(event) =>
                        onChange(
                          updateProjectDocument(projectDocument, value, {
                            targetDate: event.target.value
                          })
                        )
                      }
                    />
                  </label>
                </div>
              </div>
            </ProjectOverviewSection>

            <ProjectOverviewSection title="Goal">
              <div className="project-editor__embedded-editor">
                {renderMarkdownBodyEditor(
                  `${document.id}:${document.editorId}:goal`,
                  `${path}#goal.md`,
                  parsed.goal,
                  (nextGoal) =>
                    onChange(
                      updateProjectDocument(projectDocument, value, {
                        goal: nextGoal
                      })
                    ),
                  onMount
                )}
              </div>
            </ProjectOverviewSection>

            <ProjectOverviewSection title="Metadata">
              <div className="project-editor__meta">
                <span>Project Id: {parsed.id}</span>
                <span>Created: {parsed.createdAt || "Not set"}</span>
                <span>Updated: {parsed.updatedAt || "Not set"}</span>
              </div>
            </ProjectOverviewSection>

            <ProjectOverviewSection
              title="Home"
              toolbar={
                <button
                  className="action-button ghost"
                  onClick={async () => {
                    setUpdatingHome(true);
                    try {
                      const payload = await api.getAdminHomeConfig();
                      const nextValue = isPinnedToHome
                        ? removeProjectHomeWidget(payload.value, projectId)
                        : addProjectHomeWidget(payload.value, projectId);
                      await api.saveAdminHomeConfig(`${JSON.stringify(nextValue, null, 2)}\n`);
                      await workbenchApi.refreshWorkspaceData("adminHome");
                      notifyProjectHomeWidgetsChanged(nextValue);
                      setIsPinnedToHome(!isPinnedToHome);
                      workbenchApi.showError(null);
                    } catch (error) {
                      workbenchApi.showError(getErrorMessage(error));
                    } finally {
                      setUpdatingHome(false);
                    }
                  }}
                  type="button"
                >
                  {updatingHome ? "Saving..." : isPinnedToHome ? "Remove from Home" : "Add to Home"}
                </button>
              }
            >
              <p className="body-muted">
                Pin this project to the admin home dashboard to keep its current `todo` tasks visible at a glance.
              </p>
            </ProjectOverviewSection>

            <ProjectOverviewSection title="Danger Zone">
              <div className="project-editor__danger-zone">
                <p className="body-muted">
                  Delete this project and all of its task and log files.
                </p>
                <button className="action-button danger" onClick={() => void handleDeleteProject()} type="button">
                  Delete Project
                </button>
              </div>
            </ProjectOverviewSection>
          </div>
        ) : null}

        {activeTab === "tasks" ? (
          <div className="project-overview-stack">
            <ProjectOverviewSection
              title="Tasks"
              toolbar={
                <>
                  <button
                    className="action-button primary"
                    onClick={async () => {
                      const title = await promptCreateProjectTaskTitle(workbenchApi);
                      if (!title) {
                        return;
                      }

                      workbenchApi.setBusy(`Creating ${title}...`);
                      try {
                        const payload = await api.createProjectTask(projectId, title);
                        await refreshProjectWorkspace();
                        await workbenchApi.openResource({
                          kind: "projectTask",
                          projectId: payload.projectId,
                          taskId: payload.value.id
                        });
                        workbenchApi.showError(null);
                      } catch (error) {
                        workbenchApi.showError(getErrorMessage(error));
                      } finally {
                        workbenchApi.setBusy(null);
                      }
                    }}
                    type="button"
                  >
                    New Task
                  </button>
                  <button className="action-button ghost" onClick={() => void refreshProjectWorkspace()} type="button">
                    Refresh
                  </button>
                </>
              }
            >
              {loadingWorkspace ? (
                <div className="empty-state">Loading tasks...</div>
              ) : tasks.length === 0 ? (
                <div className="empty-state">No tasks yet.</div>
              ) : (
                <div className="project-editor__list">
                  {taskRows.map((row) => (
                    <button
                      className="search-result project-list-item"
                      key={row.task.id}
                      onClick={() =>
                        void workbenchApi.openResource({
                          kind: "projectTask",
                          projectId,
                          taskId: row.task.id
                        })
                      }
                      type="button"
                    >
                      <div className="project-list-item__content" style={{ paddingLeft: `${row.depth * 18}px` }}>
                        <div className="project-list-item__row">
                          <strong className="project-task-label">{row.task.title}</strong>
                          <span className="status-pill info">{row.task.status}</span>
                        </div>
                        <span>
                          Order {row.task.order} | Start {formatProjectDate(row.task.startDate)} | Due{" "}
                          {formatProjectDate(row.task.dueDate)}
                        </span>
                        <span>{row.task.excerpt || "Open to add details."}</span>
                        <span>Updated {formatProjectDateTime(row.task.updatedAt)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </ProjectOverviewSection>
          </div>
        ) : null}

        {activeTab === "logs" ? (
          <div className="project-overview-stack">
            <ProjectOverviewSection
              title="Logs"
              toolbar={
                <>
                  <button
                    className="action-button primary"
                    onClick={async () => {
                      if (tasks.filter((task) => task.status === "todo").length === 0) {
                        workbenchApi.showError("Create a todo task before adding a project log.");
                        return;
                      }

                      setCreateLogDialogOpen(true);
                    }}
                    type="button"
                  >
                    New Event
                  </button>
                  <button className="action-button ghost" onClick={() => void refreshProjectWorkspace()} type="button">
                    Refresh
                  </button>
                </>
              }
            >
              {loadingWorkspace ? (
                <div className="empty-state">Loading event log...</div>
              ) : logs.length === 0 ? (
                <div className="empty-state">No events yet.</div>
              ) : (
                <div className="project-editor__list">
                  {logs.map((entry) => (
                    <button
                      className="search-result project-list-item"
                      key={entry.id}
                      onClick={() =>
                        void workbenchApi.openResource({
                          kind: "projectLog",
                          logId: entry.id,
                          projectId
                        })
                      }
                      type="button"
                    >
                      <div className="project-list-item__row">
                        <strong>{entry.title}</strong>
                        <span className="tag-chip">{entry.type || "note"}</span>
                      </div>
                      <span>Occurred {formatProjectDateTime(entry.occurredAt)}</span>
                      {entry.taskIds.length > 0 ? <span>Tasks: {formatProjectTaskReferences(entry.taskIds, taskById)}</span> : null}
                      <span>{entry.excerpt || "Open to add event details."}</span>
                    </button>
                  ))}
                </div>
              )}
            </ProjectOverviewSection>
          </div>
        ) : null}

        {activeTab === "stats" ? (
          <div className="project-overview-stack">
            <ProjectOverviewSection
              title="Stats"
              toolbar={
                <button className="action-button ghost" onClick={() => void refreshProjectWorkspace()} type="button">
                  Refresh
                </button>
              }
            >
              {loadingWorkspace ? (
                <div className="empty-state">Loading stats...</div>
              ) : (
                <div className="project-stat-grid">
                  <div className="project-stat-tile large">
                    <strong>{stats.taskCount}</strong>
                    <span>Total tasks</span>
                  </div>
                  <div className="project-stat-tile large">
                    <strong>{stats.completedTaskCount}</strong>
                    <span>Completed tasks</span>
                  </div>
                  <div className="project-stat-tile large">
                    <strong>{stats.recentActivityCount}</strong>
                    <span>Recent activity ({PROJECT_RECENT_ACTIVITY_WINDOW_DAYS}d)</span>
                  </div>
                </div>
              )}
            </ProjectOverviewSection>
          </div>
        ) : null}
      </div>
      <ProjectLogCreateDialog
        open={createLogDialogOpen}
        tasks={tasks}
        onCancel={() => setCreateLogDialogOpen(false)}
        onConfirm={({ taskId, type }) => {
          workbenchApi.setBusy(`Creating ${type} event...`);
          void api
            .createProjectLog(projectId, { taskId, type })
            .then(async (payload) => {
              await refreshProjectWorkspace();
              await workbenchApi.openResource({
                kind: "projectLog",
                logId: payload.value.id,
                projectId: payload.projectId
              });
              workbenchApi.showError(null);
              setCreateLogDialogOpen(false);
            })
            .catch((error) => {
              workbenchApi.showError(getErrorMessage(error));
            })
            .finally(() => {
              workbenchApi.setBusy(null);
            });
        }}
      />
    </div>
  );
}

export function ProjectTaskEditor({
  api: workbenchApi,
  articleSummaries,
  document,
  onChange,
  onMount,
  path,
  value
}: WorkbenchEditorComponentProps) {
  const taskDocument = document as ProjectTaskWorkbenchDocument;
  const parsed = parseProjectTaskRecord(taskDocument.taskId, value);
  const { tasks } = useProjectTasks(taskDocument.projectId, workbenchApi);
  const descendantTaskIds = useMemo(() => findProjectTaskDescendantIds(tasks, parsed.id), [parsed.id, tasks]);
  const parentTaskRows = useMemo(
    () =>
      buildProjectTaskRows(tasks, {
        include: (task) => task.id !== parsed.id && !descendantTaskIds.has(task.id)
      }),
    [descendantTaskIds, parsed.id, tasks]
  );
  const linkedNotes = useMemo(
    () => resolveProjectTaskNoteLinks(parsed.body, articleSummaries),
    [articleSummaries, parsed.body]
  );

  return (
    <div className="project-editor project-editor--with-body">
      <div className="project-editor__header">
        <div className="project-editor__field-grid">
          <label>
            <span>Title</span>
            <input
              value={parsed.title}
              onChange={(event) =>
                onChange(
                  updateTaskDocument(taskDocument, value, {
                    title: event.target.value
                  })
                )
              }
            />
          </label>
          <label>
            <span>Status</span>
            <select
              value={parsed.status}
              onChange={(event) =>
                onChange(
                  updateTaskDocument(taskDocument, value, {
                    status: event.target.value as (typeof PROJECT_TASK_STATUS_VALUES)[number]
                  })
                )
              }
            >
              {PROJECT_TASK_STATUS_VALUES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Order</span>
            <input
              type="number"
              value={String(parsed.order)}
              onChange={(event) =>
                onChange(
                  updateTaskDocument(taskDocument, value, {
                    order: Number(event.target.value)
                  })
                )
              }
            />
          </label>
          <label>
            <span>Parent Task</span>
            <select
              value={parsed.parentTaskId}
              onChange={(event) =>
                onChange(
                  updateTaskDocument(taskDocument, value, {
                    parentTaskId: event.target.value
                  })
                )
              }
            >
              <option value="">No parent task</option>
              {parentTaskRows.map((row) => (
                <option key={row.task.id} value={row.task.id}>
                  {formatProjectTaskOptionLabel(row.task, row.depth)}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Start Date</span>
            <input
              type="date"
              value={parsed.startDate}
              onChange={(event) =>
                onChange(
                  updateTaskDocument(taskDocument, value, {
                    startDate: event.target.value
                  })
                )
              }
            />
          </label>
          <label>
            <span>Due Date</span>
            <input
              type="date"
              value={parsed.dueDate}
              onChange={(event) =>
                onChange(
                  updateTaskDocument(taskDocument, value, {
                    dueDate: event.target.value
                  })
                )
              }
            />
          </label>
        </div>
        <div className="project-editor__meta">
          <span>Task Id: {parsed.id}</span>
          <span>Created: {parsed.createdAt || "Not set"}</span>
          <span>Updated: {parsed.updatedAt || "Not set"}</span>
          <span>Type `@` to link notes as `@note/Note Title`.</span>
          <span>Pasted images are stored in the shared media library as `@media/...` links.</span>
        </div>
        {linkedNotes.length > 0 ? (
          <div className="project-editor__linked-resources">
            <span>Linked Notes</span>
            <div className="render-style-actions">
              {linkedNotes.map((entry) => (
                <button
                  className="action-button ghost"
                  key={entry.article.path}
                  onClick={() =>
                    void workbenchApi.openResource({
                      articlePath: entry.article.path,
                      kind: "article"
                    })
                  }
                  type="button"
                >
                  {entry.article.title}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="project-editor__body">
        {renderMarkdownBodyEditor(
          `${document.id}:${document.editorId}`,
          path,
          parsed.body,
          (nextBody) =>
            onChange(
              updateTaskDocument(taskDocument, value, {
                body: nextBody
              })
            ),
          onMount
        )}
      </div>
    </div>
  );
}

export function ProjectLogEditor({
  api: workbenchApi,
  document,
  onChange,
  onMount,
  path,
  value
}: WorkbenchEditorComponentProps) {
  const logDocument = document as ProjectLogWorkbenchDocument;
  const parsed = parseProjectLogRecord(logDocument.logId, value);
  const { tasks } = useProjectTasks(logDocument.projectId, workbenchApi);
  const selectedTaskId = parsed.taskIds[0] ?? "";
  const taskRows = buildProjectTaskRows(tasks, {
    include: (task) => task.status === "todo" || task.id === selectedTaskId,
    promoteHiddenParents: true
  });

  return (
    <div className="project-editor project-editor--with-body">
      <div className="project-editor__header">
        <div className="project-editor__field-grid">
          <label>
            <span>Type</span>
            <input
              value={parsed.type}
              onChange={(event) =>
                onChange(
                  updateLogDocument(logDocument, value, {
                    type: event.target.value
                  })
                )
              }
            />
          </label>
          <label>
            <span>Occurred At</span>
            <input
              type="datetime-local"
              value={parsed.occurredAt ? parsed.occurredAt.slice(0, 16) : ""}
              onChange={(event) =>
                onChange(
                  updateLogDocument(logDocument, value, {
                    occurredAt: event.target.value ? new Date(event.target.value).toISOString() : ""
                  })
                )
              }
            />
          </label>
          <label>
            <span>Task</span>
            <select
              value={selectedTaskId}
              onChange={(event) =>
                onChange(
                  updateLogDocument(logDocument, value, {
                    taskIds: event.target.value ? [event.target.value] : []
                  })
                )
              }
            >
              <option value="">{taskRows.length === 0 ? "No todo tasks available" : "Select a todo task"}</option>
              {taskRows.map((row) => (
                <option key={row.task.id} value={row.task.id}>
                  {formatProjectTaskOptionLabel(row.task, row.depth)}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="project-editor__meta">
          <span>Log Id: {parsed.id}</span>
          <span>Created: {parsed.createdAt || "Not set"}</span>
          <span>Updated: {parsed.updatedAt || "Not set"}</span>
          <span>Pasted images are stored in the shared media library as `@media/...` links.</span>
        </div>
      </div>
      <div className="project-editor__body">
        {renderMarkdownBodyEditor(
          `${document.id}:${document.editorId}`,
          path,
          parsed.body,
          (nextBody) =>
            onChange(
              updateLogDocument(logDocument, value, {
                body: nextBody
              })
            ),
          onMount
        )}
      </div>
    </div>
  );
}

export const projectMarkdownPreviewSource: NonNullable<EditorContributionDefinition["previewSource"]> = (
  document,
  value
) => {
  if (document.kind === "projectTask") {
    return parseProjectTaskRecord(document.taskId, value).body;
  }

  if (document.kind === "projectLog") {
    return parseProjectLogRecord(document.logId, value).body;
  }

  if (document.kind === "project") {
    return parseProjectRecord(document.projectId, value).goal;
  }

  return null;
};
