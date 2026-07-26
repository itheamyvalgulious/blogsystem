import type { PluginDefinition } from "../types";

const BRACKET_PAIRS: Record<string, string> = {
  "(": ")",
  "[": "]",
  "{": "}",
  "<": ">",
  "|": "|"
};

const LIST_PREFIX_PATTERN = /^(\d+\.\s|[-*+]\s)/;

export const editorConveniencePlugin: PluginDefinition = {
  id: "editor-convenience",
  label: "Editor Convenience",
  description: "Bracket wrapping, list continuation, and bold shortcut.",
  activate(context) {
    context.registerEditorAction({
      id: "editor.markdown.set_bold",
      title: "Markdown: Toggle Bold",
      handler({ editor, services }) {
        const model = editor.getModel();
        const selection = editor.getSelection();
        if (!model || !selection) return false;

        const selectedText = model.getValueInRange(selection);
        const startOffset = model.getOffsetAt(selection.getStartPosition());
        const fullText = model.getValue();

        const before = fullText.slice(Math.max(0, startOffset - 2), startOffset);
        const after = fullText.slice(startOffset + selectedText.length, startOffset + selectedText.length + 2);

        if (before === "**" && after === "**") {
          const removeRange = new services.Range(
            selection.startLineNumber,
            selection.startColumn - 2,
            selection.endLineNumber,
            selection.endColumn + 2
          );
          editor.executeEdits("toggle-bold", [{
            range: removeRange,
            text: selectedText
          }]);
          editor.setSelection(new services.Selection(
            selection.startLineNumber,
            selection.startColumn - 2,
            selection.endLineNumber,
            selection.endColumn - 2
          ));
          return true;
        }

        const wrapped = `**${selectedText}**`;
        editor.executeEdits("toggle-bold", [{
          range: selection,
          text: wrapped
        }]);
        editor.setSelection(new services.Selection(
          selection.startLineNumber,
          selection.startColumn + 2,
          selection.endLineNumber,
          selection.endColumn + 2
        ));
        return true;
      }
    });

    context.registerMarkdownEditorFeature({
      id: "editor-convenience-handlers",
      matches: () => true,
      onMount(editor, services) {
        const domNode = editor.getDomNode();
        if (!domNode) return;

        const keydownHandler = (event: KeyboardEvent) => {
          const model = editor.getModel();
          const selection = editor.getSelection();
          if (!model || !selection) return;

          if (event.key in BRACKET_PAIRS && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (selection.isEmpty()) return;

            event.preventDefault();
            event.stopPropagation();

            const selectedText = model.getValueInRange(selection);
            const open = event.key;
            const close = BRACKET_PAIRS[open];
            const wrapped = open + selectedText + close;

            editor.executeEdits("bracket-wrap", [{
              range: selection,
              text: wrapped
            }]);

            editor.setSelection(new services.Selection(
              selection.startLineNumber,
              selection.startColumn + 1,
              selection.endLineNumber,
              selection.endColumn + 1
            ));
            return;
          }

          if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey) {
            const position = editor.getPosition();
            if (!position) return;

            const lineContent = model.getLineContent(position.lineNumber);
            const beforeCursor = lineContent.slice(0, position.column - 1);
            const match = LIST_PREFIX_PATTERN.exec(beforeCursor);
            if (!match) return;

            if (beforeCursor.trim() === match[1].trim()) {
              return;
            }

            event.preventDefault();
            event.stopPropagation();

            const prefix = match[1];
            const eol = model.getEOL();
            editor.executeEdits("list-continue", [{
              range: new services.Range(position.lineNumber, position.column, position.lineNumber, position.column),
              text: eol + prefix
            }]);
            editor.revealPosition(editor.getPosition()!);
          }
        };

        domNode.addEventListener("keydown", keydownHandler, true);
        return () => domNode.removeEventListener("keydown", keydownHandler, true);
      }
    });
  }
};
