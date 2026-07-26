import { useEffect, useRef } from "react";

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { codeFolding, foldGutter } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  lineNumbers,
  rectangularSelection,
  type ViewUpdate
} from "@codemirror/view";
import { history } from "@codemirror/commands";

import {
  EditorOption,
  type EditorContentChange,
  type EditorContentChangedEvent,
  type EditorEngineServices,
  type WorkbenchEditorHandle
} from "../editor-engine";
import { createCmCompletionExtension } from "./cm-completion";
import {
  cancelAiGhostRequest,
  createCmAiInlineCompletionExtension
} from "./cm-inline-completion";
import { cmKeymap } from "./cm-keymap";
import {
  CmRange,
  CmSelection,
  createCmEditorHandle,
  rangeFromOffsets,
  type CmEditorHandleBundle,
  type CmEditorHandleInternals
} from "./cm-handle";
import { cmMathHighlight } from "./cm-math-highlight";
import { cmLivePreview, cmMathMarkdown } from "./cm-live-preview";
import {
  createCmBaseTheme,
  getCmThemeCompartmentExtension,
  registerCmThemeView,
  syncCmThemeToView
} from "./cm-theme";

/**
 * CodeMirror 6 ("live" engine) markdown editor for the workbench.
 *
 * Props intentionally mirror `MonacoMarkdownEditor` one-to-one so the engine
 * host can swap implementations without touching callers.
 *
 * Design notes:
 * - One EditorView per component mount; EditorStates are cached per path in a
 *   module-level map, mirroring Monaco's per-path model reuse (undo history
 *   and selection survive document switches). On a path prop change the
 *   current state is stored back under the old path and the new path's state
 *   is restored (or created) via `view.setState`.
 * - `value` is controlled: when it diverges from the document (external sync,
 *   e.g. disk refresh — self-edit loops converge because the update listener
 *   reports every change through onChange), the full text is replaced with a
 *   regular change dispatch so undo history is preserved and the selection is
 *   mapped through the change.
 * - Events are bridged to the handle through a module-level update listener
 *   that resolves the per-view bridge from a WeakMap, which keeps the shared
 *   base extensions (and therefore cached EditorStates) mount-independent.
 * - No monaco imports: this module must stay loadable in Node test runs.
 */

export interface CmMarkdownEditorProps {
  editorKey?: string;
  language?: string;
  onChange: (nextValue: string) => void;
  onModelContentChange?: (event: EditorContentChangedEvent) => void;
  onMount: (
    editor: WorkbenchEditorHandle,
    services: EditorEngineServices
  ) => void;
  path: string;
  value: string;
}

export function createCmEngineServices(): EditorEngineServices {
  return {
    EditorOption,
    Range: CmRange,
    Selection: CmSelection,
    engine: "live"
  };
}

interface CmEditorPropsRef {
  onChange: (nextValue: string) => void;
  onModelContentChange?: (event: EditorContentChangedEvent) => void;
  value: string;
}

interface CmViewBridge {
  handleUpdate: (update: ViewUpdate) => void;
}

const bridges = new WeakMap<EditorView, CmViewBridge>();

/**
 * Ring of recently self-emitted document values (see handleViewUpdate). The
 * workbench's draft pipeline lags ~50ms behind edits, so a render triggered
 * inside that window can hand us a `value` prop that is a stale echo of our
 * own earlier emission; applying it would resurrect undone text. Any `value`
 * found in this ring is treated as an echo and ignored by the controlled
 * value sync — only values we never emitted are genuine external changes
 * (disk refresh, rename, save round-trips). 16 entries covers the draft lag
 * window even during fast typing.
 */
const recentEmissions = new WeakMap<EditorView, string[]>();

function recordEmission(view: EditorView, value: string) {
  const ring = recentEmissions.get(view);
  if (!ring) {
    recentEmissions.set(view, [value]);
    return;
  }
  ring.push(value);
  if (ring.length > 16) {
    ring.shift();
  }
}

const bridgeUpdateListener = EditorView.updateListener.of((update) => {
  bridges.get(update.view)?.handleUpdate(update);
});

// Shared, mount-independent extension set so cached EditorStates can be
// reattached to any EditorView instance.
const baseExtensions: Extension[] = [
  EditorState.allowMultipleSelections.of(true),
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
  drawSelection(),
  rectangularSelection(),
  EditorView.lineWrapping,
  history(),
  codeFolding(),
  foldGutter(),
  // codeLanguages enables nested syntax highlighting inside fenced code
  // blocks (```ts/```py/…); fences without a language stay plain.
  // cmMathMarkdown makes the grammar math-atomic (`$$` blocks / `$...$`
  // produce no markdown children) so lezer highlighting never styles math
  // content — see cm-live-preview.ts.
  markdown({ base: markdownLanguage, codeLanguages: languages, extensions: cmMathMarkdown }),
  createCmCompletionExtension(),
  cmMathHighlight,
  cmLivePreview,
  createCmAiInlineCompletionExtension(),
  cmKeymap,
  bridgeUpdateListener,
  createCmBaseTheme(),
  // Theme Compartment slot last so theme-specific rules win over the base
  // chrome layer; reconfigured by applyCmTheme (see cm-theme.ts).
  getCmThemeCompartmentExtension()
];

const editorStateCache = new Map<string, EditorState>();

function createEditorState(doc: string): EditorState {
  return EditorState.create({ doc, extensions: baseExtensions });
}

function handleViewUpdate(
  update: ViewUpdate,
  internals: CmEditorHandleInternals,
  propsRef: { current: CmEditorPropsRef }
) {
  if (update.docChanged) {
    recordEmission(update.view, update.state.doc.toString());
    for (const tr of update.transactions) {
      if (!tr.docChanged) {
        continue;
      }
      const docBefore = tr.startState.doc;
      const changes: EditorContentChange[] = [];
      let typedText = "";
      // iterChanges reports (fromA, toA) in the pre-transaction document,
      // matching Monaco's range/rangeOffset/rangeLength semantics.
      tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        changes.push({
          range: rangeFromOffsets(docBefore, fromA, toA),
          rangeLength: toA - fromA,
          rangeOffset: fromA,
          text: inserted.toString()
        });
        typedText += inserted.toString();
      });
      // iterChanges walks ascending; Monaco emits changes in descending
      // rangeOffset order.
      changes.reverse();
      internals.emitContentChanged({ changes });
      if (tr.isUserEvent("input.type")) {
        internals.emitType(typedText);
      }
    }

    // Mirror the Monaco wrapper: when an incremental handler is provided it
    // (and only it) is wired; otherwise plain onChange receives the value.
    if (!propsRef.current.onModelContentChange) {
      propsRef.current.onChange(update.state.doc.toString());
    }
  }

  const previousMain = update.startState.selection.main;
  const nextMain = update.state.selection.main;
  if (previousMain.anchor !== nextMain.anchor || previousMain.head !== nextMain.head) {
    internals.emitCursorPositionChanged();
  }
}

export function CmMarkdownEditor({
  onChange,
  onModelContentChange,
  onMount,
  path,
  value
}: CmMarkdownEditorProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const bundleRef = useRef<CmEditorHandleBundle | null>(null);
  const currentPathRef = useRef(path);
  const mountedRef = useRef(false);
  const propsRef = useRef<CmEditorPropsRef>({ onChange, onModelContentChange, value });

  // Keep latest props visible to the (mount-independent) CM event bridge.
  useEffect(() => {
    propsRef.current = { onChange, onModelContentChange, value };
  });

  // Mount once per React key (host keys by editorKey ?? `${path}:${language}`,
  // like the Monaco wrapper). The view outlives path prop changes, which are
  // handled by swapping EditorStates below.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    mountedRef.current = true;

    const cachedState = editorStateCache.get(path);
    const view = new EditorView({
      parent: container,
      state: cachedState ?? createEditorState(propsRef.current.value)
    });
    // Guard every dispatch against torn-down views: React StrictMode dev
    // double-mount (and any remount) destroys views while @lezer's parse
    // worker may still hold them — now genuinely async since nested
    // `codeLanguages` load dynamically — and CM's worker dispatch path does
    // not check `destroyed`, so a late completion would crash inside
    // EditorView.update with `inputState` already torn down.
    const dispatch = view.dispatch.bind(view) as (...args: unknown[]) => void;
    view.dispatch = ((...args: unknown[]) => {
      if ((view as unknown as { inputState?: unknown }).inputState === undefined) {
        console.debug("[cm-editor] dropped dispatch on a torn-down view");
        return;
      }
      dispatch(...args);
    }) as EditorView["dispatch"];
    viewRef.current = view;
    currentPathRef.current = path;

    const bundle = createCmEditorHandle(() => viewRef.current);
    bundleRef.current = bundle;

    bridges.set(view, {
      handleUpdate: (update) => {
        // setState-driven updates (path switch restore) carry no transactions
        // and must not emit content/selection events.
        if (!mountedRef.current || update.transactions.length === 0) {
          return;
        }
        handleViewUpdate(update, bundle.internals, propsRef);
      }
    });

    const modelContentDisposable = propsRef.current.onModelContentChange
      ? bundle.handle.onDidChangeModelContent((event) => {
          propsRef.current.onModelContentChange?.(event);
        })
      : null;

    onMount(bundle.handle, createCmEngineServices());

    // Live views participate in workbench theme switches (applyCmTheme).
    const unregisterThemeView = registerCmThemeView(view);
    // Fresh EditorStates start from the module-load-time base theme; sync to
    // the workbench theme active right now.
    syncCmThemeToView(view);

    // Equivalent of Monaco's automaticLayout: re-measure on container resize.
    const resizeObserver = new ResizeObserver(() => {
      viewRef.current?.requestMeasure();
    });
    resizeObserver.observe(container);

    return () => {
      mountedRef.current = false;
      resizeObserver.disconnect();
      unregisterThemeView();
      cancelAiGhostRequest(view);
      modelContentDisposable?.dispose();
      // Park the live state under its path so a later mount (or path switch)
      // restores content, undo history and selection.
      editorStateCache.set(currentPathRef.current, view.state);
      bridges.delete(view);
      bundle.internals.notifyDisposed();
      view.destroy();
      viewRef.current = null;
      bundleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-once by design (React key controls remounts)
  }, []);

  // Document switch without a remount: park the current state under the old
  // path, restore or create the new path's state.
  useEffect(() => {
    const view = viewRef.current;
    const bundle = bundleRef.current;
    if (!view || !bundle || path === currentPathRef.current) {
      return;
    }

    editorStateCache.set(currentPathRef.current, view.state);
    const cachedState = editorStateCache.get(path);
    view.setState(cachedState ?? createEditorState(propsRef.current.value));
    // Parked states keep the theme active at park time; re-sync with the
    // current workbench theme on restore.
    syncCmThemeToView(view);
    currentPathRef.current = path;
    bundle.internals.notifyModelChanged();
  }, [path]);

  // Controlled value sync: external value changes replace the full document
  // with a single mapped change (undo history preserved, selection mapped,
  // scroll untouched). Self-edit loops converge because onChange reports every
  // internal change, making value === current doc. Values we emitted ourselves
  // (recentEmissions) are stale echoes from the lagging draft pipeline — the
  // parent catches up on its next flush, so they must never clobber the doc.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) {
      return;
    }
    const currentValue = view.state.doc.toString();
    if (value === currentValue || recentEmissions.get(view)?.includes(value)) {
      return;
    }
    const changeSet = view.state.changes({ from: 0, to: currentValue.length, insert: value });
    view.dispatch({
      changes: changeSet,
      selection: view.state.selection.map(changeSet, 1)
    });
  }, [value]);

  return <div className="cm-editor-host" ref={containerRef} />;
}
