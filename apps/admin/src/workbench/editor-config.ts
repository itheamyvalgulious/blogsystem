import { normalizeEditorConfig } from "@blog-system/content-core";

import type { EditorConfigPayload } from "../api";
import { jsonSchemas } from "../editor-config-schema";
import { normalizeWorkbenchSnippets } from "../snippet-scope";
import { getJsonSchemaPaths } from "./document-builders";
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
    latexSnippets: normalizeWorkbenchSnippets(payload.latexSnippets, "latex"),
    keybindings: [...DEFAULT_KEYBINDINGS, ...normalizeEditorConfig({ snippets: [], keybindings: payload.keybindings }).keybindings]
  };
}

export function getJsonSchemaDefinitions() {
  const paths = getJsonSchemaPaths();
  return [
    { uri: "inmemory://schemas/snippets.json", fileMatch: [paths.markdownSnippetsPath, paths.latexSnippetsPath], schema: jsonSchemas.snippetSchema as object },
    { uri: "inmemory://schemas/keybindings.json", fileMatch: [paths.keybindingsPath], schema: jsonSchemas.keybindingSchema as object },
    { uri: "inmemory://schemas/editor-associations.json", fileMatch: [paths.editorAssociationsPath], schema: jsonSchemas.editorAssociationsSchema as object },
    { uri: "inmemory://schemas/markdown-blocks.json", fileMatch: [paths.markdownBlockConfigPath], schema: jsonSchemas.markdownBlockConfigSchema as object },
    { uri: "inmemory://schemas/theme-group.json", fileMatch: ["config/theme/*/theme.json"], schema: jsonSchemas.themeGroupConfigSchema as object },
    { uri: "inmemory://schemas/site.json", fileMatch: [paths.siteConfigPath], schema: jsonSchemas.siteConfigSchema as object },
  ];
}
