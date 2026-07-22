import { useCallback, useEffect, useMemo, useState } from "react";

import { getErrorMessage, type ProjectLogRecord } from "@blog-system/content-core";

import { api } from "../../api";

import { formatProjectDateTime } from "../project-utils";
import { formatProjectTaskReferences } from "../project-task-utils";
import type { PaneComponentProps } from "../types";
import {
  ProjectLogCreateDialog,
  promptCreateProject,
  useProjectSelection,
  useProjectTasks
} from "./project-pane-shared";

export function ProjectLogPane({
  activeDocument,
  api: workbenchApi,
  projects: availableProjects
}: PaneComponentProps) {
  const {
    loadProjects,
    loadingProjects,
    projects,
    selectedProject,
    selectedProjectId,
    setSelectedProjectId
  } = useProjectSelection(activeDocument, workbenchApi, availableProjects);
  const { loadTasks, loadingTasks, tasks } = useProjectTasks(selectedProjectId, workbenchApi);
  const [logs, setLogs] = useState<ProjectLogRecord[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const taskById = useMemo(() => new Map(tasks.map((task) => [task.id, task])), [tasks]);

  const loadLogs = useCallback(async () => {
    if (!selectedProjectId) {
      setLogs([]);
      return [];
    }

    setLoadingLogs(true);
    try {
      const payload = await api.listProjectLogs(selectedProjectId);
      setLogs(payload.logs);
      workbenchApi.showError(null);
      return payload.logs;
    } catch (error) {
      workbenchApi.showError(getErrorMessage(error));
      return [];
    } finally {
      setLoadingLogs(false);
    }
  }, [selectedProjectId, workbenchApi]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadLogs();
    });
  }, [loadLogs]);

  const refresh = async () => {
    await Promise.all([
      loadProjects(),
      loadLogs(),
      loadTasks(),
      workbenchApi.refreshWorkspaceData("projects")
    ]);
  };

  return (
    <div className="sidebar-scroll">
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <strong>Log</strong>
          <div className="render-style-actions">
            <button
              className="action-button primary"
              onClick={async () => {
                let targetProjectId = selectedProjectId;
                if (!targetProjectId) {
                  const projectPayload = await promptCreateProject(workbenchApi);
                  if (!projectPayload) {
                    return;
                  }

                  targetProjectId = projectPayload.value.id;
                  setSelectedProjectId(targetProjectId);
                  await refresh();
                }

                const todoTaskCount = (targetProjectId === selectedProjectId ? tasks : await loadTasks()).filter(
                  (task) => task.status === "todo"
                ).length;
                if (todoTaskCount === 0) {
                  workbenchApi.showError("Create a todo task before adding a project log.");
                  return;
                }

                setCreateDialogOpen(true);
              }}
              type="button"
            >
              New Event
            </button>
            <button className="action-button ghost" onClick={() => void refresh()} type="button">
              Refresh
            </button>
          </div>
        </div>
        <label>
          <span>Project</span>
          <select
            value={selectedProjectId ?? ""}
            onChange={(event) => setSelectedProjectId(event.target.value || null)}
          >
            {projects.length === 0 ? <option value="">No projects</option> : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="sidebar-section search-results">
        {loadingProjects || loadingLogs || loadingTasks ? (
          <div className="empty-state">Loading event log...</div>
        ) : !selectedProject ? (
          <div className="empty-state">Choose a project to see its event stream.</div>
        ) : logs.length === 0 ? (
          <div className="empty-state">No events yet.</div>
        ) : (
          logs.map((entry) => (
            <button
              className="search-result project-list-item"
              key={entry.id}
              onClick={() =>
                void workbenchApi.openResource({
                  kind: "projectLog",
                  logId: entry.id,
                  projectId: selectedProject.id
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
          ))
        )}
      </div>
      <ProjectLogCreateDialog
        open={createDialogOpen}
        tasks={tasks}
        onCancel={() => setCreateDialogOpen(false)}
        onConfirm={({ taskId, type }) => {
          if (!selectedProjectId) {
            return;
          }

          workbenchApi.setBusy(`Creating ${type} event...`);
          void api
            .createProjectLog(selectedProjectId, { taskId, type })
            .then(async (payload) => {
              await refresh();
              await workbenchApi.openResource({
                kind: "projectLog",
                logId: payload.value.id,
                projectId: payload.projectId
              });
              workbenchApi.showError(null);
              setCreateDialogOpen(false);
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
