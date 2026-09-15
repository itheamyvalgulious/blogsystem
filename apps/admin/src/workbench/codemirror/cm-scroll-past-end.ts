import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";

/**
 * Bottom scroll space for the CM live-preview editor, sized to one editor
 * viewport: when fully scrolled down, the document's last line can align with
 * the top of the screen (the same contract as @codemirror/view's built-in
 * `scrollPastEnd()`, whose padding formula is mirrored below).
 *
 * Why the editor needs this: block previews (long `$$…$$` formulas, tables,
 * fences) render as widgets BELOW their source. Typing inside such a construct
 * transiently rebuilds/collapses the widget, so the document height shrinks
 * and, when nothing follows the construct, the browser clamps scrollTop —
 * the viewport jumps, then snaps back once the preview re-renders. A constant
 * one-viewport bottom blank keeps scrollTop valid across that cycle, so no
 * clamping (and no visible repositioning) can occur.
 *
 * Why not the built-in `scrollPastEnd()`: it unconditionally pads
 * `scrollDOM.clientHeight - one line`. That is only meaningful for a REAL
 * scroll container. Content-sized editors (auto-height scrollers — e.g. the
 * embedded project editors) always satisfy scroller height == content height;
 * padding there would grow the editor itself, which feeds the next
 * measurement (padding → taller content → taller scroller → more padding) and
 * diverges. This plugin therefore applies the identical padding only when the
 * scroller genuinely clips its content, detected from the values CM already
 * caches during its measure phase (no live layout reads in update()).
 */

/** Structural access to CM's per-view measurement cache (ViewState fields). */
interface CmViewStateInternals {
  /** scrollDOM.clientHeight, measured by CM's measure phase. */
  readonly editorHeight: number;
  /** contentDOM.getBoundingClientRect().height, measured by CM's measure phase. */
  readonly contentDOMHeight: number;
}

type EditorViewWithViewState = EditorView & { viewState: CmViewStateInternals };

export interface ScrollPastEndMeasurements {
  /** contentDOM.getBoundingClientRect().height (includes the content's own padding). */
  contentHeight: number;
  /** scrollDOM.clientHeight — the viewport the scroller actually clips to. */
  editorHeight: number;
  /** view.defaultLineHeight. */
  lineHeight: number;
  /** view.documentPadding.top. */
  paddingTop: number;
}

/**
 * Content-sized detection tolerance (px). An auto-height scroller satisfies
 * |content − scroller| ≈ 0 up to clientHeight rounding; a fixed-height editor
 * matches only when the content coincides with the viewport height, which is
 * a benign (and self-correcting) transient.
 */
const CONTENT_SIZED_TOLERANCE_PX = 1;

/**
 * Pure padding decision, unit-tested. Returns the padding-bottom in px for a
 * genuine scroll container, or null when no padding must be applied
 * (content-sized editor, or an editor shorter than one line).
 */
export function computeScrollPastEndPadding(
  measurements: ScrollPastEndMeasurements
): number | null {
  const { contentHeight, editorHeight, lineHeight, paddingTop } = measurements;
  if (Math.abs(contentHeight - editorHeight) <= CONTENT_SIZED_TOLERANCE_PX) {
    return null;
  }
  // Mirrors the built-in scrollPastEnd sizing: one viewport minus a line, so
  // every line — the last one included — can scroll up to the editor top.
  const padding = editorHeight - lineHeight - paddingTop - 0.5;
  return padding >= 0 ? padding : null;
}

const scrollPastEndPlugin = ViewPlugin.fromClass(
  class implements PluginValue {
    height = 0;
    attrs: Record<string, string> | null = null;

    update(update: ViewUpdate) {
      const view = update.view;
      const { editorHeight, contentDOMHeight } = (view as EditorViewWithViewState).viewState;
      const padding = computeScrollPastEndPadding({
        contentHeight: contentDOMHeight,
        editorHeight,
        lineHeight: view.defaultLineHeight,
        paddingTop: view.documentPadding.top
      });
      if (padding === null) {
        if (this.attrs !== null) {
          this.attrs = null;
          this.height = 0;
        }
        return;
      }
      if (padding !== this.height) {
        this.height = padding;
        this.attrs = { style: `padding-bottom: ${padding}px` };
      }
    }
  },
  {
    provide: (plugin) =>
      EditorView.contentAttributes.of((view) => view.plugin(plugin)?.attrs ?? null)
  }
);

/** Core scroll-past-end extension for the workbench CM editor. */
export const cmScrollPastEnd: Extension = scrollPastEndPlugin;
