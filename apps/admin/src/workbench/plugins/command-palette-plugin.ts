import type { PluginDefinition } from "../types";

export const commandPalettePlugin: PluginDefinition = {
  id: "command-palette",
  label: "Command Palette",
  description: "Adds the command palette and JSON configuration entry points.",
  activate(context) {
    context.registerCommand({
      id: "workbench.showCommandPalette",
      title: "View: Show Command Palette",
      keywords: ["command", "palette", "settings", "open"],
      handler(api) {
        api.showCommandPalette();
      }
    });
    context.registerCommand({
      id: "preferences.openMarkdownSnippetsJson",
      title: "Preferences: Open Markdown Snippets (JSON)",
      keywords: ["settings", "markdown", "snippets", "json"],
      handler(api) {
        void api.openConfigDocument("markdownSnippets");
      }
    });
    context.registerCommand({
      id: "preferences.openLatexSnippetsJson",
      title: "Preferences: Open LaTeX Snippets (JSON)",
      keywords: ["settings", "latex", "snippets", "json", "math"],
      handler(api) {
        void api.openConfigDocument("latexSnippets");
      }
    });
    context.registerCommand({
      id: "preferences.openKeybindingsJson",
      title: "Preferences: Open Keybindings (JSON)",
      keywords: ["settings", "keybindings", "json", "shortcuts"],
      handler(api) {
        void api.openConfigDocument("keybindings");
      }
    });
    context.registerCommand({
      id: "preferences.openEditorAssociationsJson",
      title: "Preferences: Open Editor Associations (JSON)",
      keywords: ["settings", "editor", "association", "json", "reopen"],
      handler(api) {
        void api.openConfigDocument("editorAssociations");
      }
    });
    context.registerCommand({
      id: "preferences.openMarkdownBlockConfigJson",
      title: "Preferences: Open Markdown Block Rules (JSON)",
      keywords: ["settings", "markdown", "block", "rules", "json"],
      handler(api) {
        void api.openConfigDocument("markdownBlockConfig");
      }
    });
    context.registerCommand({
      id: "preferences.openSiteConfigJson",
      title: "Preferences: Open Site Config (JSON)",
      keywords: ["settings", "site", "plugins", "theme", "json"],
      handler(api) {
        void api.openConfigDocument("siteConfig");
      }
    });
    context.registerCommand({
      id: "preferences.openPublishConfigJson",
      title: "Preferences: Open Publish Config (JSON)",
      keywords: ["settings", "publish", "cloudflare", "github", "json"],
      handler(api) {
        void api.openConfigDocument("publishConfig");
      }
    });
    context.registerCommand({
      id: "preferences.openAiCompletionConfigJson",
      title: "Preferences: Open AI Completion Config (JSON)",
      keywords: ["settings", "ai", "completion", "inline", "json"],
      handler(api) {
        void api.openConfigDocument("aiCompletion");
      }
    });
    context.registerCommand({
      id: "workbench.reopenWithEditor",
      title: "View: Reopen With Editor",
      keywords: ["editor", "reopen", "open with"],
      handler(api) {
        api.showReopenWithEditor();
      }
    });
  }
};
