import { promises as fs } from "node:fs";
import path from "node:path";

import { getErrorMessage } from "@blog-system/content-core";

import { ApiError, ConfigValidationError } from "./errors.js";

export type AiCompletionProvider = "openai" | "anthropic";

export interface AiCompletionConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey?: string;
  provider?: AiCompletionProvider;
  maxTokens?: number;
  temperature?: number;
}

export interface AiCompletionConfigPayload {
  raw: string;
  value: AiCompletionConfig;
}

export interface AiCompletionStatus {
  enabled: boolean;
  provider: AiCompletionProvider;
  model: string;
  baseUrl: string;
}

export interface AiInlineCompletionInput {
  prefix: string;
  suffix: string;
  language: "markdown" | "latex";
}

export interface AiInlineCompletionResult {
  completion: string;
}

interface EffectiveAiCompletionSettings {
  enabled: boolean;
  provider: AiCompletionProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxTokens: number;
  temperature: number;
}

const AI_COMPLETION_CONFIG_FILE = "ai-completion.local.json";
// Reasoning models can take a while before the first useful token; the client
// debounce/cancellation keeps this from blocking typing.
const AI_COMPLETION_TIMEOUT_MS = 30_000;
const ANTHROPIC_MESSAGES_PATH = "/v1/messages";
const ANTHROPIC_VERSION_HEADER = "2023-06-01";

const DEFAULT_AI_COMPLETION_CONFIG: Required<Pick<AiCompletionConfig, "enabled" | "baseUrl" | "model" | "maxTokens" | "temperature">> = {
  enabled: false,
  baseUrl: "https://api.openai.com/v1",
  model: "",
  // Reasoning models burn part of the budget on <think> blocks, so keep this
  // above what a plain completion strictly needs.
  maxTokens: 128,
  temperature: 0.2
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeAiCompletionConfig(raw: unknown): AiCompletionConfig {
  if (!isObject(raw)) {
    throw new ConfigValidationError("AI completion config must be an object.");
  }

  if (typeof raw.enabled !== "boolean") {
    throw new ConfigValidationError('AI completion config requires "enabled" to be a boolean.');
  }

  if (typeof raw.baseUrl !== "string") {
    throw new ConfigValidationError('AI completion config requires "baseUrl" to be a string.');
  }

  if (typeof raw.model !== "string") {
    throw new ConfigValidationError('AI completion config requires "model" to be a string.');
  }

  if (raw.apiKey !== undefined && typeof raw.apiKey !== "string") {
    throw new ConfigValidationError('AI completion config requires "apiKey" to be a string when provided.');
  }

  if (raw.provider !== undefined && raw.provider !== "openai" && raw.provider !== "anthropic") {
    throw new ConfigValidationError('AI completion config requires "provider" to be "openai" or "anthropic" when provided.');
  }

  if (raw.maxTokens !== undefined && typeof raw.maxTokens !== "number") {
    throw new ConfigValidationError('AI completion config requires "maxTokens" to be a number when provided.');
  }

  if (raw.temperature !== undefined && typeof raw.temperature !== "number") {
    throw new ConfigValidationError('AI completion config requires "temperature" to be a number when provided.');
  }

  return {
    enabled: raw.enabled,
    baseUrl: raw.baseUrl,
    model: raw.model,
    apiKey: raw.apiKey as string | undefined,
    provider: raw.provider as AiCompletionProvider | undefined,
    maxTokens: raw.maxTokens as number | undefined,
    temperature: raw.temperature as number | undefined
  };
}

async function readAiCompletionConfig(configRoot: string): Promise<AiCompletionConfigPayload> {
  const configPath = path.join(configRoot, AI_COMPLETION_CONFIG_FILE);
  let raw: string;

  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const value = normalizeAiCompletionConfig({ ...DEFAULT_AI_COMPLETION_CONFIG });
      return {
        raw: `${JSON.stringify(value, null, 2)}\n`,
        value
      };
    }
    throw error;
  }

  const value = normalizeAiCompletionConfig(JSON.parse(raw));
  return {
    raw: `${JSON.stringify(value, null, 2)}\n`,
    value
  };
}

export async function loadAiCompletionConfig(configRoot: string): Promise<AiCompletionConfigPayload> {
  return readAiCompletionConfig(configRoot);
}

export async function saveAiCompletionConfig(configRoot: string, raw: string): Promise<AiCompletionConfigPayload> {
  const value = normalizeAiCompletionConfig(JSON.parse(raw));
  const configPath = path.join(configRoot, AI_COMPLETION_CONFIG_FILE);
  const normalizedRaw = `${JSON.stringify(value, null, 2)}\n`;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, normalizedRaw, "utf8");

  return {
    raw: normalizedRaw,
    value
  };
}

function firstNonEmptyEnv(...values: Array<string | undefined>) {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function parseProviderEnv(value: string | undefined): AiCompletionProvider | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized === "openai" || normalized === "anthropic" ? normalized : undefined;
}

function detectProviderFromBaseUrl(baseUrl: string): AiCompletionProvider {
  return baseUrl.toLowerCase().includes("anthropic") ? "anthropic" : "openai";
}

async function resolveEffectiveSettings(configRoot: string): Promise<EffectiveAiCompletionSettings> {
  const config = (await readAiCompletionConfig(configRoot)).value;

  // AI_COMPLETION_* env wins over the config file (deployment override).
  const enabledEnv = process.env.AI_COMPLETION_ENABLED?.trim().toLowerCase();
  const baseUrl = firstNonEmptyEnv(process.env.AI_COMPLETION_BASE_URL) ?? config.baseUrl;
  const model = firstNonEmptyEnv(process.env.AI_COMPLETION_MODEL) ?? config.model;
  const apiKey = firstNonEmptyEnv(process.env.AI_COMPLETION_API_KEY) ?? config.apiKey;
  const provider =
    parseProviderEnv(process.env.AI_COMPLETION_PROVIDER) ?? config.provider ?? detectProviderFromBaseUrl(baseUrl);

  const enabled =
    enabledEnv === "true" || enabledEnv === "1" ? true : enabledEnv === "false" || enabledEnv === "0" ? false : config.enabled;

  return {
    enabled,
    provider,
    baseUrl,
    model,
    apiKey,
    maxTokens: config.maxTokens ?? DEFAULT_AI_COMPLETION_CONFIG.maxTokens,
    temperature: config.temperature ?? DEFAULT_AI_COMPLETION_CONFIG.temperature
  };
}

export async function resolveAiCompletionStatus(configRoot: string): Promise<AiCompletionStatus> {
  const effective = await resolveEffectiveSettings(configRoot);
  return {
    enabled: effective.enabled,
    provider: effective.provider,
    model: effective.model,
    baseUrl: effective.baseUrl
  };
}

function buildAiCompletionPrompt(input: AiInlineCompletionInput) {
  const languageHint =
    input.language === "latex"
      ? "光标当前处于 LaTeX 数学环境中。"
      : "光标当前处于 Markdown 文本中。";

  return {
    system:
      "你是 Markdown+LaTeX 写作编辑器的 inline 补全引擎,只返回要插入到 <cursor/> 处的文本,不要解释、不要代码围栏、不要重复已存在的文本;优先补全 LaTeX 环境(\\begin/\\end 配对)、数学语法、tikzcd 交换图",
    user: `${languageHint}\n<prefix>${input.prefix}</prefix><cursor/><suffix>${input.suffix}</suffix>`
  };
}

interface UpstreamRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function buildOpenAiRequest(settings: EffectiveAiCompletionSettings, input: AiInlineCompletionInput): UpstreamRequest {
  const prompt = buildAiCompletionPrompt(input);
  return {
    url: `${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {})
    },
    body: {
      model: settings.model,
      messages: [
        { role: "system", content: prompt.system },
        { role: "user", content: prompt.user }
      ],
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
      stop: ["\n\n"]
    }
  };
}

function buildAnthropicRequest(settings: EffectiveAiCompletionSettings, input: AiInlineCompletionInput): UpstreamRequest {
  const prompt = buildAiCompletionPrompt(input);
  const baseUrl = settings.baseUrl.replace(/\/+$/, "");
  return {
    url: baseUrl.endsWith(ANTHROPIC_MESSAGES_PATH) ? baseUrl : `${baseUrl}${ANTHROPIC_MESSAGES_PATH}`,
    headers: {
      "content-type": "application/json",
      ...(settings.apiKey ? { "x-api-key": settings.apiKey } : {}),
      "anthropic-version": ANTHROPIC_VERSION_HEADER
    },
    body: {
      model: settings.model,
      max_tokens: settings.maxTokens,
      temperature: settings.temperature,
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
      stop_sequences: ["\n\n"]
    }
  };
}

function extractOpenAiContent(payload: unknown): string | undefined {
  const content = (payload as { choices?: Array<{ message?: { content?: unknown } }> })
    .choices?.[0]?.message?.content;
  return typeof content === "string" ? content : undefined;
}

function extractAnthropicContent(payload: unknown): string | undefined {
  const blocks = (payload as { content?: unknown }).content;
  if (!Array.isArray(blocks)) {
    return undefined;
  }

  for (const block of blocks) {
    if (isObject(block) && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return undefined;
}

function stripCodeFence(text: string) {
  const trimmed = text.trim();
  const fenceMatch = /^```[^\n]*\n(?<body>[\s\S]*?)\n?```$/.exec(trimmed);
  return fenceMatch?.groups?.body ?? text;
}

// Reasoning models (deepseek-r1, minimax, qwq, …) may prepend a <think> block
// despite the prompt asking for bare insert text. When a closing tag exists,
// everything after it is the actual answer; an unclosed block means the whole
// token budget went to reasoning, leaving nothing usable to insert.
function stripReasoningBlock(text: string) {
  const closingTag = "</think>";
  const closingIndex = text.lastIndexOf(closingTag);
  if (closingIndex >= 0) {
    return text.slice(closingIndex + closingTag.length).trimStart();
  }
  if (text.trimStart().startsWith("<think>")) {
    return "";
  }
  return text;
}

export async function completeAiInline(
  configRoot: string,
  input: AiInlineCompletionInput
): Promise<AiInlineCompletionResult> {
  const settings = await resolveEffectiveSettings(configRoot);

  if (!settings.enabled || !settings.model.trim()) {
    throw new ApiError(400, "AI completion is not enabled.");
  }

  const upstream =
    settings.provider === "anthropic" ? buildAnthropicRequest(settings, input) : buildOpenAiRequest(settings, input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_COMPLETION_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(upstream.url, {
      method: "POST",
      signal: controller.signal,
      headers: upstream.headers,
      body: JSON.stringify(upstream.body)
    });
  } catch (error) {
    console.error(`AI completion request failed: ${getErrorMessage(error)}`);
    throw new ApiError(502, "AI completion request failed.");
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const excerpt = (await response.text().catch(() => "")).slice(0, 500);
    console.error(`AI completion upstream responded ${response.status}: ${excerpt}`);
    throw new ApiError(502, "AI completion request failed.");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    console.error(`AI completion upstream returned invalid JSON: ${getErrorMessage(error)}`);
    throw new ApiError(502, "AI completion request failed.");
  }

  const content =
    settings.provider === "anthropic" ? extractAnthropicContent(payload) : extractOpenAiContent(payload);

  if (typeof content !== "string") {
    return { completion: "" };
  }

  const completion = stripCodeFence(stripReasoningBlock(content)).trimEnd();
  return { completion };
}
