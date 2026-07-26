import { useCallback, type RefObject } from "react";

import type { EditorEngineServices, WorkbenchEditorHandle } from "../editor-engine";

export function useEditorValueSync(
  editorRef: RefObject<WorkbenchEditorHandle | null>,
  editorServicesRef: RefObject<EditorEngineServices | null>
) {
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
    editor.focus();
  }, []);

  return syncEditorValuePreservingView;
}
