import type { Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

import { getWorkbenchLivePreviewContext } from "./cm-context";
import { getReadingMode } from "./cm-reading-mode";
import {
  createBlockPreviewWidget,
  getLivePreviewDocumentScan,
  getLivePreviewWidgetSalt,
  isLivePreviewRangeInZone,
  jumpProviderForRange,
  livePreviewBelowKeysField,
  livePreviewDecorationsField,
  livePreviewFailedRenderHashesField,
  reportLivePreviewBelowKeys,
  reportLivePreviewFloatMode,
  type LivePreviewRange
} from "./cm-live-preview";
import { attachPreviewJumpHandlers } from "./cm-live-preview-widgets";

/**
 * Floating preview overlay for the CM live preview (see cm-live-preview.ts).
 *
 * When the editor content width is >= FLOAT_MODE_MIN_WIDTH, block previews
 * ($$ blocks, tables, fenced code, image rows) render as absolutely
 * positioned panels HUGGING the right edge of their own code block. The
 * per-block fit is DUAL-INPUT (computeLivePreviewFloatFit): the code's right
 * edge AND the preview content's natural width — a block floats only when
 * its content fits whole in the remaining space, at exactly its natural
 * width (no hard cap, no horizontal scrollbar, nothing cut off); otherwise
 * THAT block falls back to the bare below-source preview via
 * livePreviewBelowKeysField (mixed float/below within one document is
 * normal; the below block keeps overflow-x: auto for extreme widths).
 * Natural widths are measured in the rAF pass from the unconstrained panel
 * and cached per content key, re-measured when async content mutates or an
 * image loads — one fit correction per content change. Inline-math rows are
 * never floated (per-formula bands under each formula's visual line).
 *
 * Vertical anchoring is center-to-center: the panel's vertical center
 * aligns with the source range's center (first-line top to last-line
 * bottom), i.e. top = rangeCenter - panelHeight/2, all measured in the
 * same rAF pass (layout reads are forbidden inside the CM update cycle —
 * this plugin never reads layout synchronously from update(); everything
 * goes through the rAF-coalesced relayout, plus scroll/ResizeObserver/
 * MutationObserver triggers). Overlapping panels are pushed down
 * (resolveLivePreviewFloatLayout) and then no longer centered (accepted).
 *
 * Panels reuse the exact widget instances (and their cached rendered
 * artifacts) from the below-source path via createBlockPreviewWidget — no
 * duplicated render logic. Panels are appended to view.dom (positioned
 * .cm-editor root) so .cm-scroller cannot clip them; z-index stays below
 * CM tooltips. Panel chrome is frameless, matching the bare previews.
 *
 * Import-cycle note: cm-live-preview.ts imports this module for the
 * extension array while this module imports helpers from it. ESM-safe
 * because every binding from cm-live-preview.ts is only touched inside
 * functions, never at module evaluation time.
 *
 * Known trade-offs (accepted): panels overlay the text beneath them —
 * clicks there hit the panel, not the source.
 *
 * No monaco imports: this module must stay loadable in Node test runs.
 */

export type LivePreviewLayoutMode = "below" | "float";

export const FLOAT_MODE_MIN_WIDTH = 960;
export const FLOAT_PANEL_MIN_WIDTH = 280;
export const FLOAT_PANEL_MAX_WIDTH = 480;
export const FLOAT_PANEL_MARGIN = 16;
/** Extra doc offsets around the viewport that still get a panel. */
const FLOAT_VIEWPORT_BUFFER_CHARS = 1500;
/** Vertical spacing between stacked panels. */
const FLOAT_PANEL_GAP_PX = 8;

/** Width threshold → layout mode. Pure, unit-tested. */
export function resolveLivePreviewLayoutMode(contentWidth: number): LivePreviewLayoutMode {
  return contentWidth >= FLOAT_MODE_MIN_WIDTH ? "float" : "below";
}

export interface LivePreviewFloatFit {
  mode: "float" | "below";
  /** Panel left edge (same coordinate space as the inputs) when floating. */
  left: number;
  width: number;
}

/**
 * Pure per-block fit: `lineEndXs` are the visual x positions of the block's
 * source line ends (coordsAtPos(line.to).left); the panel hugs the code's
 * right edge at x + margin. The decision uses BOTH inputs:
 * - the code right edge — `available = contentRight − (x + margin +
 *   outerMargin)` must be >= minWidth, else "below" regardless of content;
 * - the preview content's NATURAL width `naturalW` (measured in the rAF
 *   pass from the unconstrained panel; see measureNaturalWidth) — the block
 *   floats ONLY when it fits whole (`naturalW <= available`, i.e.
 *   `x + 16 + naturalW + 16 <= contentRight`), at `width = naturalW`: no
 *   hard cap, no horizontal scrollbar, nothing cut off. Anything wider
 *   falls back to the full-width below preview (which keeps overflow-x:
 *   auto as the last-resort for extreme widths).
 * `naturalW` undefined = not measurable yet (panel just created / async
 * render pending): float provisionally at min(480, available); the measured
 * pass then corrects the width — or flips the block below, exactly once per
 * content change. Unit-tested.
 */
export function computeLivePreviewFloatFit(
  lineEndXs: number[],
  contentRight: number,
  naturalW?: number,
  margin = FLOAT_PANEL_MARGIN,
  outerMargin = FLOAT_PANEL_MARGIN,
  minWidth = FLOAT_PANEL_MIN_WIDTH
): LivePreviewFloatFit {
  const codeRight = lineEndXs.length > 0 ? Math.max(...lineEndXs) : 0;
  const available = contentRight - (codeRight + margin + outerMargin);
  if (available < minWidth) {
    return { mode: "below", left: 0, width: 0 };
  }
  if (naturalW === undefined) {
    return { mode: "float", left: codeRight + margin, width: Math.min(FLOAT_PANEL_MAX_WIDTH, available) };
  }
  if (naturalW > available) {
    return { mode: "below", left: 0, width: 0 };
  }
  return { mode: "float", left: codeRight + margin, width: naturalW };
}

export interface LivePreviewFloatAnchor {
  id: string;
  top: number;
  height: number;
}

export interface LivePreviewFloatPlacement {
  id: string;
  top: number;
}

/**
 * Pure anti-overlap layout: panels keep their anchor top unless they would
 * overlap an already-placed panel above, in which case they are pushed to
 * that panel's bottom + gap. Unit-tested.
 */
export function resolveLivePreviewFloatLayout(
  anchors: LivePreviewFloatAnchor[],
  gap = FLOAT_PANEL_GAP_PX
): LivePreviewFloatPlacement[] {
  const sorted = [...anchors].sort((a, b) => a.top - b.top);
  const placements: LivePreviewFloatPlacement[] = [];
  let bottom = Number.NEGATIVE_INFINITY;
  for (const anchor of sorted) {
    const top = Math.max(anchor.top, bottom + gap);
    placements.push({ id: anchor.id, top });
    bottom = top + anchor.height;
  }
  return placements;
}

// Floatable range kinds are the four block-preview kinds; the relayout loop
// narrows with explicit kind checks (a Set membership would not narrow the
// union for jumpProviderForRange).

interface FloatPanelEntry {
  panel: HTMLElement;
  from: number;
  to: number;
}

interface FloatCandidate {
  key: string;
  range: LivePreviewRange;
  entry: FloatPanelEntry;
}

/**
 * The float overlay extension, exposed through a hoisted getter (not a const)
 * so the cm-live-preview.ts ↔ this-module import cycle is safe in BOTH
 * evaluation orders: cm-live-preview.ts calls this while this module may
 * still be evaluating — hoisted function declarations are callable before
 * the module body runs, and everything the getter touches (ViewPlugin, the
 * plugin class, and the cm-live-preview.ts helpers used inside plugin
 * methods) is only resolved at call/runtime, never at module evaluation
 * time. Called exactly once (by the cmLivePreview extension array), so the
 * fresh instance per call is fine.
 */
export function getCmLivePreviewFloatExtension(): Extension {
  return ViewPlugin.fromClass(
    class {
      private readonly panels = new Map<string, FloatPanelEntry>();
      private floatMode = false;
      private readonly resizeObserver: ResizeObserver;
      private readonly mutationObserver: MutationObserver;
      private readonly onScroll: () => void;
      private layoutRaf = 0;
      private initTimer: ReturnType<typeof setTimeout> | null = null;
      /**
       * Preview content natural width per descriptor key (content-keyed, so
       * it survives position shifts, panel recreation and float/below mode
       * switches). Invalidated when the panel's content mutates or an image
       * inside finishes loading/erroring.
       */
      private readonly naturalWidths = new Map<string, number>();

      constructor(private readonly view: EditorView) {
        // CM timing rules honoured throughout this plugin:
        // - Plugins are constructed/updated INSIDE the CM update cycle, where
        //   layout reads (clientWidth, coordsAtPos, lineBlockAt) and dispatch
        //   are forbidden. The initial mode probe is therefore deferred to a
        //   timer (ResizeObserver callbacks are also async by nature).
        // - relayout() only runs via rAF (scheduleLayout), never
        //   synchronously from update().
        // - destroy() defers its report dispatch for the same reason
        //   (React StrictMode double-mount destroys views mid-cycle).
        this.resizeObserver = new ResizeObserver(() => this.refreshMode());
        this.resizeObserver.observe(view.scrollDOM);
        this.onScroll = () => this.scheduleLayout();
        view.scrollDOM.addEventListener("scroll", this.onScroll, { passive: true });
        // Async previews (tables/fences) fill their DOM after mount; follow
        // their growth so panel heights in the center/overlap passes stay
        // true AND the natural-width measurement is re-taken (one fit
        // correction per content change, see computeLivePreviewFloatFit).
        this.mutationObserver = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            for (const [key, entry] of this.panels) {
              if (entry.panel.contains(mutation.target as Node)) {
                this.naturalWidths.delete(key);
              }
            }
          }
          this.scheduleLayout();
        });
        this.mutationObserver.observe(view.dom, { childList: true, subtree: true });
        this.initTimer = setTimeout(() => {
          this.initTimer = null;
          this.refreshMode();
        }, 0);
      }

      update(update: ViewUpdate) {
        if (!this.floatMode) {
          return;
        }
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.geometryChanged ||
          update.state.field(livePreviewDecorationsField) !== update.startState.field(livePreviewDecorationsField)
        ) {
          this.scheduleLayout();
        }
      }

      destroy() {
        this.resizeObserver.disconnect();
        this.mutationObserver.disconnect();
        this.view.scrollDOM.removeEventListener("scroll", this.onScroll);
        if (this.layoutRaf) {
          cancelAnimationFrame(this.layoutRaf);
          this.layoutRaf = 0;
        }
        if (this.initTimer) {
          clearTimeout(this.initTimer);
          this.initTimer = null;
        }
        if (this.floatMode) {
          this.floatMode = false;
          // Deferred: destroy may run inside an update cycle (or while the
          // view is being torn down), where dispatch is forbidden.
          const view = this.view;
          setTimeout(() => {
            reportLivePreviewFloatMode(view, false);
            reportLivePreviewBelowKeys(view, new Set());
          }, 0);
        }
        this.clearPanels();
        this.naturalWidths.clear();
      }

      private contentWidth(): number {
        const gutters = this.view.scrollDOM.querySelector(".cm-gutters");
        return this.view.scrollDOM.clientWidth - (gutters?.getBoundingClientRect().width ?? 0);
      }

      /**
       * Natural (unconstrained) width of a panel's preview content, cached
       * per descriptor key. Measured inside the rAF relayout: the panel is
       * temporarily set to width: max-content while hidden and its
       * offsetWidth read back — the forced synchronous reflow is legal here
       * (a rAF callback, not the CM update cycle), and the intermediate
       * state is never painted (same frame). Pending async content measures
       * narrow and gets corrected on the mutation pass.
       */
      private measureNaturalWidth(key: string, entry: FloatPanelEntry): number {
        const cached = this.naturalWidths.get(key);
        if (cached !== undefined) {
          return cached;
        }
        const { panel } = entry;
        const previousVisibility = panel.style.visibility;
        panel.style.visibility = "hidden";
        panel.style.width = "max-content";
        // scrollWidth of the hosted content (integer, rounded UP): using the
        // panel's own offsetWidth can land 1-2px short of the content's
        // fractional width and recreate the very scrollbar this kills.
        const content = panel.firstElementChild as HTMLElement | null;
        const natural = Math.max(1, Math.ceil(content ? content.scrollWidth : panel.offsetWidth));
        panel.style.visibility = previousVisibility;
        // The fit pass sets the final width right after — do not restore the
        // old inline width here or the panel would flash its previous size.
        this.naturalWidths.set(key, natural);
        return natural;
      }

      private refreshMode(): void {
        const next = resolveLivePreviewLayoutMode(this.contentWidth()) === "float";
        if (next === this.floatMode) {
          return;
        }
        this.floatMode = next;
        // Report first: the decorations field rebuilds (mode in its salt)
        // and suppresses/restores the below widgets accordingly.
        reportLivePreviewFloatMode(this.view, next);
        if (next) {
          this.scheduleLayout();
        } else {
          this.clearPanels();
          // Outside the update cycle here (RO/timer callback) — safe.
          reportLivePreviewBelowKeys(this.view, new Set());
        }
      }

      private clearPanels(): void {
        for (const entry of this.panels.values()) {
          entry.panel.remove();
        }
        this.panels.clear();
        // Widths are content-keyed and stay valid across panel removals and
        // mode switches; only destroy() clears them.
      }

      private scheduleLayout(): void {
        if (!this.floatMode || this.layoutRaf) {
          return;
        }
        this.layoutRaf = requestAnimationFrame(() => {
          this.layoutRaf = 0;
          this.relayout();
        });
      }

      /**
       * The single positioning pass (rAF — layout reads and dispatch are
       * both legal here): per-block fit decision, panel membership,
       * center-to-center anchoring, anti-overlap, below-fallback reporting.
       */
      private relayout(): void {
        if (!this.floatMode || !this.view.dom.isConnected) {
          return;
        }

        const { state } = this.view;
        const context = getWorkbenchLivePreviewContext();
        const salt = getLivePreviewWidgetSalt();
        const failedHashes = state.field(livePreviewFailedRenderHashesField);
        const scan = getLivePreviewDocumentScan(state.doc);
        const reading = getReadingMode() === "read";

        const editorRect = this.view.dom.getBoundingClientRect();
        const contentRect = this.view.contentDOM.getBoundingClientRect();
        const contentRight = contentRect.right - editorRect.left;

        const viewportFrom = Math.max(0, this.view.viewport.from - FLOAT_VIEWPORT_BUFFER_CHARS);
        const viewportTo = Math.min(state.doc.length, this.view.viewport.to + FLOAT_VIEWPORT_BUFFER_CHARS);

        // 1. Fit decision per candidate range.
        const floatCandidates: FloatCandidate[] = [];
        const belowKeys = new Set<string>();
        for (const range of scan.ranges) {
          if (range.from > viewportTo) {
            break; // ranges are sorted by `from`
          }
          if (
            range.to < viewportFrom ||
            (range.kind !== "image" && range.kind !== "blockMath" && range.kind !== "table" && range.kind !== "fence")
          ) {
            continue; // not floatable (also narrows the union for the jump provider)
          }
          // Reading mode: constructs outside the cursor area are inline
          // replacements (no source) — no float panel, no below band.
          if (reading && !isLivePreviewRangeInZone(state, range)) {
            continue;
          }
          const jumpProvider = jumpProviderForRange(range, scan.lineStarts);
          const descriptor = createBlockPreviewWidget(range, context, salt, jumpProvider);
          if (!descriptor || failedHashes.has(descriptor.key)) {
            continue;
          }

          // Visual x of every source line end; the panel hugs the widest.
          // (Logical line ends — per the spec; wrapped final segments are
          // not probed individually.)
          const startLine = state.doc.lineAt(range.from).number;
          const endLine = state.doc.lineAt(range.to).number;
          const lineEndXs: number[] = [];
          for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
            const x = this.view.coordsAtPos(state.doc.line(lineNumber).to)?.left;
            if (x !== undefined) {
              lineEndXs.push(x - editorRect.left);
            }
          }

          let entry = this.panels.get(descriptor.key);
          if (!entry) {
            const panel = document.createElement("div");
            panel.className = "cm-lp-float";
            // Click-to-jump on the panel chrome; content clicks are handled
            // first by the hosted widget's own handlers, which
            // preventDefault — the shared helper then skips (defaultPrevented
            // check), so there is no double dispatch.
            attachPreviewJumpHandlers(panel, jumpProvider, () => this.view);
            // Images change the natural width when they finish loading or
            // error out (no DOM mutation for a successful load) — re-measure.
            const invalidate = () => {
              this.naturalWidths.delete(descriptor.key);
              this.scheduleLayout();
            };
            panel.addEventListener("load", invalidate, true);
            panel.addEventListener("error", invalidate, true);
            // toDOM builds a fresh node per call; the widget's rendered
            // artifacts (resolved async HTML) stay cached on the shared
            // instance.
            panel.appendChild(descriptor.widget.toDOM(this.view));
            this.view.dom.appendChild(panel);
            entry = { panel, from: range.from, to: range.to };
            this.panels.set(descriptor.key, entry);
          } else {
            entry.from = range.from;
            entry.to = range.to;
          }

          // Dual-input fit (see computeLivePreviewFloatFit): the code right
          // edge AND the preview content's natural width — a block floats
          // only when its content fits whole, at exactly that width.
          const naturalW = this.measureNaturalWidth(descriptor.key, entry);
          const fit = computeLivePreviewFloatFit(lineEndXs, contentRight, naturalW);
          if (fit.mode === "below") {
            belowKeys.add(descriptor.key);
            continue;
          }
          floatCandidates.push({ key: descriptor.key, range, entry });
          entry.panel.style.left = `${fit.left}px`;
          entry.panel.style.width = `${fit.width}px`;
        }

        // 2. Drop panels that are no longer candidates or fell back below.
        const wanted = new Set(floatCandidates.map((candidate) => candidate.key));
        for (const [key, entry] of this.panels) {
          if (!wanted.has(key)) {
            entry.panel.remove();
            this.panels.delete(key);
          }
        }

        // 3. Report below-fallback keys (decorations rebuild renders those
        // blocks' bare previews below the source).
        const currentBelowKeys = state.field(livePreviewBelowKeysField);
        if (belowKeys.size !== currentBelowKeys.size || [...belowKeys].some((key) => !currentBelowKeys.has(key))) {
          reportLivePreviewBelowKeys(this.view, belowKeys);
        }

        // 4. Center-to-center anchors + anti-overlap.
        // NOTE: view.documentTop is CLIENT-coordinate based
        // (contentDOM.getBoundingClientRect().top + paddingTop), whereas
        // style.top is relative to view.dom — subtract the editor's own top
        // offset or every panel lands ~one editorTop too low.
        const documentTopInEditor = this.view.documentTop - editorRect.top;
        const anchors: LivePreviewFloatAnchor[] = floatCandidates.map((candidate) => {
          const fromBlock = this.view.lineBlockAt(candidate.range.from);
          const toBlock = this.view.lineBlockAt(candidate.range.to);
          const rangeCenter = documentTopInEditor + (fromBlock.top + toBlock.bottom) / 2;
          const panelHeight = candidate.entry.panel.offsetHeight || 48;
          return { id: candidate.key, top: rangeCenter - panelHeight / 2, height: panelHeight };
        });
        for (const placement of resolveLivePreviewFloatLayout(anchors)) {
          const entry = this.panels.get(placement.id);
          if (entry) {
            entry.panel.style.top = `${placement.top}px`;
          }
        }
      }
    }
  );
}
