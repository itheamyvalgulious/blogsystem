import type { ArticleSummary, MarkdownBlockConfig } from "@blog-system/content-core";

import type { MarkdownFenceRendererFeatureDefinition, NormalizedSnippet, WorkbenchDocument } from "../types";

/**
 * Module-level data feed for the CodeMirror completion source.
 *
 * The Monaco completion provider closes over React state (active document,
 * normalized snippets, article summaries) at registration time; the CM
 * autocompletion source lives in shared, mount-independent extensions and
 * therefore cannot close over hooks. Instead the workbench integration hook
 * pushes the same data here whenever it changes (mirroring the timing of the
 * Monaco provider's effect dependencies), and the source reads it lazily at
 * query time.
 *
 * No monaco imports: this module must stay loadable in Node test runs.
 */
export interface WorkbenchCompletionContext {
  activeDocument: WorkbenchDocument | null;
  articleSummaries: ArticleSummary[];
  latexSnippets: NormalizedSnippet[];
  markdownSnippets: NormalizedSnippet[];
}

const EMPTY_COMPLETION_CONTEXT: WorkbenchCompletionContext = {
  activeDocument: null,
  articleSummaries: [],
  latexSnippets: [],
  markdownSnippets: []
};

let currentContext: WorkbenchCompletionContext = EMPTY_COMPLETION_CONTEXT;

export function setWorkbenchCompletionContext(context: WorkbenchCompletionContext): void {
  currentContext = context;
}

export function getWorkbenchCompletionContext(): WorkbenchCompletionContext {
  return currentContext;
}

/**
 * Module-level data feed for the CM live preview (cm-live-preview.ts), same
 * pattern as the completion context above: App.tsx pushes the active
 * document's article directory (for image URL resolution), the active fence
 * renderers and the markdown block config whenever they change; decorations
 * and widgets read them lazily at build/render time.
 */
export interface WorkbenchLivePreviewContext {
  /** Directory used to resolve relative image srcs; null disables them. */
  articleDirectory: string | null;
  fenceRenderers: MarkdownFenceRendererFeatureDefinition[];
  markdownBlockConfig: MarkdownBlockConfig | null;
}

const EMPTY_LIVE_PREVIEW_CONTEXT: WorkbenchLivePreviewContext = {
  articleDirectory: null,
  fenceRenderers: [],
  markdownBlockConfig: null
};

let currentLivePreviewContext: WorkbenchLivePreviewContext = EMPTY_LIVE_PREVIEW_CONTEXT;

type WorkbenchLivePreviewContextListener = () => void;

const livePreviewContextListeners = new Set<WorkbenchLivePreviewContextListener>();

/**
 * Registers a callback fired whenever the live preview context is replaced.
 * cm-live-preview uses this to dispatch a refresh to live editor views (a
 * context change alone produces no CM transaction to hang a rebuild on).
 */
export function onWorkbenchLivePreviewContextChange(listener: WorkbenchLivePreviewContextListener): void {
  livePreviewContextListeners.add(listener);
}

export function setWorkbenchLivePreviewContext(context: WorkbenchLivePreviewContext): void {
  currentLivePreviewContext = context;
  for (const listener of livePreviewContextListeners) {
    listener();
  }
}

export function getWorkbenchLivePreviewContext(): WorkbenchLivePreviewContext {
  return currentLivePreviewContext;
}
