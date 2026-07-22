import { matchesPathPrefix, replacePathPrefix } from "./path-utils";

export const ARTICLE_CURSOR_STATE_STORAGE_KEY = "admin-article-cursor-state";

export interface StoredArticleCursorState {
  lineNumber: number;
  column: number;
  scrollLeft: number;
  scrollTop: number;
}

export function loadStoredArticleCursorStates() {
  try {
    const rawValue = window.localStorage.getItem(ARTICLE_CURSOR_STATE_STORAGE_KEY);
    if (!rawValue) {
      return {};
    }

    const parsed = JSON.parse(rawValue) as Record<string, Partial<StoredArticleCursorState>>;
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([articlePath, value]) =>
        typeof articlePath === "string" &&
        value &&
        Number.isFinite(value.lineNumber) &&
        Number.isFinite(value.column) &&
        Number.isFinite(value.scrollTop) &&
        Number.isFinite(value.scrollLeft)
          ? [
              [
                articlePath,
                {
                  lineNumber: Number(value.lineNumber),
                  column: Number(value.column),
                  scrollTop: Number(value.scrollTop),
                  scrollLeft: Number(value.scrollLeft)
                } satisfies StoredArticleCursorState
              ]
            ]
          : []
      )
    ) as Record<string, StoredArticleCursorState>;
  } catch {
    return {};
  }
}

export function remapArticleCursorStates(
  states: Record<string, StoredArticleCursorState>,
  fromPath: string,
  toPath: string
) {
  return Object.fromEntries(
    Object.entries(states).map(([articlePath, value]) => [replacePathPrefix(articlePath, fromPath, toPath), value])
  );
}

export function removeArticleCursorStates(states: Record<string, StoredArticleCursorState>, targetPath: string) {
  return Object.fromEntries(
    Object.entries(states).filter(([articlePath]) => !matchesPathPrefix(articlePath, targetPath))
  );
}
