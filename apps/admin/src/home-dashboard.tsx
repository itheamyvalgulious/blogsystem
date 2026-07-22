import { useCallback, useEffect, useMemo, useState } from "react";

import { getErrorMessage, type AdminHomeConfig, type ProjectSummary, type ProjectTaskRecord } from "@blog-system/content-core";

import { api } from "./api";
import {
  formatProjectDate,
  getProjectHomeWidgetProjectId,
  notifyProjectHomeWidgetsChanged,
  removeProjectHomeWidget
} from "./workbench/project-utils";
import { buildProjectTaskRows } from "./workbench/project-task-utils";

import type { HomeWidgetContributionDefinition, WorkbenchApi } from "./workbench/types";

interface HomeDashboardProps {
  workbenchApi: WorkbenchApi;
  value: AdminHomeConfig;
  widgets: HomeWidgetContributionDefinition[];
  onChange: (nextValue: AdminHomeConfig) => void;
}

interface ProjectHomeWidgetData {
  error: string | null;
  loading: boolean;
  project: ProjectSummary | null;
  tasks: ProjectTaskRecord[];
}

type ResolvedHomeWidget =
  | { kind: "plugin"; widget: HomeWidgetContributionDefinition }
  | { kind: "project"; projectId: string; widgetId: string };

function resolveOrderedWidgets(
  value: AdminHomeConfig,
  widgets: HomeWidgetContributionDefinition[]
): ResolvedHomeWidget[] {
  const availableWidgets = new Map(widgets.map((widget) => [widget.widgetId, widget]));
  const availableIds = new Set(availableWidgets.keys());
  const orderedIds = [
    ...value.widgetOrder.filter((widgetId, index, entries) => {
      if (entries.indexOf(widgetId) !== index) {
        return false;
      }

      return (
        availableIds.has(widgetId) ||
        getProjectHomeWidgetProjectId(widgetId, value.widgets[widgetId]) !== null
      );
    }),
    ...widgets.map((widget) => widget.widgetId).filter((widgetId) => !value.widgetOrder.includes(widgetId))
  ];

  return orderedIds
    .map((widgetId) => {
      const pluginWidget = availableWidgets.get(widgetId);
      if (pluginWidget) {
        return {
          kind: "plugin" as const,
          widget: pluginWidget
        };
      }

      const projectId = getProjectHomeWidgetProjectId(widgetId, value.widgets[widgetId]);
      if (!projectId) {
        return null;
      }

      return {
        kind: "project" as const,
        projectId,
        widgetId
      };
    })
    .filter((widget): widget is ResolvedHomeWidget => Boolean(widget));
}

function reorderWidgetIds(widgetIds: string[], sourceId: string, targetId: string) {
  if (sourceId === targetId) {
    return widgetIds;
  }

  const nextIds = [...widgetIds];
  const sourceIndex = nextIds.indexOf(sourceId);
  const targetIndex = nextIds.indexOf(targetId);

  if (sourceIndex === -1 || targetIndex === -1) {
    return widgetIds;
  }

  const [removed] = nextIds.splice(sourceIndex, 1);
  nextIds.splice(targetIndex, 0, removed);
  return nextIds;
}

export function HomeDashboard({ onChange, value, widgets, workbenchApi }: HomeDashboardProps) {
  const orderedWidgets = useMemo(() => resolveOrderedWidgets(value, widgets), [value, widgets]);
  const projectWidgets = useMemo(
    () => orderedWidgets.filter((widget): widget is Extract<ResolvedHomeWidget, { kind: "project" }> => widget.kind === "project"),
    [orderedWidgets]
  );
  const [projectWidgetData, setProjectWidgetData] = useState<Record<string, ProjectHomeWidgetData>>({});

  const loadProjectWidgets = useCallback(async () => {
    const projectIds = Array.from(new Set(projectWidgets.map((widget) => widget.projectId)));
    if (projectIds.length === 0) {
      setProjectWidgetData({});
      return;
    }

    setProjectWidgetData((current) =>
      Object.fromEntries(
        projectIds.map((projectId) => [
          projectId,
          {
            error: null,
            loading: true,
            project: current[projectId]?.project ?? null,
            tasks: current[projectId]?.tasks ?? []
          }
        ])
      )
    );

    const entries = await Promise.all(
      projectIds.map(async (projectId) => {
        try {
          const [projectPayload, taskPayload] = await Promise.all([
            api.getProject(projectId),
            api.listProjectTasks(projectId)
          ]);
          return [
            projectId,
            {
              error: null,
              loading: false,
              project: projectPayload.value,
              tasks: taskPayload.tasks
            }
          ] satisfies [string, ProjectHomeWidgetData];
        } catch (error) {
          return [
            projectId,
            {
              error: getErrorMessage(error),
              loading: false,
              project: null,
              tasks: []
            }
          ] satisfies [string, ProjectHomeWidgetData];
        }
      })
    );

    setProjectWidgetData(Object.fromEntries(entries));
  }, [projectWidgets]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadProjectWidgets();
    });
  }, [loadProjectWidgets]);

  if (orderedWidgets.length === 0) {
    return (
      <div className="home-dashboard home-dashboard--empty">
        <section className="home-intro-card">
          <p className="title-overline">Admin Home</p>
          <h1>No home widgets are enabled.</h1>
          <p className="body-muted">Add a project from its overview to pin a live task pane here.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="home-dashboard">
      <section className="home-intro-card">
        <p className="title-overline">Admin Home</p>
        <h1>Workbench dashboard</h1>
        <p className="body-muted">Drag cards to reorder your home layout. Pinned project panes show live tasks with `todo` status.</p>
        <div className="render-style-actions">
          <button className="action-button ghost" onClick={() => void loadProjectWidgets()} type="button">
            Refresh Projects
          </button>
        </div>
      </section>
      <div className="home-widget-grid">
        {orderedWidgets.map((widget) => {
          const widgetId = widget.kind === "plugin" ? widget.widget.widgetId : widget.widgetId;
          const PluginWidgetComponent = widget.kind === "plugin" ? widget.widget.component : null;
          return (
            <article
              className="home-widget-card"
              draggable
              key={widgetId}
              onDragOver={(event) => event.preventDefault()}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", widgetId);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const sourceId = event.dataTransfer.getData("text/plain");
                if (!sourceId) {
                  return;
                }

                onChange({
                  ...value,
                  widgetOrder: reorderWidgetIds(
                    orderedWidgets.map((entry) => (entry.kind === "plugin" ? entry.widget.widgetId : entry.widgetId)),
                    sourceId,
                    widgetId
                  )
                });
              }}
            >
              {widget.kind === "plugin" ? (
                <>
                  <div className="home-widget-card__header">
                    <div>
                      <p className="home-widget-card__eyebrow">Plugin widget</p>
                      <h2>{widget.widget.label}</h2>
                    </div>
                    <span className="home-widget-card__drag" aria-hidden="true">
                      ::
                    </span>
                  </div>
                  {PluginWidgetComponent ? (
                    <PluginWidgetComponent
                      setState={(nextState) =>
                        onChange({
                          ...value,
                          widgets: {
                            ...value.widgets,
                            [widget.widget.widgetId]: nextState
                          }
                        })
                      }
                      state={value.widgets[widget.widget.widgetId]}
                      widgetId={widget.widget.widgetId}
                    />
                  ) : null}
                </>
              ) : (
                (() => {
                  const widgetData = projectWidgetData[widget.projectId];
                  const project = widgetData?.project;
                  const tasks = widgetData?.tasks ?? [];
                  const taskRows = buildProjectTaskRows(tasks, {
                    include: (task) => task.status === "todo",
                    promoteHiddenParents: true
                  });
                  const isLoading = widgetData?.loading ?? true;
                  const errorMessage = widgetData?.error;

                  return (
                    <>
                      <div className="home-widget-card__header">
                        <div>
                          <p className="home-widget-card__eyebrow">Pinned project</p>
                          <h2>{project?.title ?? widget.projectId}</h2>
                        </div>
                        <span className="home-widget-card__drag" aria-hidden="true">
                          ::
                        </span>
                      </div>
                      <div className="home-project-widget">
                        <div className="project-list-item__row">
                          <span className="body-muted">Project overview</span>
                          {project ? <span className="status-pill info">{project.status}</span> : null}
                        </div>
                        {isLoading ? (
                          <p className="body-muted">Loading tasks...</p>
                        ) : errorMessage ? (
                          <p className="body-muted">{errorMessage}</p>
                        ) : taskRows.length === 0 ? (
                          <p className="body-muted">No todo tasks.</p>
                        ) : (
                          <div className="home-project-widget__tasks">
                            {taskRows.map((row) => (
                              <button
                                className="home-project-widget__task"
                                key={row.task.id}
                                onClick={() =>
                                  void workbenchApi.openResource({
                                    kind: "projectTask",
                                    projectId: widget.projectId,
                                    taskId: row.task.id
                                  })
                                }
                                style={{ paddingLeft: `${12 + row.depth * 16}px` }}
                                type="button"
                              >
                                <strong>{row.task.title}</strong>
                                <span>
                                  {row.task.dueDate
                                    ? `Due ${formatProjectDate(row.task.dueDate)}`
                                    : row.task.excerpt || "Open task"}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                        <div className="render-style-actions">
                          <button
                            className="action-button ghost"
                            onClick={() =>
                              void workbenchApi.openResource({
                                kind: "project",
                                projectId: widget.projectId
                              })
                            }
                            type="button"
                          >
                            Open Project
                          </button>
                          <button
                            className="action-button ghost"
                            onClick={() => {
                              const nextValue = removeProjectHomeWidget(value, widget.projectId);
                              onChange(nextValue);
                              notifyProjectHomeWidgetsChanged(nextValue);
                            }}
                            type="button"
                          >
                            Remove
                          </button>
                        </div>
                      </div>
                    </>
                  );
                })()
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
