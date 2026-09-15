import { WidgetType, type EditorView, type Rect } from "@codemirror/view";
import katex from "katex";

import {
  highlightThemeCss,
  renderMarkdownFragmentWithKatex,
  rewriteManagedMediaUrls,
  rewriteRelativeAssetUrls
} from "@blog-system/content-core";

import { getWorkbenchLivePreviewContext } from "./cm-context";

/**
 * Widget DOM construction for the CM live preview (see cm-live-preview.ts).
 *
 * Every preview is rendered BELOW its source line(s) or, in float mode,
 * inside a floating panel (cm-live-preview-float.ts) — the source itself is
 * never hidden or replaced.
 *
 * Widget instances are cached module-wide by content key (bounded LRU):
 * `eq` compares the key so CM's decoration diffing leaves unchanged widgets
 * alone, and expensive render artifacts (resolved async HTML) live on the
 * instance. `toDOM` still builds a FRESH node per call — CM calls it once
 * per widget occurrence, so identical content at two locations (or the same
 * widget shown below-source and in a float panel) must produce independent
 * nodes; only the artifacts are shared.
 *
 * Async previews (tables, fences) go through
 * `renderMarkdownFragmentWithKatex` — the same controlled pipeline as the
 * preview pane — fill their panel on resolve and then call
 * `view.requestMeasure()` so CM picks up the new height. Input is never
 * blocked: the widget mounts with a placeholder first.
 *
 * No monaco imports: this module must stay loadable in Node test runs.
 */

export interface LivePreviewImageItem {
  alt: string;
  src: string;
}

export interface RichBlockWidgetOptions {
  kind: "table" | "fence";
  source: string;
  /** Called when async rendering fails for good (fence panels then hide). */
  onRenderFailure?: (view: EditorView) => void;
  /** Click-to-jump provider, see attachPreviewJumpHandlers. */
  jumpProvider?: PreviewJumpProvider | null;
}

const WIDGET_CACHE_LIMIT = 200;
const widgetCache = new Map<string, WidgetType>();

function cachedWidget<T extends WidgetType>(key: string, create: () => T): T {
  const cached = widgetCache.get(key);
  if (cached) {
    // LRU refresh: reinsert at the end.
    widgetCache.delete(key);
    widgetCache.set(key, cached);
    return cached as T;
  }

  const widget = create();
  widgetCache.set(key, widget);
  if (widgetCache.size > WIDGET_CACHE_LIMIT) {
    const excess = widgetCache.size - WIDGET_CACHE_LIMIT;
    let removed = 0;
    for (const oldestKey of widgetCache.keys()) {
      if (removed >= excess) {
        break;
      }
      widgetCache.delete(oldestKey);
      removed += 1;
    }
  }
  return widget;
}

const HIGHLIGHT_STYLE_ID = "cm-lp-hljs-theme";

/**
 * Injects the highlight.js theme used by the markdown pipeline
 * (rehype-highlight) into the document, once. The preview pane gets the same
 * CSS inside its shadow root (PREVIEW_SHADOW_BASE_CSS); editor-DOM widgets
 * need it at document level. `highlightThemeCss` is a static string with
 * hardcoded colors (not workbench-theme-dependent), so a single idempotent
 * injection is enough — no theme-switch refresh required.
 */
function ensureLivePreviewHighlightCss(): void {
  if (typeof document === "undefined" || document.getElementById(HIGHLIGHT_STYLE_ID)) {
    return;
  }
  const style = document.createElement("style");
  style.id = HIGHLIGHT_STYLE_ID;
  style.textContent = highlightThemeCss;
  document.head.appendChild(style);
}

abstract class CachedDomWidget extends WidgetType {
  constructor(readonly key: string) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof CachedDomWidget && other.constructor === this.constructor && other.key === this.key;
  }

  override toDOM(view: EditorView): HTMLElement {
    return this.buildDom(view);
  }

  protected abstract buildDom(view: EditorView): HTMLElement;
}

// --- Click-to-jump on previews (drag-select preserved) -----------------------

/** Drag threshold in pixels: mouse travel below this still counts as a click. */
export const PREVIEW_JUMP_DRAG_THRESHOLD_PX = 4;

/**
 * Resolves the click-to-jump target at gesture time. Receives the mounting
 * view and the widget root; lazy so stale offsets never survive — see
 * makeBlockPreviewJumpProvider in cm-live-preview.ts.
 */
export type PreviewJumpProvider = (view: EditorView, root: HTMLElement) => number | null;

/**
 * Pure click-vs-drag decision: true → the gesture is a click (jump). Squared
 * comparison, unit-tested.
 */
export function isPreviewJumpClick(dx: number, dy: number, threshold = PREVIEW_JUMP_DRAG_THRESHOLD_PX): boolean {
  return dx * dx + dy * dy < threshold * threshold;
}

/**
 * Attaches click-to-jump handling to a preview root: mousedown only RECORDS
 * the start point (never preventDefault — that would kill native text
 * selection, which is how users copy table/code content out of previews),
 * mouseup within the drag threshold dispatches `selection: {anchor}` and
 * focuses the editor; real drags are left alone. Interactive content
 * (links, buttons, inputs) is never intercepted. CM cannot race us with
 * posAtDOM: WidgetType.ignoreEvent defaults to true for every event, so the
 * editor ignores pointer activity inside previews entirely — these handlers
 * are the only consumers.
 */
export function attachPreviewJumpHandlers(
  root: HTMLElement,
  provider: PreviewJumpProvider | null,
  viewFor: () => EditorView | null
): void {
  let startX = -1;
  let startY = -1;
  root.addEventListener("mousedown", (event) => {
    startX = event.clientX;
    startY = event.clientY;
  });
  root.addEventListener("mouseup", (event) => {
    if (startX < 0 || event.defaultPrevented) {
      return;
    }
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    startX = -1;
    startY = -1;
    if (!isPreviewJumpClick(dx, dy)) {
      return;
    }
    const interactive = event.target instanceof Element ? event.target.closest("a, button, input, textarea, select") : null;
    if (interactive) {
      return;
    }
    const view = viewFor();
    const target = view && provider ? provider(view, root) : null;
    if (!view || target === null) {
      return;
    }
    event.preventDefault();
    view.dispatch({ selection: { anchor: target } });
    view.focus();
  });
}

/** Source offset + TeX for one inline formula; positions the preview box. */
export interface InlineMathFormulaBox {
  from: number;
  tex: string;
}

const INLINE_MATH_GAP_PX = 16;

// KaTeX HTML is content-pure: cache per tex so fresh widget instances (new
// source offsets, same content) never re-render.
const inlineMathHtmlCache = new Map<string, string>();

function inlineMathHtml(tex: string): string {
  let html = inlineMathHtmlCache.get(tex);
  if (html === undefined) {
    html = katex.renderToString(tex, { displayMode: false, throwOnError: false });
    if (inlineMathHtmlCache.size > 400) {
      inlineMathHtmlCache.clear();
    }
    inlineMathHtmlCache.set(tex, html);
  }
  return html;
}

/**
 * Pure layout for the inline-math band: each box wants its formula's source x
 * (idealLeft — may be NEGATIVE: the anchor span sits at the last formula's
 * end, so boxes extend left of it, which is correct with overflow: visible).
 * Boxes are placed left-to-right, never overlapping — a box is pushed right
 * of the previous box's right edge + gap when its ideal spot is taken.
 * Unit-tested.
 */
export function computeInlineMathFormulaLayout(
  boxes: Array<{ idealLeft: number; width: number }>,
  gap = INLINE_MATH_GAP_PX
): number[] {
  const lefts: number[] = [];
  let cursor = Number.NEGATIVE_INFINITY;
  for (const box of boxes) {
    const left = Math.max(box.idealLeft, cursor);
    lefts.push(left);
    cursor = left + box.width + gap;
  }
  return lefts;
}

/**
 * Inline-math preview band: an INLINE (non-block) widget anchored at the
 * natural wrap end of the formula group's visual row (see
 * resolveInlineMathBandAnchor — `side: -1`, i.e. just BEFORE the first
 * position of the following row). The row's DOM is an inline-level
 * full-width box (`display: inline-block; width: 100%`, see
 * .cm-lp-inline-math-row): it never fits the current line box's remaining
 * space, so CSS line breaking gives it a line box of its own directly under
 * the formula's visual segment and pushes the following text onto the next
 * line box (`ab$c$de` → `ab$c$` / band / `de`) — exactly the "new display
 * line between the two lines" the user wants, with no gutter line number
 * consumed (inline widgets never get one).
 *
 * R3 — do NOT turn this back into a block widget (`widget({block: true})`).
 * As a mid-line BLOCK widget CM's height map misplaced the line fragment
 * after the widget by one phantom line height, which made ArrowUp/Down skip
 * a row when crossing the band until the next full reload remeasured
 * everything. As inline content CM measures the row with the ordinary line
 * layout instead, and vertical cursor motion takes the native multi-segment
 * path. For the same reason there is no `estimatedHeight` override: that
 * value only feeds the block-widget height map, which no longer exists for
 * this widget.
 *
 * R4 — do NOT go back to a `side: 1` anchor at the wrap end. With side 1 the
 * boundary position resolved (assoc -1) to the PREVIOUS row's last
 * character, so vertical motion from below the band skipped the following
 * row and visually jumped the caret to the formula row's end. `side: -1`
 * plus the coordsAt override below keep every landing on the row the caret
 * is visually on.
 *
 * Boxes stay IN NORMAL FLOW (inline-block) so the row's natural height is
 * correct the moment CM measures it — an earlier absolute-position design
 * wrote min-height asynchronously, which left CM's height map out of sync
 * with the DOM (offsetHeight ~8 vs rendered ~29) and made vertical cursor
 * motion/posAtCoords land a row off. x alignment is done with per-box
 * margin-left (horizontal only, height-stable), measured via requestMeasure
 * read/write separation — layout reads are forbidden during the update
 * cycle (which includes toDOM/updateDOM).
 */
export class InlineMathRowWidget extends WidgetType {
  /** Latest mount's view (jump handlers dispatch to it); refreshed per mount. */
  private view: EditorView | null = null;

  constructor(
    readonly key: string,
    /** Per-box formula positions; box i jumps to formulas[i].from + 1. */
    readonly formulas: InlineMathFormulaBox[]
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof InlineMathRowWidget && other.key === this.key;
  }

  override toDOM(view: EditorView): HTMLElement {
    this.view = view;
    const row = document.createElement("div");
    row.className = "cm-lp-inline-math-row";
    row.setAttribute("contenteditable", "false");

    for (const formula of this.formulas) {
      const item = document.createElement("span");
      item.className = "cm-lp-inline-math";
      item.innerHTML = inlineMathHtml(formula.tex);
      // Click-to-jump per formula box: land right after the opening `$`.
      attachPreviewJumpHandlers(item, () => formula.from + 1, () => this.view);
      row.appendChild(item);
    }

    this.scheduleLayout(row, view);
    return row;
  }

  override updateDOM(dom: HTMLElement, view: EditorView, widget: WidgetType): boolean {
    // CM's widget reuse (view/dist findWidget, pass 1) only checks the
    // CONSTRUCTOR plus updateDOM's result — NOT eq. Returning true for a
    // widget with different content would keep the stale DOM. Only
    // same-content widgets may reuse; anything else must be rebuilt.
    if (!(widget instanceof InlineMathRowWidget) || widget.key !== this.key) {
      return false;
    }
    // The cached DOM keeps its listeners; refresh the view they dispatch to.
    this.view = view;
    this.scheduleLayout(dom, view);
    return true;
  }

  /**
   * Coordinates for positions resolving INTO the widget tile — the band
   * anchor offset (the decoration is registered `side: -1` on wrapped rows,
   * so "before the widget" landings arrive here with side < 0). The default
   * would return the full-width band rect, which draws the caret on the
   * preview row's far right edge; instead:
   * - BOTH side < 0 (End-like landings at the anchor) AND side >= 0 (e.g. the
   *   caret at end-of-line coinciding with the band anchor) → the caret
   *   renders at the END of the PRECEDING content (the formula row's last
   *   char) — exactly how CM draws a caret at a wrapped-line boundary. The
   *   old side>=0 band-left-edge behavior drew the caret on the band row
   *   while typing at end-of-line; the band row itself is never a caret
   *   destination.
   * - When there is no preceding sibling (headless / detached DOM) the
   *   band row's left edge is returned as a zero-width rect — this is the
   *   lesser evil vs. the default full-width rect.
   * Vertical cursor motion and clicks that approach the anchor from below
   * resolve with assoc +1 into the following text tile and never reach this
   * hook, so they keep landing on the next row's first character (the band
   * row itself is never a caret destination).
   *
   * The preceding content is measured with a raw DOM Range — the hook runs
   * inside CM's update/measure phases too, where `view.coordsAtPos` is
   * forbidden ("Reading the editor layout isn't allowed during an update").
   * The hook's `pos` argument is the offset INTO the widget (always 0 for
   * this zero-length widget), hence no doc position is needed here.
   */
  override coordsAt(dom: HTMLElement, _pos: number, _side: number): Rect | null {
    // A caret landing on the widget tile from either side belongs to the
    // source row (the band row itself is never a caret destination).
    let node: Node | null = dom.previousSibling;
    // CM inserts a zero-width buffer img between text and uneditable
    // widgets; the content end lives one node further back. (Duck-typed:
    // headless runs have no Element global and never reach the Range.)
    if (node && (node as Element).classList?.contains("cm-widgetBuffer")) {
      node = node.previousSibling;
    }
    if (node) {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.collapse(false);
      const rects = range.getClientRects();
      const last = rects.length > 0 ? rects[rects.length - 1] : null;
      if (last && last.bottom > last.top) {
        return { left: last.right, right: last.right, top: last.top, bottom: last.bottom };
      }
    }
    // Fallback: no preceding sibling (headless / detached DOM). Return the
    // band row's left edge as a zero-width rect instead of the default
    // full-width rect — see the class comment for why this is the lesser evil.
    const rect = dom.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      return null;
    }
    return { left: rect.left, right: rect.left, top: rect.top, bottom: rect.bottom };
  }

  private scheduleLayout(row: HTMLElement, view: EditorView): void {
    const items = Array.from(row.children) as HTMLElement[];
    const formulas = this.formulas;
    view.requestMeasure({
      read() {
        if (!row.isConnected) {
          return null;
        }
        return {
          rowLeft: row.getBoundingClientRect().left,
          ideals: formulas.map((formula) => view.coordsAtPos(formula.from + 1)?.left ?? null),
          widths: items.map((item) => item.offsetWidth)
        };
      },
      write(measured) {
        if (!measured) {
          return;
        }
        const boxes = formulas.map((formula, index) => ({
          idealLeft: Math.max(0, (measured.ideals[index] ?? measured.rowLeft) - measured.rowLeft),
          width: measured.widths[index] || Math.max(24, formula.tex.length * 8)
        }));
        const lefts = computeInlineMathFormulaLayout(boxes);
        // In-flow x alignment via margin-left (never affects row height):
        // walk the flow, setting each box's margin so its left edge lands on
        // its formula's x (lefts are monotonic with >= gap spacing by
        // construction of computeInlineMathFormulaLayout).
        let flowX = 0;
        items.forEach((item, index) => {
          const marginLeft = lefts[index] - flowX;
          item.style.marginLeft = `${marginLeft}px`;
          flowX = lefts[index] + boxes[index].width;
        });
      }
    });
  }
}

class ImageRowWidget extends CachedDomWidget {
  constructor(
    key: string,
    private readonly images: LivePreviewImageItem[],
    /** Click-to-jump provider (target: doc offset of `![`), exposed for tests. */
    readonly jumpProvider: PreviewJumpProvider | null = null
  ) {
    super(key);
  }

  protected buildDom(view: EditorView): HTMLElement {
    const row = document.createElement("div");
    row.className = "cm-lp-image-row";
    row.setAttribute("contenteditable", "false");
    attachPreviewJumpHandlers(row, this.jumpProvider, () => view);

    for (const image of this.images) {
      const element = document.createElement("img");
      element.className = "cm-lp-image";
      element.src = image.src;
      element.alt = image.alt;
      element.title = image.alt;
      element.addEventListener("error", () => {
        const placeholder = document.createElement("span");
        placeholder.className = "cm-lp-image-placeholder";
        placeholder.textContent = `Image failed to load: ${image.alt || image.src}`;
        element.replaceWith(placeholder);
        view.requestMeasure();
      });
      row.appendChild(element);
    }

    return row;
  }
}

function stripBlockMathDelimiters(source: string): string {
  return source.replace(/^\s*\$\$/, "").replace(/\$\$\s*$/, "");
}

class MathBlockWidget extends CachedDomWidget {
  constructor(
    key: string,
    private readonly source: string,
    /**
     * Click-to-jump provider: multi-line `$$` → line start below the opening
     * `$$` line; single-line `$$x$$` → right after the opening `$$`.
     * Exposed for tests.
     */
    readonly jumpProvider: PreviewJumpProvider | null = null
  ) {
    super(key);
  }

  protected buildDom(view: EditorView): HTMLElement {
    const panel = document.createElement("div");
    panel.className = "cm-lp-block cm-lp-block--math";
    panel.setAttribute("contenteditable", "false");
    attachPreviewJumpHandlers(panel, this.jumpProvider, () => view);

    const content = document.createElement("div");
    content.className = "cm-lp-block-content";
    // Synchronous: KaTeX renderToString does not block noticeably and the
    // widget itself is only instantiated inside the viewport.
    content.innerHTML = katex.renderToString(stripBlockMathDelimiters(this.source), {
      displayMode: true,
      throwOnError: false
    });
    panel.appendChild(content);
    return panel;
  }
}

class RichBlockWidget extends CachedDomWidget {
  /** Render artifacts shared across every node this widget mounts. */
  private renderedHtml: string | null = null;
  private renderFailed = false;
  private renderPending = false;
  /** Pending content elements (per mounted node), filled once on resolve. */
  private readonly pendingRoots = new Set<HTMLElement>();

  constructor(
    key: string,
    private readonly options: RichBlockWidgetOptions
  ) {
    super(key);
  }

  /** Click-to-jump provider from the options, exposed for tests. */
  get jumpProvider(): PreviewJumpProvider | null {
    return this.options.jumpProvider ?? null;
  }

  protected buildDom(view: EditorView): HTMLElement {
    const panel = document.createElement("div");
    panel.className = `cm-lp-block cm-lp-block--${this.options.kind}`;
    panel.setAttribute("contenteditable", "false");
    attachPreviewJumpHandlers(panel, this.jumpProvider, () => view);

    const content = document.createElement("div");
    content.className = "cm-lp-block-content";
    panel.appendChild(content);

    if (this.renderedHtml !== null) {
      content.innerHTML = this.renderedHtml;
    } else if (this.renderFailed) {
      this.fillFailure(content);
    } else {
      content.classList.add("cm-lp-block-content--pending");
      content.textContent = "Rendering preview…";
      this.pendingRoots.add(content);
      this.startRender(view);
    }

    return panel;
  }

  private startRender(view: EditorView): void {
    if (this.renderPending) {
      return;
    }
    this.renderPending = true;
    ensureLivePreviewHighlightCss();
    void this.renderPreview(view);
  }

  private async renderPreview(view: EditorView): Promise<void> {
    const context = getWorkbenchLivePreviewContext();
    const render = async (blockConfig: typeof context.markdownBlockConfig) => {
      const html = await renderMarkdownFragmentWithKatex(
        this.options.source,
        blockConfig,
        context.fenceRenderers
      );
      // Same URL rewriting as the preview pane (use-preview-sync.ts).
      return rewriteManagedMediaUrls(
        rewriteRelativeAssetUrls(html, context.articleDirectory ?? "", "/content-files"),
        "/media"
      );
    };

    let html: string;
    try {
      html = await render(context.markdownBlockConfig);
    } catch {
      try {
        // A broken block config must not kill the preview (mirrors the
        // preview pane fallback in use-preview-sync.ts).
        html = await render(null);
      } catch {
        this.handleRenderFailure(view);
        return;
      }
    }

    this.renderedHtml = html;
    for (const root of this.pendingRoots) {
      if (root.isConnected) {
        root.classList.remove("cm-lp-block-content--pending");
        root.innerHTML = html;
      }
    }
    this.pendingRoots.clear();
    view.requestMeasure();
  }

  private handleRenderFailure(view: EditorView): void {
    this.renderFailed = true;
    if (this.options.kind === "fence" && this.options.onRenderFailure) {
      // Hide the panel entirely (the hash lands in a StateField and the
      // decoration is skipped from then on); the source stays untouched.
      this.options.onRenderFailure(view);
      return;
    }
    for (const root of this.pendingRoots) {
      if (root.isConnected) {
        this.fillFailure(root);
      }
    }
    this.pendingRoots.clear();
    view.requestMeasure();
  }

  private fillFailure(content: HTMLElement): void {
    content.classList.remove("cm-lp-block-content--pending");
    content.classList.add("cm-lp-block-content--error");
    content.textContent = "Preview failed to render.";
  }
}

/**
 * Reading-mode inline replacement: a formula's source `$...$` is replaced
 * in the text flow by its KaTeX rendering (see cm-live-preview.ts — outside
 * the cursor zone the source is hidden). Fresh instance per occurrence; eq
 * compares content keys so CM's diffing reuses the DOM.
 */
class InlineMathReplaceWidget extends WidgetType {
  constructor(
    readonly key: string,
    private readonly tex: string,
    /** Click-to-jump target (formula from + 1), exposed for tests. */
    readonly jumpTarget: number | null = null
  ) {
    super();
  }

  override eq(other: WidgetType): boolean {
    return other instanceof InlineMathReplaceWidget && other.key === this.key;
  }

  override toDOM(view: EditorView): HTMLElement {
    const item = document.createElement("span");
    item.className = "cm-lp-inline-math cm-lp-inline-math--replaced";
    item.setAttribute("contenteditable", "false");
    item.innerHTML = inlineMathHtml(this.tex);
    attachPreviewJumpHandlers(item, () => this.jumpTarget, () => view);
    return item;
  }
}

export function createInlineMathReplaceWidget(key: string, tex: string, jumpTarget?: number): WidgetType {
  return new InlineMathReplaceWidget(key, tex, jumpTarget ?? null);
}

export function createInlineMathRowWidget(key: string, formulas: InlineMathFormulaBox[]): WidgetType {
  // No instance cache: positions derive from source offsets, so each
  // decorations build gets a fresh instance and CM's eq/updateDOM path
  // re-measures x positions in place (KaTeX HTML stays cached per tex).
  return new InlineMathRowWidget(key, formulas);
}

export function createImageRowWidget(
  key: string,
  images: LivePreviewImageItem[],
  jumpProvider?: PreviewJumpProvider | null
): WidgetType {
  return cachedWidget(key, () => new ImageRowWidget(key, images, jumpProvider ?? null));
}

export function createMathBlockWidget(key: string, source: string, jumpProvider?: PreviewJumpProvider | null): WidgetType {
  return cachedWidget(key, () => new MathBlockWidget(key, source, jumpProvider ?? null));
}

export function createRichBlockWidget(key: string, options: RichBlockWidgetOptions): WidgetType {
  return cachedWidget(key, () => new RichBlockWidget(key, options));
}
