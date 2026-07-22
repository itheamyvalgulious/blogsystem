import type { Dispatch, ReactNode, RefObject, SetStateAction } from "react";

import type { AdminHomeConfig, ArticleSummary } from "@blog-system/content-core";
import { ActivityIcon } from "../components/ActivityIcon";
import {
  closeDocument,
  getDocumentPath,
  HOME_DOCUMENT_ID
} from "./document-builders";
import type { SidebarModuleItem, SidebarPaneItem } from "./sidebar";
import type {
  EditorContributionDefinition,
  HomeWidgetContributionDefinition,
  PaneGroupId,
  WorkbenchApi,
  WorkbenchDocument,
  WorkbenchEditorComponentProps
} from "./types";

interface ActivityBarProps {
  groupedPanes: Record<string, SidebarPaneItem[]>;
  openPalette: (mode: "commands" | "editors" | "themeGroupCreate" | "themes") => void;
  setActivePaneByGroup: Dispatch<SetStateAction<Record<string, string>>>;
  setSidebarGroupId: Dispatch<SetStateAction<PaneGroupId>>;
  setSidebarVisible: Dispatch<SetStateAction<boolean>>;
  sidebarGroupId: PaneGroupId;
  sidebarModules: SidebarModuleItem[];
  sidebarVisible: boolean;
}

export function ActivityBar({
  groupedPanes,
  openPalette,
  setActivePaneByGroup,
  setSidebarGroupId,
  setSidebarVisible,
  sidebarGroupId,
  sidebarModules,
  sidebarVisible
}: ActivityBarProps) {
  return (
    <div className="activity-bar">
      <div className="activity-brand">KB</div>
      {sidebarModules.map((group) => (
        <button
          aria-label={group.title}
          className={`activity-button ${sidebarVisible && sidebarGroupId === group.id ? "is-active" : ""}`}
          key={group.id}
          onClick={() => {
            setSidebarGroupId(group.id);
            setActivePaneByGroup((current) =>
              current[group.id]
                ? current
                : {
                    ...current,
                    [group.id]: groupedPanes[group.id]?.[0]?.paneId ?? ""
                  }
            );
            setSidebarVisible((current) => (sidebarGroupId === group.id ? !current : true));
          }}
          title={group.title}
          type="button"
        >
          <ActivityIcon icon={group.icon} />
        </button>
      ))}
      <button
        aria-label="Command Palette"
        className="activity-button bottom"
        onClick={() => openPalette("commands")}
        title="Command Palette"
        type="button"
      >
        <ActivityIcon icon="command" />
      </button>
    </div>
  );
}

interface SidebarPanelProps {
  activeGroupPanes: SidebarPaneItem[];
  activePaneId: string | null;
  children: ReactNode;
  setActivePaneByGroup: Dispatch<SetStateAction<Record<string, string>>>;
  sidebarGroupId: PaneGroupId;
  sidebarVisible: boolean;
  sidebarWidth: number;
}

export function SidebarPanel({
  activeGroupPanes,
  activePaneId,
  children,
  setActivePaneByGroup,
  sidebarGroupId,
  sidebarVisible,
  sidebarWidth
}: SidebarPanelProps) {
  return (
    <aside
      className={`sidebar-panel ${sidebarVisible ? "" : "is-collapsed"}`}
      style={sidebarVisible ? { minWidth: `${sidebarWidth}px`, width: `${sidebarWidth}px` } : undefined}
    >
      {sidebarVisible ? (
        <div className="sidebar-host">
          <div className="sidebar-pane-tabs">
            {activeGroupPanes.map((pane) => (
              <button
                className={`sidebar-pane-tab ${pane.paneId === activePaneId ? "is-active" : ""}`}
                key={`${sidebarGroupId}:${pane.paneId}`}
                onClick={() =>
                  setActivePaneByGroup((current) => ({
                    ...current,
                    [sidebarGroupId]: pane.paneId
                  }))
                }
                title={pane.title}
                type="button"
              >
                {pane.tabLabel}
              </button>
            ))}
          </div>
          {children}
        </div>
      ) : null}
    </aside>
  );
}

interface EditorTabBarProps {
  activateDocument: (nextDocumentIdOrUpdater: SetStateAction<string | null>) => void;
  activeDocumentId: string | null;
  documents: WorkbenchDocument[];
  setDocuments: Dispatch<SetStateAction<WorkbenchDocument[]>>;
}

export function EditorTabBar({
  activateDocument,
  activeDocumentId,
  documents,
  setDocuments
}: EditorTabBarProps) {
  return (
    <div className="tab-bar">
      {documents.map((document) => (
        <button
          className={`tab-button ${document.id === activeDocumentId ? "is-active" : ""}`}
          key={document.id}
          onClick={() => activateDocument(document.id)}
          type="button"
        >
          <span>{document.title}</span>
          {document.dirty ? <span className="dirty-dot">*</span> : null}
          {document.kind !== "home" ? (
            <span
              className="tab-close"
              onClick={(event) => {
                event.stopPropagation();
                const nextDocuments = closeDocument(documents, document.id);
                setDocuments(nextDocuments);
                if (activeDocumentId === document.id) {
                  const closedIndex = documents.findIndex((candidate) => candidate.id === document.id);
                  activateDocument(nextDocuments[Math.max(0, closedIndex - 1)]?.id ?? HOME_DOCUMENT_ID);
                }
              }}
              role="presentation"
            >
              x
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

interface EditorSurfaceProps {
  activeDocument: WorkbenchDocument | null;
  activeEditorContribution: EditorContributionDefinition | null;
  adminHomeValue: AdminHomeConfig | null;
  articleSummaries: ArticleSummary[];
  getRenderDraftValue: (document: WorkbenchDocument) => string;
  homeWidgetContributions: HomeWidgetContributionDefinition[];
  onChange: WorkbenchEditorComponentProps["onChange"];
  onChangeHomeConfig: WorkbenchEditorComponentProps["onChangeHomeConfig"];
  onModelContentChange: WorkbenchEditorComponentProps["onModelContentChange"];
  onMount: WorkbenchEditorComponentProps["onMount"];
  workbenchApi: WorkbenchApi;
}

export function EditorSurface({
  activeDocument,
  activeEditorContribution,
  adminHomeValue,
  articleSummaries,
  getRenderDraftValue,
  homeWidgetContributions,
  onChange,
  onChangeHomeConfig,
  onModelContentChange,
  onMount,
  workbenchApi
}: EditorSurfaceProps) {
  const ActiveEditorComponent = activeEditorContribution?.component ?? null;

  return (
    <div className="editor-surface">
      {activeDocument ? (
        ActiveEditorComponent ? (
          <ActiveEditorComponent
            api={workbenchApi}
            adminHomeValue={adminHomeValue}
            articleSummaries={articleSummaries}
            document={activeDocument}
            homeWidgets={homeWidgetContributions}
            onChange={onChange}
            onChangeHomeConfig={onChangeHomeConfig}
            onModelContentChange={onModelContentChange}
            onMount={onMount}
            path={getDocumentPath(activeDocument, null)}
            value={getRenderDraftValue(activeDocument)}
          />
        ) : (
          <div className="empty-editor">No editor is available for this document.</div>
        )
      ) : (
        <div className="empty-editor">Open an article or config document.</div>
      )}
    </div>
  );
}

interface PreviewPaneProps {
  attachPreviewRef: RefObject<HTMLDivElement | null> | ((node: HTMLDivElement | null) => void);
  attachPreviewSurfaceRef: RefObject<HTMLDivElement | null> | ((node: HTMLDivElement | null) => void);
  setPreviewRenderDialogOpen: Dispatch<SetStateAction<boolean>>;
  startResize: (mode: "sidebar" | "preview", startClientX: number) => void;
}

export function PreviewPane({
  attachPreviewRef,
  attachPreviewSurfaceRef,
  setPreviewRenderDialogOpen,
  startResize
}: PreviewPaneProps) {
  return (
    <>
      <div
        className="panel-resizer vertical"
        onPointerDown={(event) => startResize("preview", event.clientX)}
        role="presentation"
      />
      <aside className="preview-group">
        <button
          className="action-button ghost preview-float-button"
          onClick={() => setPreviewRenderDialogOpen(true)}
          type="button"
        >
          Theme Preview
        </button>
        <div className="preview-scroll" ref={attachPreviewRef}>
          <div className="preview-shadow-host" ref={attachPreviewSurfaceRef} />
        </div>
      </aside>
    </>
  );
}
