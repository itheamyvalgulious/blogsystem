import type { PluginDefinition } from "../types";

export const snippetActionsPlugin: PluginDefinition = {
  id: "snippet-actions",
  label: "Snippet Actions",
  description: "Handles tab and enter based snippet expansion inside the editor.",
  activate(context) {
    context.registerEditorAction({
      id: "editor.expandMatchingSnippet",
      title: "Editor: Expand Matching Snippet",
      handler({ activeSnippetMatches, editor, services, activeDocument }) {
        if (
          !activeDocument ||
          (activeDocument.kind !== "article" &&
            activeDocument.kind !== "projectTask" &&
            activeDocument.kind !== "projectLog")
        ) {
          return false;
        }

        const model = editor.getModel();
        const position = editor.getPosition();

        if (!model || !position) {
          return false;
        }

        const linePrefix = model.getValueInRange(
          new services.Range(position.lineNumber, 1, position.lineNumber, position.column)
        );
        const matchedEntry = activeSnippetMatches
          .filter(
            (entry) =>
              entry.replacementText === entry.prefix && linePrefix.endsWith(entry.replacementText)
          )
          .sort((left, right) => right.prefix.length - left.prefix.length)[0];

        if (!matchedEntry) {
          return false;
        }

        const range = new services.Range(
          position.lineNumber,
          position.column - matchedEntry.prefix.length,
          position.lineNumber,
          position.column
        );

        editor.setSelection(range);
        const controller = editor.getSnippetController();

        if (!controller) {
          return false;
        }

        const body = Array.isArray(matchedEntry.snippet.body)
          ? matchedEntry.snippet.body.join("\n")
          : matchedEntry.snippet.body;

        controller.insert(body);
        return true;
      }
    });
  }
};
