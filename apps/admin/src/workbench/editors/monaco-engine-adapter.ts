import type * as monacoEditor from "monaco-editor";

import {
  EditorOption,
  type EditorEngineServices,
  type WorkbenchEditorHandle
} from "../editor-engine";

/**
 * Wraps a Monaco standalone editor in the engine-neutral workbench handle.
 * Every method is a straight passthrough: the neutral types intentionally
 * mirror Monaco's own shapes, so no value conversion happens here.
 *
 * Imports of `monaco-editor` stay type-only on purpose: the package has no
 * Node-consumable entry point, and a runtime import would break test runs
 * that pull this module in transitively.
 */
export function createMonacoEditorHandle(
  editor: monacoEditor.editor.IStandaloneCodeEditor,
  monaco: typeof monacoEditor
): WorkbenchEditorHandle {
  return {
    getValue: () => editor.getValue(),
    executeEdits: (source, edits) => editor.executeEdits(source, edits),
    pushUndoStop: () => editor.pushUndoStop(),
    trigger: (source, commandId, args) => editor.trigger(source, commandId, args),

    getPosition: () => editor.getPosition(),
    setPosition: (position) => editor.setPosition(position),
    getSelection: () => editor.getSelection(),
    getSelections: () => editor.getSelections(),
    setSelection: (selection) => editor.setSelection(selection),
    setSelections: (selections) => editor.setSelections(selections),

    getScrollTop: () => editor.getScrollTop(),
    getScrollLeft: () => editor.getScrollLeft(),
    setScrollTop: (value) => editor.setScrollTop(value),
    setScrollLeft: (value) => editor.setScrollLeft(value),
    revealLineInCenter: (lineNumber) => editor.revealLineInCenter(lineNumber),
    revealPosition: (position) => editor.revealPosition(position),

    onDidChangeModelContent: (listener) => editor.onDidChangeModelContent(listener),
    onDidChangeCursorPosition: (listener) => editor.onDidChangeCursorPosition(listener),
    onDidScrollChange: (listener) => editor.onDidScrollChange(listener),
    onDidFocusEditorText: (listener) => editor.onDidFocusEditorText(listener),
    onDidChangeModel: (listener) => editor.onDidChangeModel(listener),
    onDidDispose: (listener) => editor.onDidDispose(listener),
    // `onDidType` exists on the editor at runtime but is no longer exposed in
    // monaco-editor's public typings (0.52), hence the structural assertion.
    onDidType: (listener) =>
      (
        editor as monacoEditor.editor.IStandaloneCodeEditor & {
          onDidType(listener: (text: string) => void): monacoEditor.IDisposable;
        }
      ).onDidType(listener),

    getModel: () => editor.getModel(),
    getDomNode: () => editor.getDomNode(),
    hasTextFocus: () => editor.hasTextFocus(),
    focus: () => editor.focus(),
    // Custom snippet insertion belongs to the Markdown CodeMirror path.
    // Monaco is intentionally a basic non-Markdown editor here.
    getSnippetController: () => null,
    getOption: (option) => {
      switch (option) {
        case "readOnly":
          return editor.getOption(monaco.editor.EditorOption.readOnly);
      }
    }
  };
}

export function createMonacoEngineServices(monaco: typeof monacoEditor): EditorEngineServices {
  return {
    engine: "monaco",
    Range: monaco.Range,
    Selection: monaco.Selection,
    EditorOption
  };
}
