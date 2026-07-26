import type { WorkbenchEditorComponentProps } from "../types";
import { WorkbenchEditorHost } from "./workbench-editor-host";

export function ArticleMarkdownEditor(props: WorkbenchEditorComponentProps) {
  return <WorkbenchEditorHost {...props} />;
}
