import { useEffect, useMemo, useState } from "react";

import { getErrorMessage } from "@blog-system/content-core";

import {
  api,
  type GitChangedFilePayload,
  type GitCommitPayload
} from "../../api";

import type { PaneComponentProps } from "../types";

const GIT_REFRESH_INTERVAL_MS = 15000;

export function GitPane({ api: workbenchApi }: PaneComponentProps) {
  const [changedFiles, setChangedFiles] = useState<GitChangedFilePayload[]>([]);
  const [commits, setCommits] = useState<GitCommitPayload[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [commitMessage, setCommitMessage] = useState("Update content and assets");
  const [refreshing, setRefreshing] = useState(false);
  const [actionBusy, setActionBusy] = useState<null | "commit" | "init" | "push">(null);

  const loadGitData = async (options?: { quiet?: boolean }) => {
    if (!options?.quiet) {
      setRefreshing(true);
    }

    try {
      const [statusPayload, historyPayload] = await Promise.all([
        api.getGitStatus(),
        api.getGitHistory()
      ]);
      setChangedFiles(statusPayload.files);
      setCommits(historyPayload.commits);
      setInitialized(statusPayload.initialized && historyPayload.initialized);
      workbenchApi.showError(null);
    } catch (error) {
      workbenchApi.showError(getErrorMessage(error));
    } finally {
      if (!options?.quiet) {
        setRefreshing(false);
      }
    }
  };

  useEffect(() => {
    queueMicrotask(() => {
      void loadGitData();
    });

    const intervalId = window.setInterval(() => {
      void loadGitData({ quiet: true });
    }, GIT_REFRESH_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  const hasPendingChanges = changedFiles.length > 0;
  const primaryAction = hasPendingChanges ? "commit" : "push";
  const primaryLabel = useMemo(() => {
    if (actionBusy === "commit") {
      return "Committing...";
    }

    if (actionBusy === "push") {
      return "Pushing...";
    }

    return primaryAction === "push" ? "Push" : "Commit";
  }, [actionBusy, primaryAction]);

  const runAction = async <T,>(action: "commit" | "init" | "push", message: string, task: () => Promise<T>) => {
    setActionBusy(action);
    workbenchApi.setBusy(message);
    try {
      await task();
      await loadGitData();
      workbenchApi.showError(null);
    } catch (error) {
      workbenchApi.showError(getErrorMessage(error));
    } finally {
      setActionBusy(null);
      workbenchApi.setBusy(null);
    }
  };

  return (
    <div className="sidebar-scroll">
      <div className="sidebar-section">
        <label>
          <span>{hasPendingChanges ? "Commit Message" : "Commit Message (unused for push)"}</span>
          <input
            disabled={!hasPendingChanges || actionBusy !== null}
            value={commitMessage}
            onChange={(event) => setCommitMessage(event.target.value)}
          />
        </label>
        <button
          className="action-button ghost"
          disabled={refreshing || actionBusy !== null}
          onClick={() => {
            void loadGitData();
          }}
          type="button"
        >
          {refreshing ? "Refreshing..." : "Refresh Git Changes"}
        </button>
        {!initialized ? (
          <button
            className="action-button ghost"
            disabled={actionBusy !== null}
            onClick={() => {
              void runAction("init", "Initializing git repository...", () => api.initGitRepository());
            }}
            type="button"
          >
            Init Repository
          </button>
        ) : null}
        <button
          className="action-button primary"
          disabled={!initialized || actionBusy !== null}
          onClick={() => {
            if (primaryAction === "push") {
              void runAction("push", "Pushing git commits to remote...", () => api.pushGitChanges());
              return;
            }

            void runAction("commit", "Creating commit...", () => api.createGitCommit(commitMessage));
          }}
          type="button"
        >
          {primaryLabel}
        </button>
      </div>
      <div className="sidebar-section search-results">
        <strong>Changed Files</strong>
        {changedFiles.length === 0 ? (
          <div className="empty-state">No pending changes.</div>
        ) : (
          changedFiles.map((file) => (
            <div className="search-result" key={`${file.status}:${file.path}`}>
              <strong>{file.status}</strong>
              <span>{file.path}</span>
            </div>
          ))
        )}
      </div>
      <div className="sidebar-section search-results">
        <strong>History</strong>
        {commits.length === 0 ? (
          <div className="empty-state">No commits.</div>
        ) : (
          commits.map((commit) => (
            <div className="search-result" key={commit.hash}>
              <strong>{commit.message}</strong>
              <span>{commit.hash.slice(0, 7)} | {commit.timestamp}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
