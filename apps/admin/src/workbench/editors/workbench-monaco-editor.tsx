import type { WorkbenchEditorComponentProps } from "../types";
import { MonacoTextEditor } from "./monaco-text-editor";

export function WorkbenchMonacoEditor(props: WorkbenchEditorComponentProps) {
  return (
    <MonacoTextEditor
      editorKey={`${props.document.id}:${props.document.editorId}`}
      language={props.document.language}
      onChange={props.onChange}
      onModelContentChange={props.onModelContentChange}
      onMount={props.onMount}
      path={props.path}
      value={props.value}
    />
  );
}
