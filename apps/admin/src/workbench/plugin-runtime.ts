import type {
  AnyWorkbenchContributionDefinition,
  CommandDefinition,
  EditorContributionDefinition,
  EditorActionDefinition,
  MarkdownEditorFeatureDefinition,
  MarkdownFenceRendererFeatureDefinition,
  PasteHandlerDefinition,
  PluginDefinition,
  PluginSetupContext,
  ThemeDefinition
} from "./types";

export class PluginRuntime {
  private readonly commands = new Map<string, CommandDefinition>();
  private readonly editorContributions = new Map<string, EditorContributionDefinition>();
  private readonly editorActions = new Map<string, EditorActionDefinition>();
  private readonly markdownEditorFeatures = new Map<string, MarkdownEditorFeatureDefinition>();
  private readonly markdownFenceRenderers = new Map<string, MarkdownFenceRendererFeatureDefinition>();
  private readonly themes = new Map<string, ThemeDefinition>();
  private readonly pasteHandlers: PasteHandlerDefinition[] = [];
  private readonly workbenchContributions = new Map<string, AnyWorkbenchContributionDefinition>();
  private readonly plugins = new Set<string>();

  activate(plugins: PluginDefinition[]) {
    const context: PluginSetupContext = {
      registerCommand: (command) => {
        this.commands.set(command.id, command);
      },
      registerEditorAction: (action) => {
        this.editorActions.set(action.id, action);
      },
      registerEditorContribution: (contribution) => {
        this.editorContributions.set(contribution.editorId, contribution);
      },
      registerMarkdownEditorFeature: (feature) => {
        this.markdownEditorFeatures.set(feature.id, feature);
      },
      registerMarkdownFenceRenderer: (renderer) => {
        this.markdownFenceRenderers.set(renderer.language, renderer);
      },
      registerTheme: (theme) => {
        this.themes.set(theme.id, theme);
      },
      registerPasteHandler: (handler) => {
        this.pasteHandlers.push(handler);
      },
      registerWorkbenchContribution: (contribution) => {
        this.workbenchContributions.set(contribution.id, contribution);
      }
    };

    for (const plugin of plugins) {
      if (this.plugins.has(plugin.id)) {
        continue;
      }

      plugin.activate(context);
      this.plugins.add(plugin.id);
    }
  }

  getCommands() {
    return [...this.commands.values()];
  }

  getCommand(id: string) {
    return this.commands.get(id);
  }

  getEditorAction(id: string) {
    return this.editorActions.get(id);
  }

  getEditorContributions() {
    return [...this.editorContributions.values()];
  }

  getEditorContribution(editorId: string) {
    return this.editorContributions.get(editorId);
  }

  getMarkdownEditorFeatures() {
    return [...this.markdownEditorFeatures.values()];
  }

  getMarkdownFenceRenderers() {
    return [...this.markdownFenceRenderers.values()];
  }

  getThemes() {
    return [...this.themes.values()];
  }

  getTheme(id: string) {
    return this.themes.get(id);
  }

  getPasteHandlers() {
    return [...this.pasteHandlers];
  }

  getWorkbenchContributions() {
    return [...this.workbenchContributions.values()];
  }
}
