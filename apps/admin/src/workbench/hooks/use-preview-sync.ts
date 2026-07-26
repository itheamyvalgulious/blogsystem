import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { WorkbenchEditorHandle } from "../editor-engine";

import {
  renderMarkdownFragmentWithKatex,
  rewriteManagedMediaTextReferences,
  rewriteManagedMediaUrls,
  rewriteRelativeAssetUrls
} from "@blog-system/content-core";
import type { MarkdownBlockConfigPayload } from "../../api";
import type { PluginRuntime } from "../plugin-runtime";
import {
  buildPreviewRootCompatCss,
  findPreviewAnchorElement,
  findPreviewBlockByLine,
  parsePreviewBlocks,
  parsePreviewSourceForDocument,
  PREVIEW_SHADOW_BASE_CSS,
  type ParsedPreviewBlock,
  type RenderedPreviewBlock
} from "../preview-utils";
import type {
  MarkdownFenceRendererFeatureDefinition,
  RevealLineOptions,
  WorkbenchDocument
} from "../types";

const PREVIEW_UPDATE_DEBOUNCE_MS = 50;
const DRAFT_VALUE_SYNC_DEBOUNCE_MS = 50;

interface PreviewSyncOptions {
  activeDocument: WorkbenchDocument | null;
  activeDocumentSupportsPreview: boolean;
  activePreviewFenceRenderers: MarkdownFenceRendererFeatureDefinition[];
  draftValuesRef: RefObject<Record<string, string>>;
  editorReadyVersion: number;
  editorRef: RefObject<WorkbenchEditorHandle | null>;
  jumpToActiveArticleLine: (lineNumber: number, options?: RevealLineOptions) => void;
  markdownBlockConfigPayload: MarkdownBlockConfigPayload | null;
  pluginRuntime: PluginRuntime;
  previewPaneVisible: boolean;
  previewThemeCssAssets: Array<{ assetPath: string }>;
  previewThemeScriptAssets: Array<{ assetPath: string }>;
  renderStyleAssetVersion: number;
  setPageError: Dispatch<SetStateAction<string | null>>;
}

export function usePreviewSync({
  activeDocument,
  activeDocumentSupportsPreview,
  activePreviewFenceRenderers,
  draftValuesRef,
  editorReadyVersion,
  editorRef,
  jumpToActiveArticleLine,
  markdownBlockConfigPayload,
  pluginRuntime,
  previewPaneVisible,
  previewThemeCssAssets,
  previewThemeScriptAssets,
  renderStyleAssetVersion,
  setPageError
}: PreviewSyncOptions) {
  const [previewSourceText, setPreviewSourceText] = useState("");
  const [previewReadyVersion, setPreviewReadyVersion] = useState(0);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const previewShadowHeadRef = useRef<HTMLDivElement | null>(null);
  const previewProseRef = useRef<HTMLDivElement | null>(null);
  const previewBlocksRef = useRef<RenderedPreviewBlock[]>([]);
  const previewBlockIdRef = useRef(0);
  const previewCursorSyncRafRef = useRef<number | null>(null);
  const schedulePreviewCursorSyncRef = useRef<(() => void) | null>(null);
  const suppressPreviewFollowFromEditorScrollRef = useRef(false);
  const previewUpdateTimerRef = useRef<number | null>(null);
  const previewRenderRequestRef = useRef(0);
  const lastPreviewCursorSyncLineRef = useRef<number | null>(null);

  const attachPreviewRef = useCallback((node: HTMLDivElement | null) => {
    previewRef.current = node;
    setPreviewReadyVersion((current) => current + 1);
  }, []);

  const attachPreviewSurfaceRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) {
      previewShadowHeadRef.current = null;
      previewProseRef.current = null;
      previewBlocksRef.current = [];
      setPreviewReadyVersion((current) => current + 1);
      return;
    }

    const shadowRoot = node.shadowRoot ?? node.attachShadow({ mode: "open" });
    const baseStyle = document.createElement("style");
    baseStyle.textContent = PREVIEW_SHADOW_BASE_CSS;

    const externalStylesHost = document.createElement("div");
    const htmlElement = document.createElement("html");
    const bodyElement = document.createElement("body");
    const proseElement = document.createElement("div");
    proseElement.className = "prose preview-prose";
    bodyElement.appendChild(proseElement);
    htmlElement.appendChild(bodyElement);

    shadowRoot.replaceChildren(baseStyle, externalStylesHost, htmlElement);
    previewShadowHeadRef.current = externalStylesHost;
    previewProseRef.current = proseElement;
    previewBlocksRef.current = [];
    setPreviewReadyVersion((current) => current + 1);
  }, []);

  const schedulePreviewSourceUpdate = useCallback((nextValue: string, options?: { immediate?: boolean }) => {
    if (previewUpdateTimerRef.current !== null) {
      window.clearTimeout(previewUpdateTimerRef.current);
      previewUpdateTimerRef.current = null;
    }

    if (options?.immediate) {
      setPreviewSourceText(nextValue);
      return;
    }

    previewUpdateTimerRef.current = window.setTimeout(() => {
      setPreviewSourceText(nextValue);
      previewUpdateTimerRef.current = null;
    }, PREVIEW_UPDATE_DEBOUNCE_MS);
  }, []);

  const scheduleDocumentPreviewUpdate = useCallback(
    (document: WorkbenchDocument, nextValue: string, options?: { immediate?: boolean }) => {
      if (!previewPaneVisible) {
        return;
      }

      const update = () => {
        const contribution = pluginRuntime.getEditorContribution(document.editorId);
        if (!contribution?.supportsPreview) {
          schedulePreviewSourceUpdate("", { immediate: true });
          return;
        }

        const nextPreviewBody = contribution.previewSource?.(document, nextValue);
        schedulePreviewSourceUpdate(
          typeof nextPreviewBody === "string" ? nextPreviewBody : "",
          { immediate: true }
        );
      };

      if (previewUpdateTimerRef.current !== null) {
        window.clearTimeout(previewUpdateTimerRef.current);
        previewUpdateTimerRef.current = null;
      }

      if (options?.immediate) {
        update();
        return;
      }

      previewUpdateTimerRef.current = window.setTimeout(() => {
        previewUpdateTimerRef.current = null;
        update();
      }, DRAFT_VALUE_SYNC_DEBOUNCE_MS);
    },
    [pluginRuntime, previewPaneVisible, schedulePreviewSourceUpdate]
  );

  useEffect(() => {
    const previewShadowHead = previewShadowHeadRef.current;

    if (!previewShadowHead) {
      return;
    }

    let cancelled = false;
    const nextLinks = previewThemeCssAssets.map((asset) => {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = `/theme-files/${asset.assetPath
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/")}?v=${renderStyleAssetVersion}`;
      link.dataset.renderStyleDirectory = asset.assetPath;
      return link;
    });
    previewShadowHead.replaceChildren(...nextLinks);

    void Promise.all(
      previewThemeCssAssets.map(async (asset) => {
        const href = `/theme-files/${asset.assetPath
          .split("/")
          .filter(Boolean)
          .map((segment) => encodeURIComponent(segment))
          .join("/")}?v=${renderStyleAssetVersion}`;
        const response = await fetch(href, { credentials: "include" });
        const cssText = rewriteManagedMediaTextReferences(await response.text(), "/media");
        const styleElement = document.createElement("style");
        styleElement.dataset.renderStyleRootCompat = asset.assetPath;
        styleElement.textContent = buildPreviewRootCompatCss(cssText);
        return styleElement;
      })
    )
      .then((compatStyles) => {
        if (cancelled || previewShadowHeadRef.current !== previewShadowHead) {
          return;
        }
        const scriptElements = previewThemeScriptAssets.map((asset) => {
          const script = document.createElement("script");
          script.type = "module";
          script.dataset.themePreviewScript = asset.assetPath;
          return fetch(
            `/theme-files/${asset.assetPath
              .split("/")
              .filter(Boolean)
              .map((segment) => encodeURIComponent(segment))
              .join("/")}?v=${renderStyleAssetVersion}`,
            { credentials: "include" }
          )
            .then((response) => response.text())
            .then((code) => {
              script.textContent = `const previewHost = document.querySelector('.preview-shadow-host'); const previewRoot = previewHost?.shadowRoot ?? null; const previewProse = previewRoot?.querySelector('.preview-prose') ?? null; const previewApi = { previewHost, previewRoot, previewProse }; ${rewriteManagedMediaTextReferences(code, "/media")}`;
              return script;
            });
        });

        return Promise.all(scriptElements).then((resolvedScripts) => {
          if (cancelled || previewShadowHeadRef.current !== previewShadowHead) {
            return;
          }

          previewShadowHead.replaceChildren(...nextLinks, ...compatStyles, ...resolvedScripts);
        });
      })
      .catch(() => {
        if (!cancelled && previewShadowHeadRef.current === previewShadowHead) {
          previewShadowHead.replaceChildren(...nextLinks);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [previewReadyVersion, previewThemeCssAssets, previewThemeScriptAssets, renderStyleAssetVersion]);

  useEffect(() => {
    queueMicrotask(() => {
      if (!previewPaneVisible || !activeDocument || !activeDocumentSupportsPreview) {
        schedulePreviewSourceUpdate("", { immediate: true });
        return;
      }

      const activeValue = draftValuesRef.current[activeDocument.id] ?? activeDocument.savedValue;
      scheduleDocumentPreviewUpdate(activeDocument, activeValue, { immediate: true });
    });
  }, [activeDocument?.id, activeDocumentSupportsPreview, previewPaneVisible, scheduleDocumentPreviewUpdate, schedulePreviewSourceUpdate]);

  useEffect(() => {
    if (!previewPaneVisible || !activeDocument || !activeDocumentSupportsPreview) {
      previewBlocksRef.current = [];
      return;
    }

    const previewRoot = previewProseRef.current;
    const requestId = previewRenderRequestRef.current + 1;
    previewRenderRequestRef.current = requestId;
    const parsedSource = parsePreviewSourceForDocument(activeDocument, previewSourceText);

    if (!previewRoot || !parsedSource) {
      previewRoot?.replaceChildren();
      previewBlocksRef.current = [];
      setPageError((current) => (current && current.includes("end of the stream") ? null : current));
      return;
    }

    let previewRenderError = parsedSource.frontmatterError;
    let renderBlockConfig = markdownBlockConfigPayload?.value ?? null;
    let nextBlocks: ParsedPreviewBlock[];

    try {
      nextBlocks = parsePreviewBlocks(parsedSource.body, renderBlockConfig);
    } catch (error) {
      previewRenderError = error instanceof Error ? error.message : String(error);
      renderBlockConfig = null;
      nextBlocks = parsePreviewBlocks(parsedSource.body, null);
    }

    const nextPreviewBlocks = nextBlocks.map((block) => ({
      ...block,
      startLine: block.startLine + parsedSource.lineOffset,
      endLine: block.endLine + parsedSource.lineOffset
    }));
    const currentBlocks = previewBlocksRef.current;

    let prefixLength = 0;
    while (
      prefixLength < currentBlocks.length &&
      prefixLength < nextPreviewBlocks.length &&
      currentBlocks[prefixLength].hash === nextPreviewBlocks[prefixLength].hash
    ) {
      prefixLength += 1;
    }

    let currentTailIndex = currentBlocks.length - 1;
    let nextTailIndex = nextPreviewBlocks.length - 1;
    while (
      currentTailIndex >= prefixLength &&
      nextTailIndex >= prefixLength &&
      currentBlocks[currentTailIndex].hash === nextPreviewBlocks[nextTailIndex].hash
    ) {
      currentTailIndex -= 1;
      nextTailIndex -= 1;
    }

    const changedBlocks = nextPreviewBlocks.slice(prefixLength, nextTailIndex + 1);

    Promise.all(
      changedBlocks.map(async (block) => {
        const html = await renderMarkdownFragmentWithKatex(
          block.source,
          renderBlockConfig,
          activePreviewFenceRenderers
        );
        return rewriteManagedMediaUrls(
          rewriteRelativeAssetUrls(html, parsedSource.directory, "/content-files"),
          "/media"
        );
      })
    )
      .then((changedHtmlBlocks) => {
        if (previewRenderRequestRef.current !== requestId || !previewProseRef.current) {
          return;
        }

        const nextRenderedBlocks: RenderedPreviewBlock[] = [];

        for (let index = 0; index < prefixLength; index += 1) {
          const previousBlock = currentBlocks[index];
          const nextBlock = nextPreviewBlocks[index];
          nextRenderedBlocks.push({
            ...previousBlock,
            hash: nextBlock.hash,
            startLine: nextBlock.startLine,
            endLine: nextBlock.endLine
          });
        }

        for (let index = 0; index < changedBlocks.length; index += 1) {
          const nextBlock = changedBlocks[index];
          previewBlockIdRef.current += 1;
          const element = document.createElement("section");
          element.className = "preview-block";
          element.dataset.previewBlockId = `preview-block-${previewBlockIdRef.current}`;
          element.innerHTML = changedHtmlBlocks[index];
          nextRenderedBlocks.push({
            id: element.dataset.previewBlockId ?? `preview-block-${previewBlockIdRef.current}`,
            hash: nextBlock.hash,
            startLine: nextBlock.startLine,
            endLine: nextBlock.endLine,
            element
          });
        }

        const nextSuffixStart = prefixLength + changedBlocks.length;
        const currentSuffixStart = currentTailIndex + 1;
        for (let nextIndex = nextSuffixStart; nextIndex < nextPreviewBlocks.length; nextIndex += 1) {
          const previousBlock = currentBlocks[currentSuffixStart + (nextIndex - nextSuffixStart)];
          const nextBlock = nextPreviewBlocks[nextIndex];

          if (!previousBlock) {
            continue;
          }

          nextRenderedBlocks.push({
            ...previousBlock,
            hash: nextBlock.hash,
            startLine: nextBlock.startLine,
            endLine: nextBlock.endLine
          });
        }

        const fragment = document.createDocumentFragment();
        for (const block of nextRenderedBlocks) {
          block.element.dataset.startLine = String(block.startLine);
          block.element.dataset.endLine = String(block.endLine);
          fragment.appendChild(block.element);
        }

        previewProseRef.current.replaceChildren(fragment);
        previewBlocksRef.current = nextRenderedBlocks;
        setPageError(previewRenderError);
        schedulePreviewCursorSyncRef.current?.();
      })
      .catch((error: Error) => {
        if (previewRenderRequestRef.current === requestId) {
          setPageError(error.message);
        }
      });
  }, [
    activeDocument?.id,
    activeDocument?.kind,
    activeDocumentSupportsPreview,
    activePreviewFenceRenderers,
    markdownBlockConfigPayload?.raw,
    previewPaneVisible,
    previewReadyVersion,
    previewSourceText
  ]);

  useEffect(() => {
    const editor = editorRef.current;
    const previewElement = previewRef.current;

    if (!editor || !previewElement || !activeDocumentSupportsPreview || !activeDocument) {
      schedulePreviewCursorSyncRef.current = null;
      return;
    }

    const isPreviewFollowSuppressed = () => suppressPreviewFollowFromEditorScrollRef.current;
    const clearPreviewFollowSuppression = () => {
      suppressPreviewFollowFromEditorScrollRef.current = false;
    };
    const editorDomNode = editor.getDomNode();

    const runCursorSync = (force = false) => {
      previewCursorSyncRafRef.current = null;

      const position = editor.getPosition();
      if (!position) {
        return;
      }
      if (!force && lastPreviewCursorSyncLineRef.current === position.lineNumber) {
        return;
      }
      lastPreviewCursorSyncLineRef.current = position.lineNumber;

      const block = findPreviewBlockByLine(previewBlocksRef.current, position.lineNumber);
      if (!block || !block.element.isConnected) {
        return;
      }

      const lineRatio =
        block.endLine <= block.startLine
          ? 0
          : (position.lineNumber - block.startLine) / (block.endLine - block.startLine);
      const anchorElement = findPreviewAnchorElement(block.element, lineRatio, previewElement.clientHeight);
      const currentScrollTop = previewElement.scrollTop;
      const previewBounds = previewElement.getBoundingClientRect();
      const anchorBounds = anchorElement.getBoundingClientRect();
      const anchorTop = anchorBounds.top - previewBounds.top + currentScrollTop;
      const anchorHeight = Math.max(anchorBounds.height, 1);
      const anchorBottom = anchorTop + anchorHeight;
      const viewportHeight = previewElement.clientHeight;
      const focusBandTop = currentScrollTop + viewportHeight * 0.25;
      const focusBandBottom = currentScrollTop + viewportHeight * 0.75;

      if (anchorBottom >= focusBandTop && anchorTop <= focusBandBottom) {
        return;
      }

      const desiredTop = anchorTop - viewportHeight * 0.18;
      const maxScrollTop = Math.max(previewElement.scrollHeight - viewportHeight, 0);
      previewElement.scrollTo({
        top: Math.min(maxScrollTop, Math.max(0, desiredTop)),
        behavior: "smooth"
      });
    };

    const scheduleCursorSync = (options?: { force?: boolean }) => {
      if (previewCursorSyncRafRef.current !== null) {
        return;
      }

      previewCursorSyncRafRef.current = window.requestAnimationFrame(() => runCursorSync(options?.force));
    };

    schedulePreviewCursorSyncRef.current = scheduleCursorSync;
    lastPreviewCursorSyncLineRef.current = null;

    const cursorDisposable = editor.onDidChangeCursorPosition(() => {
      const position = editor.getPosition();
      if (isPreviewFollowSuppressed()) {
        return;
      }
      if (position && lastPreviewCursorSyncLineRef.current === position.lineNumber) {
        return;
      }
      scheduleCursorSync();
    });
    const scrollDisposable = editor.onDidScrollChange((event) => {
      if (event.scrollTopChanged) {
        if (isPreviewFollowSuppressed()) {
          return;
        }
        scheduleCursorSync({ force: true });
      }
    });

    editorDomNode?.addEventListener("pointerdown", clearPreviewFollowSuppression, true);
    editorDomNode?.addEventListener("wheel", clearPreviewFollowSuppression, true);
    editorDomNode?.addEventListener("keydown", clearPreviewFollowSuppression, true);
    editorDomNode?.addEventListener("touchstart", clearPreviewFollowSuppression, true);

    scheduleCursorSync();

    return () => {
      schedulePreviewCursorSyncRef.current = null;
      cursorDisposable.dispose();
      scrollDisposable.dispose();
      editorDomNode?.removeEventListener("pointerdown", clearPreviewFollowSuppression, true);
      editorDomNode?.removeEventListener("wheel", clearPreviewFollowSuppression, true);
      editorDomNode?.removeEventListener("keydown", clearPreviewFollowSuppression, true);
      editorDomNode?.removeEventListener("touchstart", clearPreviewFollowSuppression, true);

      if (previewCursorSyncRafRef.current !== null) {
        window.cancelAnimationFrame(previewCursorSyncRafRef.current);
        previewCursorSyncRafRef.current = null;
      }
    };
  }, [activeDocument?.id, activeDocumentSupportsPreview, editorReadyVersion, previewReadyVersion]);

  useEffect(() => {
    const previewRoot = previewProseRef.current;

    if (!previewRoot || !activeDocumentSupportsPreview || !activeDocument) {
      return;
    }

    const handleDoubleClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }

      const blockElement = target.closest(".preview-block");
      if (!(blockElement instanceof HTMLElement)) {
        return;
      }

      const startLine = Number(blockElement.dataset.startLine);
      const endLine = Number(blockElement.dataset.endLine);
      if (!Number.isFinite(startLine) || !Number.isFinite(endLine)) {
        return;
      }

      const bounds = blockElement.getBoundingClientRect();
      const offsetY = Math.min(Math.max(event.clientY - bounds.top, 0), Math.max(bounds.height, 1));
      const ratio = bounds.height <= 0 ? 0 : offsetY / bounds.height;
      const lineSpan = Math.max(0, endLine - startLine);
      const targetLine = Math.max(
        startLine,
        Math.min(endLine, startLine + Math.round(lineSpan * ratio))
      );

      jumpToActiveArticleLine(targetLine, { focus: false, moveCursor: false });
    };

    previewRoot.addEventListener("dblclick", handleDoubleClick);
    return () => {
      previewRoot.removeEventListener("dblclick", handleDoubleClick);
    };
  }, [activeDocument, activeDocumentSupportsPreview, jumpToActiveArticleLine, previewReadyVersion]);

  return {
    attachPreviewRef,
    attachPreviewSurfaceRef,
    previewBlocksRef,
    previewCursorSyncRafRef,
    previewProseRef,
    previewUpdateTimerRef,
    scheduleDocumentPreviewUpdate,
    schedulePreviewCursorSyncRef,
    schedulePreviewSourceUpdate,
    suppressPreviewFollowFromEditorScrollRef
  };
}
