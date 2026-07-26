import {
  autocompletion,
  snippet,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from "@codemirror/autocomplete";
import type { EditorState, Extension } from "@codemirror/state";

import type { ArticleSummary } from "@blog-system/content-core";

import { scanDocumentMathPairs } from "../../markdown-math-tokenization";
import {
  resolveActiveSnippetMatches,
  type SnippetCompletionMatch
} from "../../snippet-completion";
import { getSnippetLanguageFromMathPairs } from "../../snippet-context";
import { getSnippetsForLanguage } from "../../snippet-scope";
import {
  isArticleDocument,
  isProjectTaskDocument
} from "../document-builders";
import {
  getProjectTaskNoteQuery,
  getProjectTaskNoteSuggestions
} from "../project-task-utils";
import { positionAt } from "./cm-handle";
import { getWorkbenchCompletionContext } from "./cm-context";

/**
 * Workbench completion source for the CodeMirror "live" engine, mirroring the
 * Monaco completion item provider in hooks/use-editor-integration.ts:
 *
 * - project-task documents get `@note/...` article reference suggestions
 *   (type "reference", insert `@note/<title> `);
 * - article documents get markdown/latex snippet completions from
 *   `resolveActiveSnippetMatches` (word + structured prefixes, latex-context
 *   markdown carry-over), inserted as CM snippets (same template syntax).
 *
 * Both result sets are pre-filtered/pre-sorted exactly like the Monaco side
 * (which supplies its own filterText/sortText), so CM filtering is disabled
 * (`filter: false`) and the returned order is preserved.
 *
 * The snippet language (markdown vs latex) is derived by rescanning the
 * document's math pairs at query time instead of reading the Monaco-side
 * cache — self-contained and always in sync with the current buffer.
 *
 * No monaco imports: this module must stay loadable in Node test runs.
 */

function toSnippetBody(body: string | string[]) {
  return Array.isArray(body) ? body.join("\n") : body;
}

function getLinePrefix(state: EditorState, pos: number): string {
  const line = state.doc.lineAt(pos);
  return line.text.slice(0, pos - line.from);
}

/**
 * Matches the Monaco provider's sortText ordering:
 * `0-${9999 - replacementText.length}-${prefix.length}-${prefix}` — longest
 * matched replacement first, then shortest prefix, then prefix alphabetical.
 */
function compareSnippetMatches(left: SnippetCompletionMatch, right: SnippetCompletionMatch): number {
  if (left.replacementText.length !== right.replacementText.length) {
    return right.replacementText.length - left.replacementText.length;
  }
  if (left.prefix.length !== right.prefix.length) {
    return left.prefix.length - right.prefix.length;
  }
  if (left.prefix !== right.prefix) {
    return left.prefix < right.prefix ? -1 : 1;
  }
  return left.snippet.name.localeCompare(right.snippet.name);
}

/**
 * Pure option construction for snippet matches (exported for tests). Each
 * option is a `snippetCompletion` so the body is expanded with the shared
 * CM/Monaco snippet template syntax ($1, ${1:placeholder}, $0).
 */
export function buildSnippetCompletionOptions(matches: SnippetCompletionMatch[]): Completion[] {
  return [...matches].sort(compareSnippetMatches).map((match) => {
    const body = toSnippetBody(match.snippet.body);
    const option = snippetCompletion(body, {
      detail: match.prefix,
      label: match.snippet.name,
      type: "snippet"
    });
    // Monaco gives every suggestion its own replacement range (the matched
    // prefix, which differs per prefix within one result); a CM result shares
    // a single range, so each option re-applies its own span here.
    option.apply = (view, completion, _from, to) => {
      snippet(body)(view, completion, to - match.replacementText.length, to);
    };
    return option;
  });
}

/**
 * Pure option construction for `@note` reference suggestions (exported for
 * tests). All options replace the same typed query, so a plain string `apply`
 * over the result range reproduces Monaco's per-item insertText + range.
 */
export function buildNoteReferenceOptions(query: string, articles: ArticleSummary[]): Completion[] {
  return getProjectTaskNoteSuggestions(query, articles).map((article) => ({
    apply: `@note/${article.title} `,
    detail: article.path,
    label: article.title,
    type: "reference"
  }));
}

function workbenchCompletionSource(context: CompletionContext): CompletionResult | null {
  const { activeDocument, articleSummaries, latexSnippets, markdownSnippets } =
    getWorkbenchCompletionContext();
  if (!activeDocument) {
    return null;
  }

  const pos = context.pos;
  const linePrefix = getLinePrefix(context.state, pos);

  if (isProjectTaskDocument(activeDocument)) {
    const noteQuery = getProjectTaskNoteQuery(linePrefix);
    if (!noteQuery) {
      return null;
    }
    const options = buildNoteReferenceOptions(noteQuery.query, articleSummaries);
    if (options.length === 0) {
      return null;
    }
    return {
      filter: false,
      from: pos - noteQuery.replacementText.length,
      options
    };
  }

  if (!isArticleDocument(activeDocument)) {
    return null;
  }

  const position = positionAt(context.state.doc, pos);
  const mathPairs = scanDocumentMathPairs(context.state.doc.toString());
  const snippetLanguage = getSnippetLanguageFromMathPairs(
    mathPairs,
    position.lineNumber,
    position.column
  );
  const snippetState = resolveActiveSnippetMatches(
    linePrefix,
    snippetLanguage,
    getSnippetsForLanguage(markdownSnippets, "markdown"),
    getSnippetsForLanguage(latexSnippets, "latex")
  );
  if (snippetState.matches.length === 0) {
    return null;
  }
  return {
    filter: false,
    from: pos,
    options: buildSnippetCompletionOptions(snippetState.matches)
  };
}

/**
 * Autocompletion wired to the workbench source. `defaultKeymap: false`
 * because completionKeymap is already part of the shared keymap stack
 * (cm-keymap.ts); `activateOnTyping` re-queries on every typed character,
 * covering both word prefixes and symbol trigger characters (@, \, ...).
 */
export function createCmCompletionExtension(): Extension {
  return autocompletion({
    activateOnTyping: true,
    defaultKeymap: false,
    override: [workbenchCompletionSource]
  });
}
