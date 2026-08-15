import { CmMarkdownEditor, type CmMarkdownEditorProps } from "../codemirror/cm-editor";
import type { WorkbenchEditorComponentProps } from "../types";
import { WorkbenchMonacoEditor } from "./workbench-monaco-editor";

/** Markdown is always edited by CodeMirror; Monaco is reserved for non-Markdown text. */

export function WorkbenchEditorHost(props: WorkbenchEditorComponentProps) {
  if (props.document.language === "markdown") {
    const editorKey = `${props.document.id}:${props.document.editorId}`;
    return (
      <CmMarkdownEditor
        editorKey={editorKey}
        key={editorKey}
        language={props.document.language}
        onChange={props.onChange}
        onModelContentChange={props.onModelContentChange}
        onMount={props.onMount}
        path={props.path}
        value={props.value}
      />
    );
  }

  return <WorkbenchMonacoEditor {...props} />;
}

/**
 * Dispatch for direct (non-workbench-document) markdown editor usages such as
 * the embedded goal/body editors in project-editors.tsx.
 */
export function MarkdownEditorHost(props: CmMarkdownEditorProps) {
  return (
    <CmMarkdownEditor
      key={props.editorKey ?? `${props.path}:${props.language ?? "markdown"}`}
      {...props}
    />
  );
}
