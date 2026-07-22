import { useCallback, useEffect, useState } from "react";

import { getErrorMessage, type AdminHomeConfig } from "@blog-system/content-core";

import { api } from "../../api";

import { formatProjectDateTime } from "../project-utils";
import {
  addProjectHomeWidget,
  isProjectPinnedToHome,
  notifyProjectHomeWidgetsChanged,
  removeProjectHomeWidget,
  subscribeProjectHomeWidgetsChanged
} from "../project-utils";
import type { PaneComponentProps } from "../types";
import { promptCreateProject, useProjectSelection } from "./project-pane-shared";

export function ProjectOverviewPane({
  activeDocument,
  api: workbenchApi,
  projects: availableProjects
}: PaneComponentProps) {
  const {
    loadProjects,
    loadingProjects,
    projects,
    setSelectedProjectId
  } = useProjectSelection(activeDocument, workbenchApi, availableProjects);
  const [homeConfig, setHomeConfig] = useState<AdminHomeConfig | null>(null);
  const [updatingProjectId, setUpdatingProjectId] = useState<string | null>(null);

  const loadHomeConfig = useCallback(async () => {
    try {
      const payload = await api.getAdminHomeConfig();
      setHomeConfig(payload.value);
      return payload.value;
    } catch {
      setHomeConfig(null);
      return null;
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadHomeConfig();
    });
  }, [loadHomeConfig]);

  useEffect(() => {
    const unsubscribe = subscribeProjectHomeWidgetsChanged((config) => {
      if (config) {
        setHomeConfig(config);
        return;
      }

      void loadHomeConfig();
    });

    return unsubscribe;
  }, [loadHomeConfig]);

  const refresh = async () => {
    await Promise.all([loadProjects(), workbenchApi.refreshWorkspaceData("projects"), loadHomeConfig()]);
  };

  const toggleProjectHome = useCallback(
    async (projectId: string) => {
      setUpdatingProjectId(projectId);
      try {
        const currentConfig = homeConfig ?? (await api.getAdminHomeConfig()).value;
        const nextValue = isProjectPinnedToHome(currentConfig, projectId)
          ? removeProjectHomeWidget(currentConfig, projectId)
          : addProjectHomeWidget(currentConfig, projectId);
        await api.saveAdminHomeConfig(`${JSON.stringify(nextValue, null, 2)}\n`);
        setHomeConfig(nextValue);
        await workbenchApi.refreshWorkspaceData("adminHome");
        notifyProjectHomeWidgetsChanged(nextValue);
        workbenchApi.showError(null);
      } catch (error) {
        workbenchApi.showError(getErrorMessage(error));
      } finally {
        setUpdatingProjectId(null);
      }
    },
    [homeConfig, workbenchApi]
  );

  return (
    <div className="sidebar-scroll">
      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <strong>Project</strong>
          <div className="render-style-actions">
            <button
              className="action-button primary"
              onClick={async () => {
                const payload = await promptCreateProject(workbenchApi);
                if (!payload) {
                  return;
                }

                setSelectedProjectId(payload.value.id);
                await refresh();
                await workbenchApi.openResource({
                  kind: "project",
                  projectId: payload.value.id
                });
                workbenchApi.showSidebarModule("project", "project-overview");
              }}
              type="button"
            >
              New Project
            </button>
            <button className="action-button ghost" onClick={() => void refresh()} type="button">
              Refresh
            </button>
          </div>
        </div>
      </div>
      {loadingProjects ? (
        <div className="sidebar-section">
          <div className="empty-state">Loading projects...</div>
        </div>
      ) : projects.length === 0 ? (
        <div className="sidebar-section">
          <div className="empty-state">Create a project to begin.</div>
        </div>
      ) : (
        projects.map((project) => {
          const isPinned = homeConfig ? isProjectPinnedToHome(homeConfig, project.id) : false;

          return (
            <div className="sidebar-section" key={project.id}>
              <div className="project-summary-card">
                <div className="project-summary-card__header">
                  <strong>{project.title}</strong>
                  <span className="status-pill info">{project.status || "active"}</span>
                </div>
                {project.goal ? <span>{project.goal}</span> : null}
                <div className="project-summary-card__meta">
                  <span>
                    {project.completedTaskCount}/{project.taskCount} tasks completed
                  </span>
                  <span>Updated: {formatProjectDateTime(project.updatedAt)}</span>
                </div>
                <div className="render-style-actions">
                  <button
                    className="action-button ghost"
                    onClick={() => void toggleProjectHome(project.id)}
                    type="button"
                  >
                    {updatingProjectId === project.id
                      ? "Saving..."
                      : isPinned
                        ? "Remove from Home"
                        : "Add to Home"}
                  </button>
                  <button
                    className="action-button accent"
                    onClick={() => {
                      setSelectedProjectId(project.id);
                      void workbenchApi.openResource({
                        kind: "project",
                        projectId: project.id
                      });
                    }}
                    type="button"
                  >
                    Open Overview
                  </button>
                </div>
              </div>
            </div>
          );
        })
      )}
    </div>
  );
}
