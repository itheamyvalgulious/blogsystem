import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";

import type {
  EditorConfig,
  EditorConfigValidation,
  EditorKeybinding,
  EditorSnippet
} from "./types.js";

const snippetValueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["body"],
  properties: {
    scope: { type: "string" },
    prefix: {
      anyOf: [
        { type: "string" },
        {
          type: "array",
          items: { type: "string", minLength: 1 },
          minItems: 1
        }
      ]
    },
    key: { type: "string" },
    body: {
      anyOf: [
        { type: "string" },
        {
          type: "array",
          items: { type: "string" }
        }
      ]
    },
    description: { type: "string" }
  }
} as const;

const namedSnippetValueSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "body"],
  properties: {
    name: { type: "string", minLength: 1 },
    ...snippetValueSchema.properties
  }
} as const;

export const snippetSchema = {
  anyOf: [
    {
      type: "array",
      items: namedSnippetValueSchema
    },
    {
      type: "object",
      propertyNames: { minLength: 1 },
      additionalProperties: snippetValueSchema
    }
  ]
} as const;

export const keybindingSchema = {
  type: "array",
  items: {
    type: "object",
    additionalProperties: false,
    required: ["key", "command"],
    properties: {
      key: { type: "string", minLength: 1 },
      command: { type: "string", minLength: 1 },
      when: { type: "string" },
      args: { type: "object", additionalProperties: true }
    }
  }
} as const;

export const editorAssociationsSchema = {
  type: "object",
  propertyNames: { minLength: 1 },
  additionalProperties: {
    type: "string",
    minLength: 1
  }
} as const;

export type SnippetConfigFormat = "array" | "object";

function normalizeOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function getLineColumn(raw: string, offset: number) {
  const safeOffset = Math.max(0, Math.min(raw.length, offset));
  const prefix = raw.slice(0, safeOffset);
  const lines = prefix.split(/\r?\n/);

  return {
    line: lines.length,
    column: (lines.at(-1) ?? "").length + 1
  };
}

export function parseJsoncConfig(raw: string, label: string): unknown {
  const errors: ParseError[] = [];
  const value = parseJsonc(raw, errors, {
    allowEmptyContent: false,
    allowTrailingComma: true,
    disallowComments: false
  });

  if (errors.length === 0) {
    return value;
  }

  const message = errors
    .map((error) => {
      const location = getLineColumn(raw, error.offset);
      return `${label} line ${location.line}, column ${location.column}: ${printParseErrorCode(error.error)}`;
    })
    .join("; ");
  throw new Error(message);
}

function isValidSnippetBody(body: unknown): body is string | string[] {
  return (
    typeof body === "string" ||
    (Array.isArray(body) && body.every((line) => typeof line === "string"))
  );
}

function collectInvalidSnippetError(snippet: unknown, label: string): string | null {
  if (!snippet || typeof snippet !== "object" || Array.isArray(snippet)) {
    return `${label} must be an object.`;
  }

  if (!isValidSnippetBody((snippet as { body?: unknown }).body)) {
    return `${label} body must be a string or an array of strings.`;
  }

  return null;
}

export function parseSnippetConfigValue(value: unknown): {
  format: SnippetConfigFormat;
  snippets: EditorSnippet[];
} {
  const errors: string[] = [];

  if (Array.isArray(value)) {
    const snippets: EditorSnippet[] = [];

    value.forEach((snippet, index) => {
      const name =
        snippet && typeof snippet === "object" && typeof (snippet as { name?: unknown }).name === "string"
          ? (snippet as { name: string }).name
          : "";
      const label = name ? `Snippet "${name}"` : `Snippet at index ${index}`;
      const error = collectInvalidSnippetError(snippet, label);

      if (error) {
        errors.push(error);
        return;
      }

      snippets.push(snippet as EditorSnippet);
    });

    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }

    return {
      format: "array",
      snippets
    };
  }

  if (value && typeof value === "object") {
    const snippets: EditorSnippet[] = [];

    for (const [name, snippet] of Object.entries(value as Record<string, unknown>)) {
      const error = collectInvalidSnippetError(snippet, `Snippet "${name}"`);

      if (error) {
        errors.push(error);
        continue;
      }

      const { name: _ignoredName, ...rest } = (snippet ?? {}) as Partial<EditorSnippet>;
      snippets.push({
        ...rest,
        name
      } as EditorSnippet);
    }

    if (errors.length > 0) {
      throw new Error(errors.join("; "));
    }

    return {
      format: "object",
      snippets
    };
  }

  throw new Error("Snippet config must be an array or an object.");
}

function serializeSnippetValue(
  snippet: EditorSnippet,
  options: { includeName: boolean }
) {
  const prefixes = normalizeSnippetPrefixes(snippet);
  const serialized: Record<string, unknown> = {
    body: Array.isArray(snippet.body) ? [...snippet.body] : snippet.body
  };

  if (options.includeName) {
    serialized.name = snippet.name;
  }

  if (snippet.scope?.trim()) {
    serialized.scope = snippet.scope.trim();
  }

  if (prefixes.length === 1) {
    serialized.prefix = prefixes[0];
  } else if (prefixes.length > 1) {
    serialized.prefix = prefixes;
  }

  if (snippet.key?.trim()) {
    serialized.key = snippet.key.trim();
  }

  if (snippet.description?.trim()) {
    serialized.description = snippet.description.trim();
  }

  return serialized;
}

export function serializeSnippetConfig(
  snippets: EditorSnippet[],
  format: SnippetConfigFormat
) {
  const normalizedSnippets = normalizeEditorConfig({
    snippets,
    keybindings: []
  }).snippets;

  if (format === "array") {
    return `${JSON.stringify(normalizedSnippets.map((snippet) => serializeSnippetValue(snippet, { includeName: true })), null, 2)}\n`;
  }

  const snippetMap = Object.fromEntries(
    normalizedSnippets.map((snippet) => [
      snippet.name,
      serializeSnippetValue(snippet, { includeName: false })
    ])
  );

  return `${JSON.stringify(snippetMap, null, 2)}\n`;
}

export function serializeKeybindingConfig(keybindings: EditorKeybinding[]) {
  const normalizedKeybindings = normalizeEditorConfig({
    snippets: [],
    keybindings
  }).keybindings;

  return `${JSON.stringify(normalizedKeybindings, null, 2)}\n`;
}

export function normalizeEditorAssociations(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Editor associations config must be an object.");
  }

  const normalizedEntries = Object.entries(value as Record<string, unknown>)
    .flatMap(([pattern, editorId]) => {
      const normalizedPattern = pattern.trim();
      const normalizedEditorId = typeof editorId === "string" ? editorId.trim() : "";

      if (!normalizedPattern || !normalizedEditorId) {
        return [];
      }

      return [[normalizedPattern, normalizedEditorId] as const];
    })
    .sort(([left], [right]) => left.localeCompare(right));

  return Object.fromEntries(normalizedEntries);
}

export function serializeEditorAssociationsConfig(associations: Record<string, string>) {
  return `${JSON.stringify(normalizeEditorAssociations(associations), null, 2)}\n`;
}

export function normalizeSnippetPrefixes(snippet: EditorSnippet): string[] {
  if (Array.isArray(snippet.prefix)) {
    return snippet.prefix.map((prefix) => prefix.trim()).filter(Boolean);
  }

  if (typeof snippet.prefix === "string" && snippet.prefix.trim()) {
    return [snippet.prefix.trim()];
  }

  return [];
}

export function matchesSnippetScope(snippet: Pick<EditorSnippet, "scope">, languageId: string) {
  const normalizedScope = normalizeOptionalString(snippet.scope);

  if (!normalizedScope) {
    return true;
  }

  const normalizedLanguage = languageId.trim().toLowerCase();
  const aliasesByLanguage: Record<string, string[]> = {
    markdown: ["markdown", "md", "gfm", "quarto", "rmd"],
    latex: ["latex", "tex", "plaintex"]
  };
  const candidates = new Set([normalizedLanguage, ...(aliasesByLanguage[normalizedLanguage] ?? [])]);

  return normalizedScope
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => candidates.has(entry));
}

export function normalizeEditorConfig(config: EditorConfig): EditorConfig {
  return {
    snippets: config.snippets.map((snippet) => ({
      ...snippet,
      scope: normalizeOptionalString(snippet.scope),
      prefix: normalizeSnippetPrefixes(snippet),
      key: normalizeOptionalString(snippet.key),
      description: normalizeOptionalString(snippet.description)
    })),
    keybindings: config.keybindings.map((keybinding) => ({
      ...keybinding,
      key: keybinding.key.trim(),
      command: keybinding.command.trim(),
      when: normalizeOptionalString(keybinding.when)
    }))
  };
}

export function validateEditorConfigShape(config: EditorConfig): EditorConfigValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const normalizedConfig = normalizeEditorConfig(config);

  for (const snippet of normalizedConfig.snippets) {
    if (normalizeSnippetPrefixes(snippet).length === 0 && !snippet.key) {
      warnings.push(`Snippet "${snippet.name}" has neither prefix nor key.`);
    }
  }

  const duplicateNameSet = new Set<string>();

  for (const snippet of normalizedConfig.snippets) {
    const normalized = snippet.name.trim().toLowerCase();
    if (duplicateNameSet.has(normalized)) {
      errors.push(`Snippet name "${snippet.name}" is duplicated.`);
    }
    duplicateNameSet.add(normalized);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings
  };
}
