import { useEffect, useRef, type Dispatch, type RefObject, type SetStateAction } from "react";
import { type OnMount } from "@monaco-editor/react";
import * as monacoEditor from "monaco-editor";

import type { EditorSnippet } from "@blog-system/content-core";
import {
  api,
  type EditorConfigPayload,
  type TreePayload
} from "../../api";
import {
  getActiveKeybinding,
  getMatchingKeybindings,
  isWorkbenchKeybindingCommand,
  matchesKeybindingEvent
} from "../../keybindings";
import {
  scanDocumentMathPairs,
  updateMathPairsCache,
  type MathPair
} from "../../markdown-math-tokenization";
import { scanHeadingsFromText, type CachedHeading } from "../../markdown-outline";
import {
  getSnippetTriggerCharacters,
  resolveActiveSnippetMatches
} from "../../snippet-completion";
import { getSnippetsForLanguage } from "../../snippet-scope";
import type { StoredArticleCursorState } from "../article-cursor-state";
import {
  isArticleDocument,
  isMarkdownCompletionDocument,
  isProjectTaskDocument
} from "../document-builders";
import { getJsonSchemaDefinitions } from "../editor-config";
import type { PluginRuntime } from "../plugin-runtime";
import {
  getProjectTaskNoteQuery,
  getProjectTaskNoteSuggestions
} from "../project-task-utils";
import type {
  ClipboardImageInput,
  EditorContributionDefinition,
  NormalizedEditorConfig,
  NormalizedSnippet,
  RevealLineOptions,
  SnippetLanguageId,
  ThemeDefinition,
  WorkbenchApi,
  WorkbenchDocument
} from "../types";
import type { PendingArticleReveal } from "./use-document-openers";

function toSnippetBody(body: string | string[]) {
  return Array.isArray(body) ? body.join("\n") : body;
}

function getScopedSnippets(snippets: NormalizedSnippet[], languageId: "markdown" | "latex") {
  return getSnippetsForLanguage(snippets, languageId);
}

function resolveEditorSnippetState(
  linePrefix: string,
  snippetLanguage: "markdown" | "latex",
  normalizedConfig: NormalizedEditorConfig
) {
  return resolveActiveSnippetMatches(
    linePrefix,
    snippetLanguage,
    getScopedSnippets(normalizedConfig.markdownSnippets, "markdown"),
    getScopedSnippets(normalizedConfig.latexSnippets, "latex")
  );
}

function isSuppressedDefaultEditorCommand(command: string, context: Record<string, unknown>) {
  switch (command) {
    case "acceptSelectedSuggestion":
      return context.suggestWidgetVisible === true;
    case "editor.action.triggerSuggest":
    case "editor.action.inlineSuggest.commit":
    case "editor.action.copyLinesDownAction":
    case "markdown.extension.onCopyLineDown":
    case "editor.action.copyLinesUpAction":
    case "markdown.extension.onCopyLineUp":
    case "editor.action.insertCursorAbove":
    case "editor.action.insertCursorBelow":
    case "workbench.action.quickOpen":
      return true;
    default:
      return false;
  }
}

interface EditorIntegrationOptions {
  activeDocument: WorkbenchDocument | null;
  activeEditorContribution: EditorContributionDefinition | null;
  activeTheme: ThemeDefinition | null;
  articleCursorStatesRef: RefObject<Record<string, StoredArticleCursorState>>;
  editorReadyVersion: number;
  editorRef: RefObject<monacoEditor.editor.IStandaloneCodeEditor | null>;
  getSnippetLanguageForEditor: (
    model: monacoEditor.editor.ITextModel,
    position: monacoEditor.Position
  ) => SnippetLanguageId;
  headingsRef: RefObject<CachedHeading[]>;
  jumpToActiveArticleLine: (lineNumber: number, options?: RevealLineOptions) => void;
  lastStoredArticleLineNumberRef: RefObject<number | null>;
  loadTree: () => Promise<TreePayload>;
  mathPairsRef: RefObject<MathPair[]>;
  monacoRef: RefObject<typeof monacoEditor | null>;
  normalizedConfig: NormalizedEditorConfig;
  pendingArticleRevealRef: RefObject<PendingArticleReveal | null>;
  pluginRuntime: PluginRuntime;
  setActiveArticleLineNumber: Dispatch<SetStateAction<number | null>>;
  setEditorReadyVersion: Dispatch<SetStateAction<number>>;
  storeArticleCursorState: (articlePath: string) => void;
  syncOutlineHeadings: () => void;
  treePayload: TreePayload | null;
  workbenchApiRef: RefObject<WorkbenchApi | null>;
}

export function useEditorIntegration({
  activeDocument,
  activeEditorContribution,
  activeTheme,
  articleCursorStatesRef,
  editorReadyVersion,
  editorRef,
  getSnippetLanguageForEditor,
  headingsRef,
  jumpToActiveArticleLine,
  lastStoredArticleLineNumberRef,
  loadTree,
  mathPairsRef,
  monacoRef,
  normalizedConfig,
  pendingArticleRevealRef,
  pluginRuntime,
  setActiveArticleLineNumber,
  setEditorReadyVersion,
  storeArticleCursorState,
  syncOutlineHeadings,
  treePayload,
  workbenchApiRef
}: EditorIntegrationOptions) {
  const editorFeatureCleanupRef = useRef<(() => void) | null>(null);

  const handleEditorMount: OnMount = (editor, monaco) => {
    editorFeatureCleanupRef.current?.();
    editorFeatureCleanupRef.current = null;
    editorRef.current = editor;
    monacoRef.current = monaco;
    setEditorReadyVersion((current) => current + 1);
    monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
      validate: true,
      schemas: getJsonSchemaDefinitions()
    });
    if (activeTheme) {
      monaco.editor.setTheme(activeTheme.id);
    }

    if (activeDocument?.language === "markdown") {
      const cleanups = pluginRuntime
        .getMarkdownEditorFeatures()
        .filter((feature) => feature.matches(activeDocument))
        .map((feature) => feature.onMount?.(editor, monaco, activeDocument))
        .filter((cleanup): cleanup is () => void => typeof cleanup === "function");

      if (cleanups.length > 0) {
        editorFeatureCleanupRef.current = () => {
          for (const cleanup of cleanups) {
            cleanup();
          }
        };
      }
    }
  };

  useEffect(() => {
    if (!activeDocument || activeDocument.kind === "home") {
      editorFeatureCleanupRef.current?.();
      editorFeatureCleanupRef.current = null;
      editorRef.current = null;
      monacoRef.current = null;
    }
  }, [activeDocument?.id, activeDocument?.kind, activeEditorContribution?.editorId]);

  useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();

    if (!editor || !model || !isArticleDocument(activeDocument)) {
      lastStoredArticleLineNumberRef.current = null;
      setActiveArticleLineNumber(null);
      return;
    }

    const storedState = articleCursorStatesRef.current[activeDocument.articlePath];
    const lineNumber = Math.max(1, Math.min(storedState?.lineNumber ?? 1, model.getLineCount()));
    const column = Math.max(1, Math.min(storedState?.column ?? 1, model.getLineMaxColumn(lineNumber)));
    const frame = window.requestAnimationFrame(() => {
      const selection = new monacoEditor.Selection(lineNumber, column, lineNumber, column);

      editor.setSelection(selection);
      editor.setPosition({ lineNumber, column });
      if (storedState) {
        editor.setScrollTop(storedState.scrollTop);
        editor.setScrollLeft(storedState.scrollLeft);
      } else {
        editor.setScrollTop(0);
        editor.setScrollLeft(0);
      }
      editor.focus();
      lastStoredArticleLineNumberRef.current = lineNumber;
      setActiveArticleLineNumber(lineNumber);
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeDocument?.id, editorReadyVersion]);

  useEffect(() => {
    const pendingReveal = pendingArticleRevealRef.current;
    if (
      !pendingReveal ||
      !activeDocument ||
      activeDocument.kind !== "article" ||
      activeDocument.articlePath !== pendingReveal.articlePath
    ) {
      return;
    }

    const editor = editorRef.current;
    if (!editor?.getModel()) {
      return;
    }

    pendingArticleRevealRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      jumpToActiveArticleLine(pendingReveal.lineNumber, {
        column: pendingReveal.column,
        focus: pendingReveal.focus,
        moveCursor: pendingReveal.moveCursor
      });
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [activeDocument?.id, editorReadyVersion, jumpToActiveArticleLine]);

  useEffect(() => {
    const editor = editorRef.current;

    if (!editor || !isArticleDocument(activeDocument)) {
      return;
    }

    const updateCursorState = () => {
      storeArticleCursorState(activeDocument.articlePath);
    };

    const cursorDisposable = editor.onDidChangeCursorPosition(() => {
      updateCursorState();
    });
    const scrollDisposable = editor.onDidScrollChange((event) => {
      if (event.scrollTopChanged || event.scrollLeftChanged) {
        updateCursorState();
      }
    });

    return () => {
      cursorDisposable.dispose();
      scrollDisposable.dispose();
    };
  }, [activeDocument?.id, editorReadyVersion, storeArticleCursorState]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !activeDocument || !isArticleDocument(activeDocument)) {
      headingsRef.current = [];
      mathPairsRef.current = [];
      updateMathPairsCache([]);
      syncOutlineHeadings();
      return;
    }

    const fullText = editor.getValue();
    headingsRef.current = scanHeadingsFromText(fullText);
    const newPairs = scanDocumentMathPairs(fullText);
    mathPairsRef.current = newPairs;
    updateMathPairsCache(newPairs);
    syncOutlineHeadings();
  }, [activeDocument?.id, editorReadyVersion, syncOutlineHeadings]);

  useEffect(() => {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) {
      return;
    }
    const allSnippets = [...normalizedConfig.markdownSnippets, ...normalizedConfig.latexSnippets];
    const markdownSymbolTriggerCharacters = getSnippetTriggerCharacters(normalizedConfig.markdownSnippets);
    const latexSymbolTriggerCharacters = getSnippetTriggerCharacters(normalizedConfig.latexSnippets);
    const completionProvider = monaco.languages.registerCompletionItemProvider("markdown", {
      triggerCharacters: Array.from(
        new Set(["@", ...markdownSymbolTriggerCharacters, ...latexSymbolTriggerCharacters])
      ),
      provideCompletionItems(model, position) {
        const linePrefix = model.getValueInRange(new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column));

        if (isProjectTaskDocument(activeDocument)) {
          const noteQuery = getProjectTaskNoteQuery(linePrefix);
          if (!noteQuery) {
            return { suggestions: [] };
          }

          const suggestions = getProjectTaskNoteSuggestions(noteQuery.query, treePayload?.articles ?? []).map(
            (article, index) => ({
              detail: article.path,
              filterText: `${article.title} ${article.path} @note`.trim(),
              insertText: `@note/${article.title} `,
              kind: monaco.languages.CompletionItemKind.Reference,
              label: {
                description: article.path,
                label: article.title
              },
              range: new monaco.Range(
                position.lineNumber,
                Math.max(1, position.column - noteQuery.replacementText.length),
                position.lineNumber,
                position.column
              ),
              sortText: `0-${String(index).padStart(4, "0")}`
            })
          );

          return { suggestions };
        }

        if (!isArticleDocument(activeDocument)) {
          return { suggestions: [] };
        }
        const snippetLanguage = getSnippetLanguageForEditor(model, position);
        const snippetState = resolveEditorSnippetState(linePrefix, snippetLanguage, normalizedConfig);
        const suggestions = snippetState.matches.map(
          ({ prefix, replacementText, snippet }) => ({
            kind: monaco.languages.CompletionItemKind.Snippet,
            label: { label: snippet.name, description: prefix },
            filterText: `${prefix} ${snippet.name} ${snippet.description ?? ""}`.trim(),
            insertText: toSnippetBody(snippet.body),
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            range: new monaco.Range(
              position.lineNumber,
              Math.max(1, position.column - replacementText.length),
              position.lineNumber,
              position.column
            ),
            sortText: `0-${String(9999 - replacementText.length).padStart(4, "0")}-${String(prefix.length).padStart(4, "0")}-${prefix}`
          })
        );
        return { suggestions };
      }
    });
    const domNode = editor.getDomNode();
    const textarea = domNode?.querySelector<HTMLTextAreaElement>("textarea.inputarea");
    const getSnippetController = () =>
      editor.getContribution("snippetController2") as {
        insert: (template: string) => void;
        isInSnippet?: () => boolean;
      } | null;
    const insertSnippet = (snippet: EditorSnippet) => {
      getSnippetController()?.insert(toSnippetBody(snippet.body));
    };
    const createEditorWhenContext = () => {
      const model = editor.getModel();
      const position = editor.getPosition();
      const hasSelection = Boolean(editor.getSelection()) && !editor.getSelection()?.isEmpty();
      const editorHasTextFocus = editor.hasTextFocus();
      const snippetController = getSnippetController();
      const snippetLanguage =
        model && position && isArticleDocument(activeDocument) ? getSnippetLanguageForEditor(model, position) : "markdown";

      return {
        editorLangId: snippetLanguage,
        editorTextFocus: editorHasTextFocus,
        textInputFocus: editorHasTextFocus,
        inputFocus: editorHasTextFocus,
        editorReadonly: editor.getOption(monaco.editor.EditorOption.readOnly),
        editorHasCompletionItemProvider: isMarkdownCompletionDocument(activeDocument),
        suggestWidgetVisible: Boolean(domNode?.querySelector(".suggest-widget.visible")),
        editorHasMultipleSelections: (editor.getSelections()?.length ?? 0) > 1,
        editorHasSelection: hasSelection,
        editorHoverVisible: Boolean(domNode?.querySelector(".monaco-hover.visible")),
        editorHoverFocused: false,
        editorTabMovesFocus: false,
        inlineChatFocused: false,
        notebookEditorFocused: false,
        notebookOutputFocused: false,
        inInlineEditsPreviewEditor: false,
        inlineEditIsVisible: false,
        inlineSuggestionVisible: false,
        inlineSuggestionHasIndentationLessThanTabSize: false,
        tabShouldAcceptInlineEdit: false,
        inSnippetMode: snippetController?.isInSnippet?.() ?? false,
        editor: {
          hasSelection
        },
        trae: {
          hasInlineSuggestShouldAcceptDirect: false
        }
      };
    };
    const executeEditorKeybinding = async (
      keybinding: EditorConfigPayload["keybindings"][number],
      relevantSnippets: NormalizedSnippet[],
      activeSnippetMatches: import("../../snippet-completion").SnippetCompletionMatch[]
    ) => {
      if (keybinding.command === "editor.insertSnippet") {
        const snippetName = String(keybinding.args?.snippetName ?? "");
        const snippet =
          relevantSnippets.find((item) => item.name === snippetName) ??
          allSnippets.find((item) => item.name === snippetName);

        if (snippet) {
          insertSnippet(snippet);
          return true;
        }

        return false;
      }

      if (keybinding.command === "type") {
        editor.trigger("keyboard", "type", keybinding.args ?? {});
        return true;
      }

      if (isWorkbenchKeybindingCommand(keybinding.command)) {
        const workbenchCommand = pluginRuntime.getCommand(
          keybinding.command === "workbench.action.showCommands"
            ? "workbench.showCommandPalette"
            : keybinding.command
        );
        if (workbenchCommand && workbenchApiRef.current) {
          await workbenchCommand.handler(workbenchApiRef.current);
          return true;
        }
      }

      const action = pluginRuntime.getEditorAction(keybinding.command);
      if (action) {
        return await action.handler({
          editor,
          monaco,
          activeDocument,
          snippets: relevantSnippets,
          activeSnippetMatches
        });
      }

      if (
        keybinding.command === "hideSuggestWidget" ||
        keybinding.command === "acceptSelectedSuggestion" ||
        keybinding.command.startsWith("editor.")
      ) {
        editor.trigger("keyboard", keybinding.command, keybinding.args ?? {});
        return true;
      }

      return false;
    };
    const keydownListener = async (event: KeyboardEvent) => {
      if (!editor.hasTextFocus() || !isArticleDocument(activeDocument)) {
        return;
      }
      const model = editor.getModel();
      const position = editor.getPosition();
      if (!model || !position) {
        return;
      }

      const snippetLanguage = getSnippetLanguageForEditor(model, position);
      const linePrefix = model.getValueInRange(
        new monaco.Range(position.lineNumber, 1, position.lineNumber, position.column)
      );
      const snippetState = resolveEditorSnippetState(linePrefix, snippetLanguage, normalizedConfig);
      const relevantSnippets = snippetState.currentLanguageSnippets;
      const whenContext = createEditorWhenContext();
      const matchingKeybindings = getMatchingKeybindings(normalizedConfig.keybindings, event, whenContext);
      const activeKeybinding = getActiveKeybinding(normalizedConfig.keybindings, event, whenContext);

      if (activeKeybinding) {
        const handled = await executeEditorKeybinding(
          activeKeybinding,
          relevantSnippets,
          snippetState.matches
        );
        if (handled) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
      }

      const removedCommands = matchingKeybindings
        .filter((keybinding) => keybinding.command.startsWith("-"))
        .map((keybinding) => keybinding.command.slice(1));
      const snippetController = getSnippetController();

      if (
        event.key === "Tab" &&
        (snippetController?.isInSnippet?.() ?? false) &&
        removedCommands.includes("acceptSelectedSuggestion")
      ) {
        event.preventDefault();
        event.stopPropagation();
        editor.trigger(
          "keyboard",
          event.shiftKey ? "jumpToPrevSnippetPlaceholder" : "jumpToNextSnippetPlaceholder",
          {}
        );
        return;
      }

      if (removedCommands.some((command) => isSuppressedDefaultEditorCommand(command, whenContext))) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      const keyedSnippet = relevantSnippets.find(
        (snippet) => snippet.key && matchesKeybindingEvent(snippet.key, event)
      );
      if (keyedSnippet) {
        event.preventDefault();
        event.stopPropagation();
        insertSnippet(keyedSnippet);
        return;
      }
    };
    // `onDidType` exists on the editor at runtime but is no longer exposed in
    // monaco-editor's public typings (0.52), hence the structural assertion.
    const typeDisposable = (
      editor as monacoEditor.editor.IStandaloneCodeEditor & {
        onDidType(listener: (text: string) => void): monacoEditor.IDisposable;
      }
    ).onDidType((text) => {
      if (text.length !== 1) {
        return;
      }

      if (isProjectTaskDocument(activeDocument)) {
        if (text !== "@") {
          return;
        }

        queueMicrotask(() => {
          if (!editor.hasTextFocus()) {
            return;
          }

          editor.trigger("keyboard", "editor.action.triggerSuggest", {});
        });
        return;
      }

      if (!isArticleDocument(activeDocument)) {
        return;
      }

      queueMicrotask(() => {
        if (!editor.hasTextFocus()) {
          return;
        }

        const currentModel = editor.getModel();
        const currentPosition = editor.getPosition();
        if (!currentModel || !currentPosition) {
          return;
        }

        const currentSnippetLanguage = getSnippetLanguageForEditor(currentModel, currentPosition);
        const currentLinePrefix = currentModel.getValueInRange(
          new monaco.Range(currentPosition.lineNumber, 1, currentPosition.lineNumber, currentPosition.column)
        );
        const snippetState = resolveEditorSnippetState(
          currentLinePrefix,
          currentSnippetLanguage,
          normalizedConfig
        );
        const triggerCharacters = getSnippetTriggerCharacters(
          snippetState.matches.map((match) => match.snippet)
        );
        const suggestWidgetVisible = Boolean(domNode?.querySelector(".suggest-widget.visible"));

        if (snippetState.matches.length === 0) {
          editor.trigger("keyboard", "hideSuggestWidget", {});
          return;
        }

        if (triggerCharacters.includes(text) || suggestWidgetVisible) {
          editor.trigger("keyboard", "editor.action.triggerSuggest", {});
        }
      });
    });
    const pasteListener = async (event: ClipboardEvent) => {
      if (!isArticleDocument(activeDocument)) {
        return;
      }

      if ((event as ClipboardEvent & { __blogSystemPasteHandled?: boolean }).__blogSystemPasteHandled) {
        return;
      }

      const target = event.target;
      const targetIsInsideEditor =
        target instanceof Node ? domNode?.contains(target) ?? false : false;
      const activeElement = document.activeElement;
      const focusIsOnEditorTextarea =
        activeElement instanceof HTMLTextAreaElement &&
        activeElement.classList.contains("inputarea") &&
        (domNode?.contains(activeElement) ?? false);

      if (!targetIsInsideEditor && !focusIsOnEditorTextarea) {
        return;
      }

      (event as ClipboardEvent & { __blogSystemPasteHandled?: boolean }).__blogSystemPasteHandled = true;

      for (const handler of pluginRuntime.getPasteHandlers()) {
        const handled = await handler.handle({
          event,
          editor,
          activeDocument,
          uploadClipboardImages: async (target, images: ClipboardImageInput[]) => {
            if (target.kind === "article") {
              const response = await api.uploadPastedImages(target.articlePath, images);
              await loadTree();
              return response.assets;
            }

            const response = await api.uploadMediaAssets(images);
            return response.assets;
          }
        });
        if (handled) {
          break;
        }
      }
    };
    domNode?.addEventListener("keydown", keydownListener, true);
    domNode?.addEventListener("paste", pasteListener, true);
    textarea?.addEventListener("paste", pasteListener, true);
    window.addEventListener("paste", pasteListener, true);
    return () => {
      completionProvider.dispose();
      typeDisposable.dispose();
      domNode?.removeEventListener("keydown", keydownListener, true);
      domNode?.removeEventListener("paste", pasteListener, true);
      textarea?.removeEventListener("paste", pasteListener, true);
      window.removeEventListener("paste", pasteListener, true);
    };
  }, [activeDocument, editorReadyVersion, normalizedConfig, pluginRuntime, treePayload?.articles]);

  return {
    handleEditorMount
  };
}
