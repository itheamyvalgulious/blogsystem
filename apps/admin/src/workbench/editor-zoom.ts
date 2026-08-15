export const EDITOR_ZOOM_STORAGE_KEY = "workbench.editorZoom";
export const DEFAULT_EDITOR_FONT_SIZE = 14;
export const MIN_EDITOR_FONT_SIZE = 10;
export const MAX_EDITOR_FONT_SIZE = 28;
export const EDITOR_FONT_SIZE_STEP = 1;

export type EditorZoomAction = "increase" | "decrease" | "reset";

export interface EditorZoomKeyInput {
  altKey?: boolean;
  code?: string;
  ctrlKey?: boolean;
  key: string;
  metaKey?: boolean;
}

export interface EditorZoomEvent extends EditorZoomKeyInput {
  preventDefault: () => void;
  stopPropagation?: () => void;
}

export interface EditorZoomStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export interface EditorZoomEventTarget {
  addEventListener: (type: "keydown", listener: (event: KeyboardEvent) => void) => void;
  removeEventListener: (type: "keydown", listener: (event: KeyboardEvent) => void) => void;
}

export interface EditorZoomTarget {
  getFontSize: () => number;
  setFontSize: (fontSize: number) => void;
}

/** Keeps editor text readable without changing the surrounding workbench layout. */
export function clampEditorFontSize(fontSize: number): number {
  if (!Number.isFinite(fontSize)) {
    return DEFAULT_EDITOR_FONT_SIZE;
  }

  return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, Math.round(fontSize)));
}

export function parseStoredEditorFontSize(rawValue: string | null | undefined): number {
  if (rawValue === null || rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_EDITOR_FONT_SIZE;
  }

  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? clampEditorFontSize(parsed) : DEFAULT_EDITOR_FONT_SIZE;
}

export function getEditorZoomAction(event: EditorZoomKeyInput): EditorZoomAction | null {
  if (event.altKey || (!event.ctrlKey && !event.metaKey)) {
    return null;
  }

  const key = event.key.toLowerCase();
  const code = event.code?.toLowerCase();

  if (key === "+" || key === "=" || key === "add" || code === "equal" || code === "numpadadd") {
    return "increase";
  }

  if (
    key === "-" ||
    key === "_" ||
    key === "subtract" ||
    code === "minus" ||
    code === "numpadsubtract"
  ) {
    return "decrease";
  }

  if (key === "0" || key === "numpad0" || code === "digit0" || code === "numpad0") {
    return "reset";
  }

  return null;
}

export function nextEditorFontSize(currentFontSize: number, action: EditorZoomAction): number {
  const current = clampEditorFontSize(currentFontSize);

  switch (action) {
    case "increase":
      return clampEditorFontSize(current + EDITOR_FONT_SIZE_STEP);
    case "decrease":
      return clampEditorFontSize(current - EDITOR_FONT_SIZE_STEP);
    case "reset":
      return DEFAULT_EDITOR_FONT_SIZE;
  }
}

function getBrowserStorage(): EditorZoomStorage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function resolveStorage(storage: EditorZoomStorage | null | undefined): EditorZoomStorage | null {
  return storage === undefined ? getBrowserStorage() : storage;
}

export function readEditorFontSize(storage?: EditorZoomStorage | null): number {
  const resolvedStorage = resolveStorage(storage);
  if (!resolvedStorage) {
    return DEFAULT_EDITOR_FONT_SIZE;
  }

  try {
    return parseStoredEditorFontSize(resolvedStorage.getItem(EDITOR_ZOOM_STORAGE_KEY));
  } catch {
    return DEFAULT_EDITOR_FONT_SIZE;
  }
}

export function persistEditorFontSize(
  fontSize: number,
  storage?: EditorZoomStorage | null
): number {
  const normalized = clampEditorFontSize(fontSize);
  const resolvedStorage = resolveStorage(storage);

  if (resolvedStorage) {
    try {
      resolvedStorage.setItem(EDITOR_ZOOM_STORAGE_KEY, String(normalized));
    } catch {
      // Storage can be unavailable in private browsing or when quota is full.
    }
  }

  return normalized;
}

export function handleEditorZoomKeydown(
  event: EditorZoomEvent,
  getCurrentFontSize: () => number,
  setFontSize: (fontSize: number) => void,
  storage?: EditorZoomStorage | null
): boolean {
  const action = getEditorZoomAction(event);
  if (!action) {
    return false;
  }

  event.preventDefault();
  event.stopPropagation?.();

  const nextFontSize = nextEditorFontSize(getCurrentFontSize(), action);
  setFontSize(nextFontSize);
  persistEditorFontSize(nextFontSize, storage);
  return true;
}

export function bindEditorZoom(
  element: EditorZoomEventTarget,
  target: EditorZoomTarget
): () => void {
  const onKeydown = (event: KeyboardEvent) => {
    handleEditorZoomKeydown(
      event,
      target.getFontSize,
      target.setFontSize
    );
  };

  element.addEventListener("keydown", onKeydown);
  return () => element.removeEventListener("keydown", onKeydown);
}
