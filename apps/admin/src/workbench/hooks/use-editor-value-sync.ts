import { useCallback, type RefObject } from "react";

import type { EditorEngineServices, WorkbenchEditorHandle } from "../editor-engine";

export function useEditorValueSync(
  editorRef: RefObject<WorkbenchEditorHandle | null>,
  editorServicesRef: RefObject<EditorEngineServices | null>
) {
  /**
   * Full-document replacement that preserves scroll position. The
   * replacement is performed as a single executeEdits range-replacement.
   * Kernel scroll corrections (scroll anchoring, selection-driven scrolling)
   * that fire one or two frames after the dispatch are re-asserted over two
   * requestAnimationFrame callbacks to keep the replacement scroll-neutral.
   */
  const syncEditorValuePreservingView = useCallback((nextValue: string) => {
    const editor = editorRef.current;
    const services = editorServicesRef.current;
    const model = editor?.getModel();

    if (!editor || !services || !model || model.getValue() === nextValue) {
      return;
    }

    const selectionOffsets = (editor.getSelections() ?? []).map((selection) => ({
      selectionStartOffset: model.getOffsetAt({
        lineNumber: selection.selectionStartLineNumber,
        column: selection.selectionStartColumn
      }),
      positionOffset: model.getOffsetAt(selection.getPosition())
    }));
    const scrollTop = editor.getScrollTop();
    const scrollLeft = editor.getScrollLeft();
    const fullRange = model.getFullModelRange();

    editor.pushUndoStop();
    editor.executeEdits("workbench-sync-value", [
      {
        forceMoveMarkers: true,
        range: fullRange,
        text: nextValue
      }
    ]);
    editor.pushUndoStop();

    const nextModel = editor.getModel();

    if (nextModel && selectionOffsets.length > 0) {
      editor.setSelections(
        selectionOffsets.map(({ selectionStartOffset, positionOffset }) => {
          const nextSelectionStart = nextModel.getPositionAt(
            Math.min(selectionStartOffset, nextValue.length)
          );
          const nextPosition = nextModel.getPositionAt(Math.min(positionOffset, nextValue.length));

          return new services.Selection(
            nextSelectionStart.lineNumber,
            nextSelectionStart.column,
            nextPosition.lineNumber,
            nextPosition.column
          );
        })
      );
    }

    editor.setScrollTop(scrollTop);
    editor.setScrollLeft(scrollLeft);

    // Kernel scroll corrections (scroll anchoring, selection-driven
    // scrolling) land one or two frames AFTER the replacement dispatch —
    // the synchronous restore above runs too early. Re-assert the saved
    // offsets for a couple of frames so the replacement is visually
    // scroll-neutral.
    for (let frame = 0; frame < 2; frame += 1) {
      window.requestAnimationFrame(() => {
        editor.setScrollTop(scrollTop);
        editor.setScrollLeft(scrollLeft);
      });
    }

    editor.focus();
  }, []);

  return syncEditorValuePreservingView;
}
