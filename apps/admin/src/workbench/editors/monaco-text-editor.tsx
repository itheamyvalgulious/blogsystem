import Editor from "@monaco-editor/react";

import type {
  EditorContentChangedEvent,
  EditorEngineServices,
  WorkbenchEditorHandle
} from "../editor-engine";
import {
  createMonacoEditorHandle,
  createMonacoEngineServices
} from "./monaco-engine-adapter";

interface MonacoTextEditorProps {
  editorKey?: string;
  language?: string;
  onChange: (nextValue: string) => void;
  onModelContentChange?: (event: EditorContentChangedEvent) => void;
  onMount: (
    editor: WorkbenchEditorHandle,
    services: EditorEngineServices
  ) => void;
  path: string;
  value: string;
}

/** Basic Monaco editor for non-Markdown workspace documents. */
export function MonacoTextEditor({
  editorKey,
  language = "plaintext",
  onChange,
  onModelContentChange,
  onMount,
  path,
  value
}: MonacoTextEditorProps) {
  return (
    <Editor
      key={editorKey ?? `${path}:${language}`}
      defaultLanguage={language}
      defaultValue={value}
      language={language}
      onMount={(editor, monaco) => {
        const disposable = onModelContentChange
          ? editor.onDidChangeModelContent(onModelContentChange)
          : null;
        onMount(createMonacoEditorHandle(editor, monaco), createMonacoEngineServices(monaco));
        editor.onDidDispose(() => {
          disposable?.dispose();
        });
      }}
      options={{
        automaticLayout: true,
        folding: true,
        fontFamily: "'Cascadia Code', 'Fira Code', monospace",
        fontLigatures: true,
        minimap: { enabled: false },
        wordWrap: "on"
      }}
      path={path}
      onChange={
        onModelContentChange
          ? undefined
          : (nextValue) => {
              onChange(nextValue ?? "");
            }
      }
    />
  );
}

export type { MonacoTextEditorProps };
