import { useMemo, useState } from "react";

import { getErrorMessage } from "@blog-system/content-core";

import type {
  GlobalMarkdownSearchFileResult,
  GlobalMarkdownSearchMatch,
  GlobalMarkdownSearchScope
} from "../../api";

import type { PaneComponentProps } from "../types";

function flattenMatches(results: GlobalMarkdownSearchFileResult[]) {
  return results.flatMap((file) => file.matches);
}

function findSelectedMatch(
  results: GlobalMarkdownSearchFileResult[],
  selectedKey: string | null
) {
  if (!selectedKey) {
    return null;
  }

  for (const file of results) {
    const match = file.matches.find((item) => item.key === selectedKey);
    if (match) {
      return match;
    }
  }

  return null;
}

function getMatchLabel(match: GlobalMarkdownSearchMatch) {
  return `L${match.lineNumber}:C${match.column}`;
}

export function GlobalSearchReplacePane({
  activeDocument,
  api: workbenchApi
}: PaneComponentProps) {
  const [pattern, setPattern] = useState("");
  const [replace, setReplace] = useState("");
  const [flags, setFlags] = useState("");
  const [scope, setScope] = useState<GlobalMarkdownSearchScope>("body");
  const [results, setResults] = useState<GlobalMarkdownSearchFileResult[]>([]);
  const [summary, setSummary] = useState<{
    filesMatched: number;
    filesScanned: number;
    matchesFound: number;
    skippedCount: number;
  } | null>(null);
  const [skipped, setSkipped] = useState<Array<{ path: string; reason: string }>>([]);
  const [selectedMatchKey, setSelectedMatchKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const hasDirtyArticle = workbenchApi.hasDirtyArticleDocument();
  const flatMatches = useMemo(() => flattenMatches(results), [results]);
  const selectedMatch = useMemo(
    () => findSelectedMatch(results, selectedMatchKey) ?? flatMatches[0] ?? null,
    [flatMatches, results, selectedMatchKey]
  );

  if (!selectedMatch && selectedMatchKey !== null) {
    setSelectedMatchKey(null);
  } else if (selectedMatch && selectedMatch.key !== selectedMatchKey) {
    setSelectedMatchKey(selectedMatch.key);
  }

  const applyResponse = useMemo(
    () => (response: Awaited<ReturnType<typeof workbenchApi.previewGlobalMarkdownSearch>>) => {
      setResults(response.results);
      setSummary(response.summary);
      setSkipped(response.skipped);
      setSelectedMatchKey(response.applied?.nextSelectionKey ?? response.results[0]?.matches[0]?.key ?? null);
    },
    []
  );

  const runPreview = async () => {
    setBusy(true);
    workbenchApi.setBusy("Searching markdown...");
    try {
      const response = await workbenchApi.previewGlobalMarkdownSearch({
        flags,
        pattern,
        replace,
        scope
      });
      applyResponse(response);
      workbenchApi.showError(null);
    } catch (error) {
      workbenchApi.showError(getErrorMessage(error));
    } finally {
      workbenchApi.setBusy(null);
      setBusy(false);
    }
  };

  const runReplaceNext = async () => {
    if (!selectedMatchKey || hasDirtyArticle) {
      return;
    }

    setBusy(true);
    workbenchApi.setBusy("Replacing next match...");
    try {
      const response = await workbenchApi.replaceNextGlobalMarkdownMatch({
        flags,
        matchKey: selectedMatchKey,
        pattern,
        replace,
        scope
      });
      applyResponse(response);
      workbenchApi.showError(null);
    } catch (error) {
      workbenchApi.showError(getErrorMessage(error));
    } finally {
      workbenchApi.setBusy(null);
      setBusy(false);
    }
  };

  const runReplaceAll = async () => {
    if (hasDirtyArticle) {
      return;
    }

    setBusy(true);
    workbenchApi.setBusy("Replacing all matches...");
    try {
      const response = await workbenchApi.replaceAllGlobalMarkdownMatches({
        flags,
        pattern,
        replace,
        scope
      });
      applyResponse(response);
      workbenchApi.showError(null);
    } catch (error) {
      workbenchApi.showError(getErrorMessage(error));
    } finally {
      workbenchApi.setBusy(null);
      setBusy(false);
    }
  };

  return (
    <div className="sidebar-scroll">
      <div className="sidebar-section search-pane">
        <strong>Global Markdown Search</strong>
        <span className="body-muted">Search and replace across all markdown files under `content`.</span>
        <label>
          <span>Find</span>
          <input
            onChange={(event) => setPattern(event.target.value)}
            placeholder="Regex pattern"
            value={pattern}
          />
        </label>
        <label>
          <span>Replace</span>
          <input
            onChange={(event) => setReplace(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void runReplaceNext();
              }
            }}
            placeholder="Replacement, supports $1"
            value={replace}
          />
        </label>
        <div className="search-pane__row">
          <label>
            <span>Flags</span>
            <input onChange={(event) => setFlags(event.target.value)} placeholder="i m s u" value={flags} />
          </label>
          <label>
            <span>Scope</span>
            <select
              onChange={(event) => setScope(event.target.value as GlobalMarkdownSearchScope)}
              value={scope}
            >
              <option value="body">Body</option>
              <option value="wholeFile">Whole File</option>
            </select>
          </label>
        </div>
        <div className="render-style-actions">
          <button className="action-button ghost" disabled={busy} onClick={() => void runPreview()} type="button">
            Preview
          </button>
          <button
            className="action-button primary"
            disabled={busy || hasDirtyArticle || !selectedMatchKey}
            onClick={() => void runReplaceNext()}
            type="button"
          >
            Replace Next
          </button>
          <button
            className="action-button accent"
            disabled={busy || hasDirtyArticle || flatMatches.length === 0}
            onClick={() => void runReplaceAll()}
            type="button"
          >
            Replace All
          </button>
        </div>
        {hasDirtyArticle ? (
          <span className="status-pill warning">Save or close unsaved markdown drafts before replacing.</span>
        ) : null}
        {summary ? (
          <div className="search-pane__summary">
            <span className="status-pill info">{summary.matchesFound} matches</span>
            <span className="status-pill info">{summary.filesMatched} files</span>
            <span className="status-pill info">{summary.filesScanned} scanned</span>
            {summary.skippedCount > 0 ? (
              <span className="status-pill warning">{summary.skippedCount} skipped</span>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="sidebar-section search-pane__results">
        {results.length === 0 ? (
          <div className="empty-state">
            {pattern.length === 0 ? "Enter a regex pattern to search." : "No matches found."}
          </div>
        ) : (
          results.map((file) => (
            <div className="search-pane__file" key={file.path}>
              <div className="search-pane__file-header">
                <strong>{file.path}</strong>
                <span className="status-pill info">{file.matchCount}</span>
              </div>
              <div className="search-pane__match-list">
                {file.matches.map((match) => (
                  <button
                    className={`search-pane__match ${selectedMatch?.key === match.key ? "is-active" : ""}`}
                    key={match.key}
                    onClick={() => {
                      setSelectedMatchKey(match.key);
                      void workbenchApi.openResource({
                        articlePath: match.path,
                        kind: "article",
                        lineNumber: match.lineNumber
                      });
                    }}
                    type="button"
                  >
                    <div className="search-pane__match-meta">
                      <span>{getMatchLabel(match)}</span>
                      <span>{match.matchedText}</span>
                    </div>
                    <strong>{match.excerpt}</strong>
                    <span className="body-muted">{match.replacementPreview}</span>
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
        {skipped.length > 0 ? (
          <div className="search-pane__skipped">
            <strong>Skipped</strong>
            {skipped.map((entry) => (
              <div className="search-pane__skipped-item" key={`${entry.path}:${entry.reason}`}>
                <span>{entry.path}</span>
                <span className="body-muted">{entry.reason}</span>
              </div>
            ))}
          </div>
        ) : null}
        {activeDocument?.kind === "article" ? (
          <div className="body-muted search-pane__hint">
            Active article: {activeDocument.articlePath}
          </div>
        ) : null}
      </div>
    </div>
  );
}
