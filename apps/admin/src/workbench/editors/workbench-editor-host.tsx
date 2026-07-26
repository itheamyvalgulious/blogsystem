import { getPreferredEditorEngine } from "../codemirror/engine-select";
import { CmMarkdownEditor, type CmMarkdownEditorProps } from "../codemirror/cm-editor";
import type { WorkbenchEditorComponentProps } from "../types";
import { MonacoMarkdownEditor } from "./monaco-markdown-editor";
import { WorkbenchMonacoEditor } from "./workbench-monaco-editor";

/**
 * Engine dispatch for workbench editors: documents edited as markdown go to
 * the CodeMirror "live" engine when it is the preferred engine (see
 * codemirror/engine-select.ts); everything else keeps the Monaco path
 * untouched.
 */

export function WorkbenchEditorHost(props: WorkbenchEditorComponentProps) {
  if (props.document.language === "markdown" && getPreferredEditorEngine() === "live") {
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
  if (getPreferredEditorEngine() === "live") {
    return (
      <CmMarkdownEditor
        key={props.editorKey ?? `${props.path}:${props.language ?? "markdown"}`}
        {...props}
      />
    );
  }

  return <MonacoMarkdownEditor {...props} />;
}
