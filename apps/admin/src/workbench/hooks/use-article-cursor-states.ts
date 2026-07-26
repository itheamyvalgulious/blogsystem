import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { WorkbenchEditorHandle } from "../editor-engine";

import {
  ARTICLE_CURSOR_STATE_STORAGE_KEY,
  loadStoredArticleCursorStates,
  remapArticleCursorStates,
  removeArticleCursorStates,
  type StoredArticleCursorState
} from "../article-cursor-state";

interface ArticleCursorStatesOptions {
  editorRef: RefObject<WorkbenchEditorHandle | null>;
  setActiveArticleLineNumber: Dispatch<SetStateAction<number | null>>;
}

export function useArticleCursorStates({ editorRef, setActiveArticleLineNumber }: ArticleCursorStatesOptions) {
  const [initialArticleCursorStates] = useState(loadStoredArticleCursorStates);
  const articleCursorPersistTimerRef = useRef<number | null>(null);
  const articleCursorStatesRef = useRef<Record<string, StoredArticleCursorState>>(initialArticleCursorStates);
  const lastStoredArticleLineNumberRef = useRef<number | null>(null);

  const flushArticleCursorStates = useCallback(() => {
    try {
      window.localStorage.setItem(
        ARTICLE_CURSOR_STATE_STORAGE_KEY,
        JSON.stringify(articleCursorStatesRef.current)
      );
    } catch {
      // Ignore storage failures and keep the in-memory cursor state.
    }
  }, []);

  const scheduleArticleCursorStatePersist = useCallback(() => {
    if (articleCursorPersistTimerRef.current !== null) {
      return;
    }

    articleCursorPersistTimerRef.current = window.setTimeout(() => {
      articleCursorPersistTimerRef.current = null;
      flushArticleCursorStates();
    }, 120);
  }, [flushArticleCursorStates]);

  const storeArticleCursorState = useCallback(
    (articlePath: string) => {
      const editor = editorRef.current;
      const model = editor?.getModel();
      const position = editor?.getPosition();

      if (!editor || !model || !position) {
        return;
      }

      const lineNumber = Math.max(1, Math.min(position.lineNumber, model.getLineCount()));
      const maxColumn = model.getLineMaxColumn(lineNumber);
      const column = Math.max(1, Math.min(position.column, maxColumn));

      articleCursorStatesRef.current[articlePath] = {
        lineNumber,
        column,
        scrollTop: editor.getScrollTop(),
        scrollLeft: editor.getScrollLeft()
      };
      if (lastStoredArticleLineNumberRef.current !== lineNumber) {
        lastStoredArticleLineNumberRef.current = lineNumber;
        setActiveArticleLineNumber(lineNumber);
      }
      scheduleArticleCursorStatePersist();
    },
    [scheduleArticleCursorStatePersist]
  );

  const remapStoredArticleCursorStates = useCallback(
    (fromPath: string, toPath: string) => {
      articleCursorStatesRef.current = remapArticleCursorStates(
        articleCursorStatesRef.current,
        fromPath,
        toPath
      );
      scheduleArticleCursorStatePersist();
    },
    [scheduleArticleCursorStatePersist]
  );

  const discardStoredArticleCursorStates = useCallback(
    (targetPath: string) => {
      articleCursorStatesRef.current = removeArticleCursorStates(
        articleCursorStatesRef.current,
        targetPath
      );
      scheduleArticleCursorStatePersist();
    },
    [scheduleArticleCursorStatePersist]
  );

  return {
    articleCursorPersistTimerRef,
    articleCursorStatesRef,
    discardStoredArticleCursorStates,
    flushArticleCursorStates,
    lastStoredArticleLineNumberRef,
    remapStoredArticleCursorStates,
    storeArticleCursorState
  };
}
