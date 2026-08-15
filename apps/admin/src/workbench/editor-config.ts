import { normalizeEditorConfig } from "@blog-system/content-core";

import { DEFAULT_LATEX_SNIPPETS } from "../default-latex-snippets";
import type { EditorConfigPayload } from "../api";
import { normalizeWorkbenchSnippets } from "../snippet-scope";
import type { NormalizedEditorConfig } from "./types";

export const emptyConfigPayload: EditorConfigPayload = {
  editorAssociations: {},
  editorAssociationsRaw: "{}\n",
  markdownSnippets: [],
  latexSnippets: [],
  keybindings: [],
  markdownSnippetsRaw: "[]\n",
  latexSnippetsRaw: "[]\n",
  keybindingsRaw: "[]\n",
  warnings: []
};

const DEFAULT_KEYBINDINGS = normalizeEditorConfig({
  snippets: [],
  keybindings: [
    {
      key: "Ctrl+S",
      command: "workbench.saveActiveDocument"
    },
    {
      key: "Ctrl+Shift+P",
      command: "workbench.action.showCommands"
    },
    {
      key: "F1",
      command: "workbench.action.showCommands"
    },
    {
      key: "Ctrl+B",
      command: "workbench.toggleSidebar"
    },
    {
      key: "Ctrl+Backslash",
      command: "workbench.togglePreview"
    },
    {
      key: "F22",
      command: "acceptSelectedSuggestion",
      when: "suggestWidgetVisible"
    },
    {
      key: "Ctrl+E",
      command: "editor.markdown.set_bold",
      when: "editorTextFocus"
    }
  ]
}).keybindings;

export function buildNormalizedEditorConfig(configPayload: EditorConfigPayload | null): NormalizedEditorConfig {
  const payload = configPayload ?? emptyConfigPayload;
  return {
    markdownSnippets: normalizeWorkbenchSnippets(payload.markdownSnippets, "markdown"),
    // Built-ins are merged only into the runtime view of the config.  The
    // raw payload remains user-owned, so saving the config never writes these
    // defaults back to the workspace file.
    latexSnippets: normalizeWorkbenchSnippets(
      [...DEFAULT_LATEX_SNIPPETS, ...payload.latexSnippets],
      "latex"
    ),
    keybindings: [...DEFAULT_KEYBINDINGS, ...normalizeEditorConfig({ snippets: [], keybindings: payload.keybindings }).keybindings]
  };
}
