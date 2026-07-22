import Editor from "@monaco-editor/react";
import type * as monacoEditor from "monaco-editor";

interface MonacoMarkdownEditorProps {
  editorKey?: string;
  language?: string;
  onChange: (nextValue: string) => void;
  onModelContentChange?: (event: monacoEditor.editor.IModelContentChangedEvent) => void;
  onMount: (
    editor: monacoEditor.editor.IStandaloneCodeEditor,
    monaco: typeof monacoEditor
  ) => void;
  path: string;
  value: string;
}

export function MonacoMarkdownEditor({
  editorKey,
  language = "markdown",
  onChange,
  onModelContentChange,
  onMount,
  path,
  value
}: MonacoMarkdownEditorProps) {
  return (
    <Editor
      key={editorKey ?? `${path}:${language}`}
      defaultLanguage={language}
      defaultValue={value}
      language={language}
      onMount={(editor, monaco) => {
        const disposable = onModelContentChange
          ? editor.onDidChangeModelContent(onModelContentChange)
          : null;
        onMount(editor, monaco);
        if (disposable) {
          editor.onDidDispose(() => {
            disposable.dispose();
          });
        }
      }}
      options={{
        automaticLayout: true,
        bracketPairColorization: { enabled: false },
        codeLens: false,
        colorDecorators: false,
        contextmenu: true,
        find: {
          addExtraSpaceOnTop: false
        },
        folding: true,
        foldingStrategy: "auto",
        fontFamily: "'Cascadia Code', 'Fira Code', monospace",
        fontLigatures: true,
        glyphMargin: false,
        hideCursorInOverviewRuler: true,
        hover: {
          enabled: false
        },
        inlayHints: { enabled: "off" },
        largeFileOptimizations: true,
        lightbulb: {
          // ShowLightbulbIconMode.Off === "off"; the literal keeps the import type-only.
          enabled: "off" as monacoEditor.editor.ShowLightbulbIconMode
        },
        links: false,
        minimap: { enabled: false },
        occurrencesHighlight: "off",
        overviewRulerBorder: false,
        overviewRulerLanes: 0,
        quickSuggestions: { other: true, strings: true, comments: false },
        renderValidationDecorations: "off",
        selectionHighlight: false,
        smoothScrolling: true,
        snippetSuggestions: "top",
        stickyScroll: { enabled: false },
        tabCompletion: "on",
        unicodeHighlight: {
          ambiguousCharacters: false,
          invisibleCharacters: false,
          nonBasicASCII: false
        },
        wordBasedSuggestions: "off",
        wordWrap: "on"
      }}
      path={path}
      onChange={
        onModelContentChange
          ? undefined
          : (nextValue) => {
              onChange(nextValue ?? "");
            }
      }
    />
  );
}
