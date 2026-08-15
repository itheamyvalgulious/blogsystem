import type { PluginDefinition } from "../types";
import { ArticleMarkdownEditor } from "../editors/article-markdown-editor";
import { CodeTextEditor } from "../editors/code-text-editor";
import { HomeDashboardEditor } from "../editors/home-dashboard-editor";
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
      id: "workbench.action.toggleReadingMode",
      title: "View: Toggle Reading Mode (鍒囨崲闃呰妯″紡)",
      keywords: ["reading", "focus", "preview", "mode", "闃呰", "涓撴敞"],
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
