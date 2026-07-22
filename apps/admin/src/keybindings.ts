import type * as Monaco from "monaco-editor";

import type { EditorKeybinding } from "@blog-system/content-core";

const keyCodeMap: Record<string, number> = {
  Enter: 3,
  Tab: 2,
  Escape: 9,
  Space: 10,
  Backspace: 1,
  Delete: 20,
  Home: 14,
  End: 13,
  PageUp: 11,
  PageDown: 12,
  ArrowLeft: 15,
  ArrowUp: 16,
  ArrowRight: 17,
  ArrowDown: 18,
  Slash: 85,
  Minus: 83,
  Equal: 81,
  Backquote: 86,
  BracketLeft: 92,
  BracketRight: 94,
  Semicolon: 80,
  Quote: 79,
  Comma: 84,
  Period: 82,
  Backslash: 95
};

const codeToKeyMap: Record<string, string> = {
  Enter: "Enter",
  Tab: "Tab",
  Escape: "Escape",
  Space: "Space",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowLeft: "ArrowLeft",
  ArrowUp: "ArrowUp",
  ArrowRight: "ArrowRight",
  ArrowDown: "ArrowDown",
  Slash: "Slash",
  Minus: "Minus",
  Equal: "Equal",
  Backquote: "Backquote",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Semicolon: "Semicolon",
  Quote: "Quote",
  Comma: "Comma",
  Period: "Period",
  Backslash: "Backslash"
};

export interface KeybindingWhenContext extends Record<string, unknown> {
  editor?: Record<string, unknown>;
  trae?: Record<string, unknown>;
}

function normalizeKeyPart(rawPart: string): string | null {
  const trimmed = rawPart.trim();

  if (!trimmed) {
    return null;
  }

  const upper = trimmed.toUpperCase();

  if (upper === "CTRL" || upper === "CONTROL") {
    return "Ctrl";
  }

  if (upper === "CMDORCTRL") {
    return "CtrlOrMeta";
  }

  if (upper === "SHIFT") {
    return "Shift";
  }

  if (upper === "ALT" || upper === "OPTION") {
    return "Alt";
  }

  if (upper === "META" || upper === "CMD" || upper === "WIN") {
    return "Meta";
  }

  if (upper === "UP" || upper === "ARROWUP") {
    return "ArrowUp";
  }

  if (upper === "DOWN" || upper === "ARROWDOWN") {
    return "ArrowDown";
  }

  if (upper === "LEFT" || upper === "ARROWLEFT") {
    return "ArrowLeft";
  }

  if (upper === "RIGHT" || upper === "ARROWRIGHT") {
    return "ArrowRight";
  }

  if (/^[A-Z]$/.test(upper)) {
    return upper;
  }

  if (/^\d$/.test(upper)) {
    return upper;
  }

  if (/^F\d{1,2}$/.test(upper)) {
    return upper;
  }

  const canonical = codeToKeyMap[trimmed] ?? codeToKeyMap[`${trimmed[0]?.toUpperCase() ?? ""}${trimmed.slice(1)}`];
  return canonical ?? null;
}

function getLetterKeyCode(monaco: typeof Monaco, part: string): number | undefined {
  if (/^[A-Z]$/.test(part)) {
    return monaco.KeyCode[`Key${part}` as keyof typeof monaco.KeyCode] as number;
  }

  if (/^\d$/.test(part)) {
    return monaco.KeyCode[`Digit${part}` as keyof typeof monaco.KeyCode] as number;
  }

  if (/^F\d{1,2}$/.test(part)) {
    return monaco.KeyCode[part as keyof typeof monaco.KeyCode] as number;
  }

  return undefined;
}

export function normalizeKeyString(keyString: string): string | null {
  const rawParts = keyString
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (rawParts.length === 0) {
    return null;
  }

  const modifiers = new Set<string>();
  let key: string | null = null;

  for (const rawPart of rawParts) {
    const normalizedPart = normalizeKeyPart(rawPart);

    if (!normalizedPart) {
      return null;
    }

    if (normalizedPart === "Ctrl" || normalizedPart === "CtrlOrMeta" || normalizedPart === "Shift" || normalizedPart === "Alt" || normalizedPart === "Meta") {
      modifiers.add(normalizedPart);
      continue;
    }

    key = normalizedPart;
  }

  if (!key) {
    return null;
  }

  const orderedModifiers = ["CtrlOrMeta", "Ctrl", "Shift", "Alt", "Meta"].filter((modifier) =>
    modifiers.has(modifier)
  );

  return [...orderedModifiers, key].join("+");
}

export function parseMonacoKeybinding(
  monaco: typeof Monaco,
  keyString: string
): number | null {
  const normalized = normalizeKeyString(keyString);

  if (!normalized) {
    return null;
  }

  const parts = normalized.split("+");

  if (parts.length === 0) {
    return null;
  }

  let modifiers = 0;
  let keyCode: number | undefined;

  for (const rawPart of parts) {
    if (rawPart === "Ctrl") {
      modifiers |= monaco.KeyMod.CtrlCmd;
      continue;
    }

    if (rawPart === "CtrlOrMeta") {
      modifiers |= monaco.KeyMod.CtrlCmd;
      continue;
    }

    if (rawPart === "Shift") {
      modifiers |= monaco.KeyMod.Shift;
      continue;
    }

    if (rawPart === "Alt") {
      modifiers |= monaco.KeyMod.Alt;
      continue;
    }

    if (rawPart === "Meta") {
      modifiers |= monaco.KeyMod.WinCtrl;
      continue;
    }

    keyCode =
      getLetterKeyCode(monaco, rawPart) ??
      keyCodeMap[rawPart] ??
      keyCodeMap[`${rawPart[0]?.toUpperCase() ?? ""}${rawPart.slice(1)}`];
  }

  return keyCode ? modifiers | keyCode : null;
}

function keyFromKeyboardEvent(event: Pick<KeyboardEvent, "code" | "key">): string | null {
  if (event.code.startsWith("Key")) {
    return event.code.slice(3).toUpperCase();
  }

  if (event.code.startsWith("Digit")) {
    return event.code.slice(5);
  }

  if (/^F\d{1,2}$/.test(event.code)) {
    return event.code.toUpperCase();
  }

  if (codeToKeyMap[event.code]) {
    return codeToKeyMap[event.code];
  }

  return normalizeKeyPart(event.key);
}

export function keyStringFromKeyboardEvent(
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "code" | "key">
): string | null {
  const key = keyFromKeyboardEvent(event);

  if (!key) {
    return null;
  }

  const parts: string[] = [];

  if (event.ctrlKey && event.metaKey) {
    parts.push("CtrlOrMeta");
  } else if (event.ctrlKey) {
    parts.push("Ctrl");
  } else if (event.metaKey) {
    parts.push("Meta");
  }

  if (event.shiftKey) {
    parts.push("Shift");
  }

  if (event.altKey) {
    parts.push("Alt");
  }

  parts.push(key);
  return parts.join("+");
}

export function matchesKeybindingEvent(
  keyString: string,
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "code" | "key">
): boolean {
  const normalizedTarget = normalizeKeyString(keyString);
  const normalizedEvent = keyStringFromKeyboardEvent(event);

  if (!normalizedTarget || !normalizedEvent) {
    return false;
  }

  if (normalizedTarget === normalizedEvent) {
    return true;
  }

  // Allow CmdOrCtrl-configured shortcuts to match either Ctrl or Meta at runtime.
  if (normalizedTarget.startsWith("CtrlOrMeta+")) {
    const ctrlVariant = normalizedTarget.replace("CtrlOrMeta+", "Ctrl+");
    const metaVariant = normalizedTarget.replace("CtrlOrMeta+", "Meta+");
    return normalizedEvent === ctrlVariant || normalizedEvent === metaVariant;
  }

  return false;
}

function transformWhenExpression(expression: string) {
  return expression.replace(
    /([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*=~\s*(\/(?:\\.|[^/\\])+\/[dgimsuvy]*)/g,
    "($2).test($1)"
  );
}

export function evaluateWhenClause(when: string | undefined, context: KeybindingWhenContext): boolean {
  if (!when?.trim()) {
    return true;
  }

  try {
    const evaluator = new Function(
      "__ctx",
      `with (__ctx) { return Boolean(${transformWhenExpression(when)}); }`
    ) as (context: KeybindingWhenContext) => boolean;
    return evaluator(context);
  } catch {
    return false;
  }
}

export function getMatchingKeybindings(
  keybindings: EditorKeybinding[],
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "code" | "key">,
  context: KeybindingWhenContext
) {
  return keybindings.filter(
    (keybinding) =>
      matchesKeybindingEvent(keybinding.key, event) && evaluateWhenClause(keybinding.when, context)
  );
}

export function getActiveKeybinding(
  keybindings: EditorKeybinding[],
  event: Pick<KeyboardEvent, "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "code" | "key">,
  context: KeybindingWhenContext
) {
  const matchingKeybindings = getMatchingKeybindings(keybindings, event, context);
  const removedCommands = new Set<string>();

  for (let index = matchingKeybindings.length - 1; index >= 0; index -= 1) {
    const keybinding = matchingKeybindings[index];

    if (keybinding.command.startsWith("-")) {
      removedCommands.add(keybinding.command.slice(1));
      continue;
    }

    if (removedCommands.has(keybinding.command)) {
      continue;
    }

    return keybinding;
  }

  return null;
}

export function isWorkbenchKeybindingCommand(command: string) {
  return command === "workbench.action.showCommands" || command.startsWith("workbench.") || command.startsWith("blog.");
}
