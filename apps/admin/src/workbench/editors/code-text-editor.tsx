import type { WorkbenchEditorComponentProps } from "../types";
import { WorkbenchEditorHost } from "./workbench-editor-host";

export function CodeTextEditor(props: WorkbenchEditorComponentProps) {
  return <WorkbenchEditorHost {...props} />;
}
