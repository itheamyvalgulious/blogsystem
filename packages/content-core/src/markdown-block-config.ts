import { escapeHtmlAttribute } from "./utils.js";

export interface MarkdownBlockRule {
  start: string;
  end: string;
  tag: string;
  class: string[];
}

export interface MarkdownBlockConfig {
  rules: MarkdownBlockRule[];
}

export const markdownBlockConfigSchema = {
  type: "object",
  additionalProperties: false,
  required: ["rules"],
  properties: {
    rules: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["start", "end", "tag", "class"],
        properties: {
          start: { type: "string", minLength: 1 },
          end: { type: "string", minLength: 1 },
          tag: { type: "string", minLength: 1, pattern: "^[A-Za-z][A-Za-z0-9:-]*$" },
          class: {
            type: "array",
            items: { type: "string", minLength: 1 },
            uniqueItems: true
          }
        }
      }
    }
  }
} as const;

export const builtInMarkdownBlockRules: MarkdownBlockRule[] = [
  { start: "[nopdf]", end: "[/nopdf]", tag: "div", class: ["no-pdf"] }
];

export const defaultMarkdownBlockConfig: MarkdownBlockConfig = {
  rules: [...builtInMarkdownBlockRules]
};

function normalizeClassNames(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((entry) => String(entry).trim())
    .filter(Boolean)
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}

export function normalizeMarkdownBlockConfig(
  input: Partial<MarkdownBlockConfig> | null | undefined
): MarkdownBlockConfig {
  const rules = Array.isArray(input?.rules) ? input.rules : [];

  return {
    rules: rules
      .filter((rule) => Boolean(rule && typeof rule === "object"))
      .map((rule) => ({
        start: typeof rule.start === "string" ? rule.start.trim() : "",
        end: typeof rule.end === "string" ? rule.end.trim() : "",
        tag: typeof rule.tag === "string" ? rule.tag.trim() : "",
        class: normalizeClassNames(rule.class)
      }))
      .filter((rule) => rule.start.length > 0 && rule.end.length > 0 && rule.tag.length > 0)
  };
}

export function findDuplicateMarkdownBlockRuleMarkers(config: MarkdownBlockConfig) {
  const seenStarts = new Set<string>();
  const seenEnds = new Set<string>();
  const duplicateStarts: string[] = [];
  const duplicateEnds: string[] = [];

  for (const rule of config.rules) {
    const normalizedStart = rule.start.trim().toLowerCase();
    const normalizedEnd = rule.end.trim().toLowerCase();

    if (seenStarts.has(normalizedStart)) {
      duplicateStarts.push(rule.start);
    } else {
      seenStarts.add(normalizedStart);
    }

    if (seenEnds.has(normalizedEnd)) {
      duplicateEnds.push(rule.end);
    } else {
      seenEnds.add(normalizedEnd);
    }
  }

  return {
    duplicateEnds,
    duplicateStarts
  };
}

function renderOpenTag(rule: MarkdownBlockRule) {
  const classAttribute = rule.class.length > 0 ? ` class="${escapeHtmlAttribute(rule.class.join(" "))}"` : "";
  return `<${rule.tag}${classAttribute}>`;
}

function mergeBuiltInRules(userRules: MarkdownBlockRule[]): MarkdownBlockRule[] {
  const builtInStartMarkers = new Set(
    builtInMarkdownBlockRules.map((r) => r.start.trim().toLowerCase())
  );
  return [
    ...builtInMarkdownBlockRules,
    ...userRules.filter((r) => !builtInStartMarkers.has(r.start.trim().toLowerCase()))
  ];
}

export function applyMarkdownBlockRules(
  markdown: string,
  configOrRules?: MarkdownBlockConfig | MarkdownBlockRule[] | null
) {
  const normalizedMarkdown = markdown.replace(/\r\n/g, "\n");
  const userRules: MarkdownBlockRule[] = Array.isArray(configOrRules)
    ? normalizeMarkdownBlockConfig({ rules: configOrRules }).rules
    : normalizeMarkdownBlockConfig(configOrRules).rules;

  const rules = mergeBuiltInRules(userRules);

  if (rules.length === 0) {
    return normalizedMarkdown;
  }

  const endRuleMap = new Map(rules.map((rule) => [rule.end.trim().toLowerCase(), rule]));
  const startRuleMap = new Map(rules.map((rule) => [rule.start.trim().toLowerCase(), rule]));
  const output: string[] = [];
  const stack: MarkdownBlockRule[] = [];

  for (const line of normalizedMarkdown.split("\n")) {
    const trimmed = line.trim();
    const normalizedLine = trimmed.toLowerCase();
    const activeRule = stack[stack.length - 1];

    if (
      activeRule &&
      normalizedLine === activeRule.end.trim().toLowerCase() &&
      activeRule.start.trim().toLowerCase() !== activeRule.end.trim().toLowerCase()
    ) {
      output.push(`</${activeRule.tag}>`);
      stack.pop();
      continue;
    }

    if (
      activeRule &&
      normalizedLine === activeRule.start.trim().toLowerCase() &&
      activeRule.start.trim().toLowerCase() === activeRule.end.trim().toLowerCase()
    ) {
      output.push(`</${activeRule.tag}>`);
      stack.pop();
      continue;
    }

    const nextRule = startRuleMap.get(normalizedLine);
    if (nextRule) {
      output.push(renderOpenTag(nextRule));
      stack.push(nextRule);
      continue;
    }

    const mismatchedEndRule = endRuleMap.get(normalizedLine);
    if (mismatchedEndRule) {
      throw new Error(
        activeRule
          ? `Markdown block "${activeRule.start}" must close with "${activeRule.end}", received "${trimmed}".`
          : `Markdown block end marker "${trimmed}" does not have a matching start marker.`
      );
    }

    output.push(line);
  }

  if (stack.length > 0) {
    const activeRule = stack[stack.length - 1];
    throw new Error(
      `Markdown block "${activeRule.start}" is missing closing marker "${activeRule.end}".`
    );
  }

  return output.join("\n");
}
