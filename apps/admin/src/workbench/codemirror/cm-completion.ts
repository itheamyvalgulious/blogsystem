import {
  autocompletion,
  closeCompletion,
  snippetCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult
} from "@codemirror/autocomplete";
import type { EditorState, Extension } from "@codemirror/state";

import type { ArticleSummary } from "@blog-system/content-core";

import {
  resolveActiveSnippetMatches,
  type SnippetCompletionMatch
} from "../../snippet-completion";
import { getSnippetsForLanguage } from "../../snippet-scope";
import {
  isArticleDocument,
  isProjectTaskDocument
} from "../document-builders";
import {
  getProjectTaskNoteQuery,
  getProjectTaskNoteSuggestions
} from "../project-task-utils";
import { getWorkbenchCompletionContext } from "./cm-context";
import { insertCmSnippet } from "./cm-snippets";
import { cmMathContextExtension, getCmMathLanguageAt } from "./cm-math-context";

/**
 * Workbench completion source for the CodeMirror "live" engine:
 *
 * - project-task documents get `@note/...` article reference suggestions
 *   (type "reference", insert `@note/<title> `);
 * - article documents get markdown/latex snippet completions from
 *   `resolveActiveSnippetMatches` (word + structured prefixes, latex-context
 *   markdown carry-over), inserted as CM snippets (same template syntax).
 *
 * Both result sets are pre-filtered and pre-sorted, so CM filtering is
 * disabled (`filter: false`) and the returned order is preserved.
 *
 * The snippet language (markdown vs latex) is read from the incremental
 * `cmMathContextField` (see cm-math-context.ts) at query time, with a
 * full-scan fallback for states that do not install the field.
 *
 *
 * IME / composition hardening:
 * - `workbenchCompletionSource` returns null mid-composition (the document
 *   text is transient pinyin/pre-commit; results would be stale the moment
 *   the candidate commits, and the panel churns mid-composition). The
 *   commit's own input transactions re-trigger the query.
 * - `option.apply` refuses to dispatch any document change while a
 *   composition is active (corrupts CM's composition tracking). It also
 *   validates both the head-anchored and the legacy fallback range against
 *   the replacement text before applying, so a stale panel whose text no
 *   longer matches the document cleanly aborts instead of eating adjacent
 *   characters.
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
 * Matches the stable completion ordering:
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
 * snippet template syntax ($1, ${1:placeholder}, $0).
 */
export function buildSnippetCompletionOptions(matches: SnippetCompletionMatch[]): Completion[] {
  return [...matches].sort(compareSnippetMatches).map((match) => {
    const body = toSnippetBody(match.snippet.body);
    const option = snippetCompletion(body, {
      detail: match.prefix,
      label: match.snippet.name,
      type: "snippet"
    });
    // Each suggestion has its own replacement range (the matched prefix,
    // which differs per prefix within one result); a CM result shares a single
    // range, so each option re-applies its own span here. Use the actual caret
    // position as the source of truth. When the head-anchored text does not
    // match the replacement (e.g. the caret moved since query or an IME commit
    // replaced the typed prefix), fall back to the mapped result range — but
    // only if its text STILL matches the replacement, otherwise the panel is
    // stale and applying would eat unrelated characters.
    option.apply = (view, completion, _from, to) => {
      // IME safety: never dispatch a document change while a composition is
      // active — it corrupts CodeMirror's composition tracking (the reported
      // "$ disappears" corruption when an IME commit races the panel).
      if (view.compositionStarted) {
        closeCompletion(view);
        return;
      }
      const actualTo = view.state.selection.main.head;
      const actualFrom = actualTo - match.replacementText.length;
      const headMatches =
        actualFrom >= 0 && view.state.sliceDoc(actualFrom, actualTo) === match.replacementText;
      // The mapped result range may point at text the user no longer typed
      // (e.g. an IME commit replaced the prefix between query and accept).
      // Only fall back to it when its text STILL matches the replacement —
      // otherwise applying would eat unrelated characters before the caret.
      const fallbackFrom = to - match.replacementText.length;
      const fallbackMatches =
        fallbackFrom >= 0 && fallbackFrom !== actualFrom &&
        view.state.sliceDoc(fallbackFrom, to) === match.replacementText;
      if (!headMatches && !fallbackMatches) {
        // Stale panel: the document changed under it. Applying would replace
        // unrelated text — abort cleanly instead.
        closeCompletion(view);
        return;
      }
      const replacementTo = headMatches ? actualTo : to;
      const replacementFrom = replacementTo - match.replacementText.length;
      insertCmSnippet(view, body, replacementFrom, replacementTo);
      // A custom apply function bypasses CodeMirror's normal completion
      // transaction, so close the suggestion panel explicitly. Leaving it
      // open lets the next typed character participate in the old completion
      // range instead of the newly active snippet field.
      closeCompletion(view);
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

export function workbenchCompletionSource(context: CompletionContext): CompletionResult | null {
  const { activeDocument, articleSummaries, latexSnippets, markdownSnippets } =
    getWorkbenchCompletionContext();
  if (!activeDocument) {
    return null;
  }

  // Never query while an IME composition is active: the document text is
  // transient (pinyin/pre-commit), results would be stale the moment the
  // candidate commits, and the panel churns mid-composition. The commit's
  // own input transactions re-trigger the query (activateOnTyping).
  if (context.view?.compositionStarted) {
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

  const snippetLanguage = getCmMathLanguageAt(context.state, pos);
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
 *
 * Zero `activateOnTypingDelay`: the suggestion panel must appear in the same
 * frame as the triggering keystroke, so a fast Enter accepts the completion
 * instead of inserting a newline.
 */
export function createCmCompletionExtension(): Extension {
  return [
    // Incremental per-line math context: keeps the snippet-language query at
    // the caret O(line) instead of a full-document rescan per keystroke.
    cmMathContextExtension,
    autocompletion({
      activateOnTyping: true,
      activateOnTypingDelay: 0,
      // The panel's timestamp is refreshed on every rebuild (per-keystroke
      // re-queries), so the stock 75ms anti-misaccept window intermittently
      // turned a displayed panel's Enter into a newline (acceptCompletion
      // refused -> defaultKeymap newline). Our source is pre-filtered and
      // prefix-anchored; there is no misaccept risk worth the window.
      interactionDelay: 0,
      defaultKeymap: false,
      override: [workbenchCompletionSource]
    })
  ];
}
