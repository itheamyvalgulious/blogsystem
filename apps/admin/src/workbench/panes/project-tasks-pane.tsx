import { getErrorMessage } from "@blog-system/content-core";

import { api } from "../../api";
import { formatProjectDate, formatProjectDateTime } from "../project-utils";
import { buildProjectTaskRows } from "../project-task-utils";
import type { PaneComponentProps } from "../types";
import {
  promptCreateProject,
  promptCreateProjectTaskTitle,
  useProjectSelection,
  useProjectTasks
} from "./project-pane-shared";

export function ProjectTasksPane({
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
  const taskRows = buildProjectTaskRows(tasks);

  const refresh = async () => {
    await Promise.all([
      loadProjects(),
      loadTasks(),
      workbenchApi.refreshWorkspaceData("projects")
    ]);
  };

  return (
    <div className="sidebar-scroll">
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <strong>Tasks</strong>
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

                const title = await promptCreateProjectTaskTitle(workbenchApi);
                if (!title || !targetProjectId) {
                  return;
                }

                workbenchApi.setBusy(`Creating ${title}...`);
                try {
                  const payload = await api.createProjectTask(targetProjectId, title);
                  await refresh();
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
        {loadingProjects || loadingTasks ? (
          <div className="empty-state">Loading tasks...</div>
        ) : !selectedProject ? (
          <div className="empty-state">Choose a project to see its task list.</div>
        ) : tasks.length === 0 ? (
          <div className="empty-state">No tasks yet.</div>
        ) : (
          taskRows.map((row) => (
            <button
              className="search-result project-list-item"
              key={row.task.id}
              onClick={() =>
                void workbenchApi.openResource({
                  kind: "projectTask",
                  projectId: selectedProject.id,
                  taskId: row.task.id
                })
              }
              type="button"
            >
              <div className="project-list-item__content" style={{ paddingLeft: `${row.depth * 18}px` }}>
                <div className="project-list-item__row">
                  <strong className="project-task-label">{row.task.title}</strong>
                  <span className="status-pill info">{row.task.status || "todo"}</span>
                </div>
                <span>
                  Order {row.task.order} | Start {formatProjectDate(row.task.startDate)} | Due{" "}
                  {formatProjectDate(row.task.dueDate)}
                </span>
                <span>{row.task.excerpt || "Open to add details."}</span>
                <span>Updated {formatProjectDateTime(row.task.updatedAt)}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
