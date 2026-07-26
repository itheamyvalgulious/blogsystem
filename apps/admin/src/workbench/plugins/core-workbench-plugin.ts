import type { PluginDefinition } from "../types";
import { ArticleMarkdownEditor } from "../editors/article-markdown-editor";
import { CodeTextEditor } from "../editors/code-text-editor";
import { HomeDashboardEditor } from "../editors/home-dashboard-editor";
import { getPreferredEditorEngine, setPreferredEditorEngine } from "../codemirror/engine-select";
import { getReadingMode, setReadingMode } from "../codemirror/cm-reading-mode";

export const coreWorkbenchPlugin: PluginDefinition = {
  id: "core-workbench",
  label: "Core Workbench",
  description: "Provides the base workbench commands for layout, saving, and publishing.",
  activate(context) {
    context.registerEditorContribution({
      canHandle: (document) => document.kind === "home",
      component: HomeDashboardEditor,
      editorId: "workbench.home-dashboard",
      label: "Home Dashboard",
      matches: (document) => document.kind === "home"
    });
    context.registerEditorContribution({
      canHandle: (document) => document.kind === "article",
      component: ArticleMarkdownEditor,
      editorId: "workbench.article-markdown",
      label: "Article Markdown",
      matches: (document) => document.kind === "article",
      previewSource: (document, value) => (document.kind === "article" ? value : null),
      supportsPreview: true
    });
    context.registerEditorContribution({
      canHandle: (document) =>
        document.kind === "article" ||
        document.kind === "config" ||
        document.kind === "themeAsset",
      component: CodeTextEditor,
      editorId: "workbench.code-text",
      label: "Code Text",
      matches: (document) => document.kind === "config" || document.kind === "themeAsset"
    });
    context.registerCommand({
      id: "workbench.toggleSidebar",
      title: "View: Toggle Sidebar",
      keywords: ["sidebar", "explorer", "view"],
      handler(api) {
        api.toggleSidebar();
      }
    });
    context.registerCommand({
      id: "workbench.togglePreview",
      title: "View: Toggle Preview",
      keywords: ["preview", "markdown", "view"],
      handler(api) {
        api.togglePreview();
      }
    });
    context.registerCommand({
      id: "workbench.action.toggleEditorEngine",
      title: "View: Switch Editor Engine (切换编辑器引擎)",
      keywords: ["editor", "engine", "monaco", "codemirror", "live", "reload"],
      handler(api) {
        const nextEngine = getPreferredEditorEngine() === "monaco" ? "live" : "monaco";
        if (
          api.hasDirtyArticleDocument() &&
          !window.confirm(
            "Switching the editor engine reloads the page and discards unsaved article changes. Continue?"
          )
        ) {
          return;
        }
        setPreferredEditorEngine(nextEngine);
        window.location.reload();
      }
    });
    context.registerCommand({
      id: "workbench.action.toggleReadingMode",
      title: "View: Toggle Reading Mode (切换阅读模式)",
      keywords: ["reading", "focus", "preview", "mode", "阅读", "专注"],
      handler() {
        setReadingMode(getReadingMode() === "read" ? "write" : "read");
      }
    });
    context.registerCommand({
      id: "workbench.openHome",
      title: "View: Open Admin Home",
      keywords: ["home", "dashboard", "start"],
      handler(api) {
        api.openHome();
      }
    });
    context.registerCommand({
      id: "workbench.saveActiveDocument",
      title: "File: Save Active Document",
      keywords: ["save", "document", "file"],
      handler(api) {
        void api.saveActiveDocument();
      }
    });
    context.registerCommand({
      id: "blog.publishStaticSite",
      title: "Blog: Publish Static Site",
      keywords: ["publish", "deploy", "github", "static"],
      handler(api) {
        void api.publishStaticSite();
      }
    });
  }
};
