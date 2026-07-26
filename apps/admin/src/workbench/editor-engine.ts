/**
 * Engine-neutral editor interfaces for the workbench.
 *
 * The workbench talks to the mounted editor only through these types, so a
 * different editor engine can be adapted later without touching workbench
 * logic. All positions are 1-based and intentionally mirror the shape of the
 * corresponding Monaco concepts, which keeps the Monaco adapter a thin
 * passthrough and existing call sites unchanged.
 */

export interface EditorPosition {
  lineNumber: number;
  column: number;
}

export interface EditorRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface EditorSelection extends EditorRange {
  selectionStartLineNumber: number;
  selectionStartColumn: number;
  positionLineNumber: number;
  positionColumn: number;
  isEmpty(): boolean;
  getPosition(): EditorPosition;
  getStartPosition(): EditorPosition;
}

export interface EditorContentChange {
  range: EditorRange;
  rangeOffset: number;
  rangeLength: number;
  text: string;
}

export interface EditorContentChangedEvent {
  changes: EditorContentChange[];
}

export interface EditorScrollEvent {
  scrollTopChanged: boolean;
  scrollLeftChanged: boolean;
}

export interface EditorDisposable {
  dispose(): void;
}

export interface EditorEditOperation {
  range: EditorRange;
  text: string;
  forceMoveMarkers?: boolean;
}

export type EditorOptionId = "readOnly";

export const EditorOption: { readOnly: EditorOptionId } = {
  readOnly: "readOnly"
};

export interface RangeConstructor {
  new (
    startLineNumber: number,
    startColumn: number,
    endLineNumber: number,
    endColumn: number
  ): EditorRange;
}

export interface SelectionConstructor {
  new (
    selectionStartLineNumber: number,
    selectionStartColumn: number,
    positionLineNumber: number,
    positionColumn: number
  ): EditorSelection;
}

/**
 * Engine-scoped constructors and constants the workbench needs in order to
 * build editor values (ranges, selections, option ids) without importing the
 * underlying engine. Replaces the previous `typeof monacoEditor` passthrough.
 */
export interface EditorEngineServices {
  engine: "monaco" | "live";
  Range: RangeConstructor;
  Selection: SelectionConstructor;
  EditorOption: typeof EditorOption;
}

export interface WorkbenchTextModelHandle {
  getValue(): string;
  getLineCount(): number;
  getLineContent(lineNumber: number): string;
  getLineMaxColumn(lineNumber: number): number;
  getLineFirstNonWhitespaceColumn(lineNumber: number): number;
  getValueInRange(range: EditorRange): string;
  getOffsetAt(position: EditorPosition): number;
  getPositionAt(offset: number): EditorPosition;
  getFullModelRange(): EditorRange;
  getEOL(): string;
  findMatches(
    searchString: string,
    searchOnlyEditableRange: boolean,
    isRegex: boolean,
    matchCase: boolean,
    wordSeparators: string | null,
    captureMatches: boolean
  ): Array<{ range: EditorRange }>;
}

export interface SnippetControllerHandle {
  insert(template: string): void;
  isInSnippet(): boolean;
}

/**
 * Engine-reported feature state used to build keybinding when-contexts.
 * Optional: engines that cannot report a feature leave the workbench's
 * existing DOM-based detection in place (Monaco keeps its DOM queries).
 */
export interface EditorFeatureState {
  suggestWidgetVisible?: boolean;
}

export interface WorkbenchEditorHandle {
  getValue(): string;
  executeEdits(source: string, edits: EditorEditOperation[]): boolean;
  pushUndoStop(): void;
  trigger(source: string, commandId: string, args?: unknown): void;

  getPosition(): EditorPosition | null;
  setPosition(position: EditorPosition): void;
  getSelection(): EditorSelection | null;
  getSelections(): EditorSelection[] | null;
  setSelection(selection: EditorRange | EditorSelection): void;
  setSelections(selections: EditorSelection[]): void;

  getScrollTop(): number;
  getScrollLeft(): number;
  setScrollTop(value: number): void;
  setScrollLeft(value: number): void;
  revealLineInCenter(lineNumber: number): void;
  revealPosition(position: EditorPosition): void;

  onDidChangeModelContent(listener: (event: EditorContentChangedEvent) => void): EditorDisposable;
  onDidChangeCursorPosition(listener: () => void): EditorDisposable;
  onDidScrollChange(listener: (event: EditorScrollEvent) => void): EditorDisposable;
  onDidFocusEditorText(listener: () => void): EditorDisposable;
  onDidChangeModel(listener: () => void): EditorDisposable;
  onDidDispose(listener: () => void): EditorDisposable;
  onDidType(listener: (text: string) => void): EditorDisposable;

  getModel(): WorkbenchTextModelHandle | null;
  getDomNode(): HTMLElement | null;
  hasTextFocus(): boolean;
  focus(): void;
  getContribution(id: "snippetController2"): SnippetControllerHandle | null;
  getOption(option: EditorOptionId): boolean;
  getEditorFeatureState?(): EditorFeatureState;
}
