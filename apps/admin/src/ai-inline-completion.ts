import type * as monacoEditor from "monaco-editor";

import { api } from "./api";
import { getCachedMathPairs } from "./markdown-math-tokenization";
import { getSnippetLanguageFromMathPairs } from "./snippet-context";

const AI_COMPLETION_DEBOUNCE_MS = 300;
// Small context + small budget keep upstream latency low (inline completion
// must feel instant); ~100 tokens of context, a short suffix for line ends.
const AI_COMPLETION_PREFIX_CHARS = 400;
const AI_COMPLETION_SUFFIX_CHARS = 150;

export interface AiCompletionStatus {
  enabled: boolean;
  model: string;
  baseUrl: string;
}

export interface AiCompletionRequestInput {
  prefix: string;
  suffix: string;
  language: "markdown" | "latex";
}

const DISABLED_STATUS: AiCompletionStatus = { enabled: false, model: "", baseUrl: "" };

let installed = false;
let cachedStatus: AiCompletionStatus | null = null;
let refreshInFlight = false;
let lastRefreshFailedAt: number | null = null;
const STATUS_RETRY_AFTER_FAILURE_MS = 30_000;

export function getAiCompletionStatus(): AiCompletionStatus | null {
  return cachedStatus;
}

export function refreshAiCompletionStatus(): Promise<void> {
  if (refreshInFlight) {
    return Promise.resolve();
  }
  refreshInFlight = true;
  return api
    .getAiCompletionConfig()
    .then((payload) => {
      cachedStatus = payload.status;
      lastRefreshFailedAt = null;
    })
    .catch((error: unknown) => {
      console.debug("AI completion status unavailable; treating it as disabled.", error);
      cachedStatus = DISABLED_STATUS;
      lastRefreshFailedAt = Date.now();
    })
    .finally(() => {
      refreshInFlight = false;
    });
}

/**
 * Self-healing status access for request paths: a previously failed refresh
 * (e.g. the page loaded while the dev server was restarting) must not disable
 * completion for the page's whole lifetime — retry in the background and use
 * whatever the next refresh finds. Retries only happen after an actual fetch
 * failure, never against a legitimately disabled status.
 */
export function getAiCompletionStatusWithRetry(): AiCompletionStatus | null {
  if (
    lastRefreshFailedAt !== null &&
    Date.now() - lastRefreshFailedAt >= STATUS_RETRY_AFTER_FAILURE_MS
  ) {
    lastRefreshFailedAt = Date.now();
    void refreshAiCompletionStatus();
  }
  return cachedStatus;
}

/**
 * Pure context extraction shared by the Monaco and CodeMirror inline
 * completion integrations: up to 2000 chars before / 500 chars after the
 * cursor, plus the snippet language at the cursor derived from the cached
 * math pairs (markdown vs latex).
 */
export function buildAiCompletionRequestInput(
  fullText: string,
  offset: number,
  lineNumber: number,
  column: number
): AiCompletionRequestInput {
  const prefixStartOffset = Math.max(0, offset - AI_COMPLETION_PREFIX_CHARS);
  const suffixEndOffset = Math.min(fullText.length, offset + AI_COMPLETION_SUFFIX_CHARS);
  return {
    prefix: fullText.slice(prefixStartOffset, offset),
    suffix: fullText.slice(offset, suffixEndOffset),
    language: getSnippetLanguageFromMathPairs(getCachedMathPairs(), lineNumber, column)
  };
}

/**
 * Shared request wrapper: resolves to the completion text, or null when the
 * server returned an empty completion or the request failed (silent except
 * for a console.debug, same as the Monaco provider).
 */
export async function requestAiCompletionText(
  input: AiCompletionRequestInput
): Promise<string | null> {
  try {
    const { completion } = await api.requestAiInlineCompletion(input);
    return completion.length > 0 ? completion : null;
  } catch (error) {
    console.debug("AI inline completion request failed.", error);
    return null;
  }
}

export function installAiInlineCompletion(monaco: typeof monacoEditor): () => void {
  if (installed) {
    return () => {};
  }
  installed = true;
  void refreshAiCompletionStatus();

  const provider = monaco.languages.registerInlineCompletionsProvider("markdown", {
    freeInlineCompletions() {},
    async provideInlineCompletions(model, position, _context, token) {
      if (!getAiCompletionStatusWithRetry()?.enabled) {
        return { items: [] };
      }

      await new Promise((resolve) => setTimeout(resolve, AI_COMPLETION_DEBOUNCE_MS));

      if (token.isCancellationRequested || !getAiCompletionStatusWithRetry()?.enabled) {
        return { items: [] };
      }

      const input = buildAiCompletionRequestInput(
        model.getValue(),
        model.getOffsetAt(position),
        position.lineNumber,
        position.column
      );

      const completion = await requestAiCompletionText(input);
      if (token.isCancellationRequested || completion === null) {
        return { items: [] };
      }

      return {
        items: [
          {
            insertText: completion,
            range: new monaco.Range(
              position.lineNumber,
              position.column,
              position.lineNumber,
              position.column
            )
          }
        ]
      };
    }
  });

  return () => {
    provider.dispose();
    installed = false;
  };
}
