import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { getErrorMessage, type ProjectSummary, type ProjectTaskRecord } from "@blog-system/content-core";

import { api } from "../../api";

import {
  resolveSelectedProjectId,
  storeProjectId
} from "../project-utils";
import type { PaneComponentProps, WorkbenchApi, WorkbenchDocument } from "../types";
import { buildProjectTaskRows, formatProjectTaskOptionLabel } from "../project-task-utils";

export function getProjectIdFromDocument(document: WorkbenchDocument | null) {
  if (!document) {
    return null;
  }

  if (document.kind === "project" || document.kind === "projectTask" || document.kind === "projectLog") {
    return document.projectId;
  }

  return null;
}

export function useProjectSelection(
  activeDocument: PaneComponentProps["activeDocument"],
  workbenchApi: PaneComponentProps["api"],
  availableProjects: ProjectSummary[]
) {
  const activeProjectId = getProjectIdFromDocument(activeDocument);
  const [projects, setProjects] = useState<ProjectSummary[]>(availableProjects);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(activeProjectId);
  const [loadingProjects, setLoadingProjects] = useState(availableProjects.length === 0);
  const selectedProjectIdRef = useRef<string | null>(selectedProjectId);
  const showError = workbenchApi.showError;

  const syncSelectedProject = useCallback((projectId: string | null) => {
    selectedProjectIdRef.current = projectId;
    setSelectedProjectId(projectId);
  }, []);

  const loadProjects = useCallback(async () => {
    setLoadingProjects(true);
    try {
      const payload = await api.listProjects();
      setProjects(payload.projects);
      const nextProjectId = resolveSelectedProjectId(
        payload.projects,
        activeProjectId ?? selectedProjectIdRef.current
      );
      syncSelectedProject(nextProjectId);
      showError(null);
      return payload.projects;
    } catch (error) {
      showError(getErrorMessage(error));
      return [];
    } finally {
      setLoadingProjects(false);
    }
  }, [activeProjectId, showError, syncSelectedProject]);

  useEffect(() => {
    selectedProjectIdRef.current = selectedProjectId;
    storeProjectId(selectedProjectId);
  }, [selectedProjectId]);

  const [prevSyncedProjects, setPrevSyncedProjects] = useState(availableProjects);
  const [prevSyncedActiveProjectId, setPrevSyncedActiveProjectId] = useState(activeProjectId);
  if (prevSyncedProjects !== availableProjects || prevSyncedActiveProjectId !== activeProjectId) {
    setPrevSyncedProjects(availableProjects);
    setPrevSyncedActiveProjectId(activeProjectId);
    setProjects(availableProjects);
    setLoadingProjects(false);
    const nextProjectId = resolveSelectedProjectId(
      availableProjects,
      activeProjectId ?? selectedProjectId
    );
    if (nextProjectId !== selectedProjectId) {
      setSelectedProjectId(nextProjectId);
    }
  }

  if (activeProjectId && activeProjectId !== selectedProjectId) {
    setSelectedProjectId(activeProjectId);
  }

  useEffect(() => {
    queueMicrotask(() => {
      void loadProjects();
    });
  }, [loadProjects]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  return {
    loadProjects,
    loadingProjects,
    projects,
    selectedProject,
    selectedProjectId,
    setSelectedProjectId: syncSelectedProject
  };
}

export function useProjectTasks(projectId: string | null, workbenchApi: WorkbenchApi) {
  const [tasks, setTasks] = useState<ProjectTaskRecord[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(false);
  const showError = workbenchApi.showError;

  const loadTasks = useCallback(async () => {
    if (!projectId) {
      setTasks([]);
      return [];
    }

    setLoadingTasks(true);
    try {
      const payload = await api.listProjectTasks(projectId);
      setTasks(payload.tasks);
      showError(null);
      return payload.tasks;
    } catch (error) {
      showError(getErrorMessage(error));
      return [];
    } finally {
      setLoadingTasks(false);
    }
  }, [projectId, showError]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadTasks();
    });
  }, [loadTasks]);

  return {
    loadTasks,
    loadingTasks,
    tasks
  };
}

async function requestProjectTextInput(
  workbenchApi: WorkbenchApi,
  options: {
    confirmLabel: string;
    defaultValue?: string;
    description?: string;
    label: string;
    overline: string;
    placeholder?: string;
    title: string;
  }
) {
  const value = await workbenchApi.requestTextInput({
    confirmLabel: options.confirmLabel,
    defaultValue: options.defaultValue,
    description: options.description,
    label: options.label,
    overline: options.overline,
    placeholder: options.placeholder,
    title: options.title
  });

  return value?.trim() || null;
}

export async function promptCreateProject(workbenchApi: PaneComponentProps["api"]) {
  const title = await requestProjectTextInput(workbenchApi, {
    confirmLabel: "Create Project",
    label: "Project Title",
    overline: "Project",
    placeholder: "Project Alpha",
    title: "New Project"
  });
  if (!title) {
    return null;
  }

  workbenchApi.setBusy(`Creating ${title}...`);
  try {
    const payload = await api.createProject({ title });
    storeProjectId(payload.value.id);
    workbenchApi.showError(null);
    return payload;
  } catch (error) {
    workbenchApi.showError(getErrorMessage(error));
    return null;
  } finally {
    workbenchApi.setBusy(null);
  }
}

export async function promptCreateProjectTaskTitle(workbenchApi: PaneComponentProps["api"]) {
  return requestProjectTextInput(workbenchApi, {
    confirmLabel: "Create Task",
    label: "Task Title",
    overline: "Project Task",
    placeholder: "Ship the first draft",
    title: "New Task"
  });
}

export async function promptCreateProjectLogType(workbenchApi: PaneComponentProps["api"]) {
  return requestProjectTextInput(workbenchApi, {
    confirmLabel: "Create Event",
    defaultValue: "note",
    label: "Event Type",
    overline: "Project Log",
    placeholder: "note",
    title: "New Event"
  });
}

export function ProjectLogCreateDialog({
  onCancel,
  onConfirm,
  open,
  tasks
}: {
  onCancel: () => void;
  onConfirm: (value: { taskId: string; type: string }) => void;
  open: boolean;
  tasks: ProjectTaskRecord[];
}) {
  const taskRows = useMemo(
    () =>
      buildProjectTaskRows(tasks, {
        include: (task) => task.status === "todo",
        promoteHiddenParents: true
      }),
    [tasks]
  );
  const [taskId, setTaskId] = useState("");
  const [type, setType] = useState("note");

  const [prevDialogSync, setPrevDialogSync] = useState<{ open: boolean; taskRows: typeof taskRows }>({
    open: false,
    taskRows
  });
  if (prevDialogSync.open !== open || prevDialogSync.taskRows !== taskRows) {
    setPrevDialogSync({ open, taskRows });
    if (open) {
      setTaskId(taskRows[0]?.task.id ?? "");
      setType("note");
    }
  }

  if (!open) {
    return null;
  }

  return (
    <div className="dialog-backdrop" onClick={onCancel} role="presentation">
      <div className="dialog-card text-input-dialog" onClick={(event) => event.stopPropagation()}>
        <p className="title-overline">Project Log</p>
        <h2>New Event</h2>
        <p className="body-muted">Create the log entry with a task selected from the current todo list.</p>
        <label>
          <span>Event Type</span>
          <input value={type} onChange={(event) => setType(event.target.value)} />
        </label>
        <label>
          <span>Task</span>
          <select value={taskId} onChange={(event) => setTaskId(event.target.value)}>
            {taskRows.map((row) => (
              <option key={row.task.id} value={row.task.id}>
                {formatProjectTaskOptionLabel(row.task, row.depth)}
              </option>
            ))}
          </select>
        </label>
        <div className="dialog-actions">
          <button className="action-button ghost" onClick={onCancel} type="button">
            Cancel
          </button>
          <button
            className="action-button primary"
            disabled={!taskId || !type.trim()}
            onClick={() =>
              onConfirm({
                taskId,
                type: type.trim()
              })
            }
            type="button"
          >
            Create Event
          </button>
        </div>
      </div>
    </div>
  );
}
