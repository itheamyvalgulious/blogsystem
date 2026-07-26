import type { Command } from "@codemirror/view";

/**
 * Port of Monaco's `tabCompletion: "on"` for the CodeMirror "live" engine:
 * with an empty selection and a word prefix before the caret, Tab extends the
 * prefix from document words. A single candidate completes outright; multiple
 * candidates extend to their longest common prefix (Monaco instead cycles
 * candidates on repeat Tab — the LCP extension is the predictable
 * approximation; with no common extension the command falls through to the
 * next Tab binding).
 *
 * No monaco imports: this module must stay loadable in Node test runs.
 */

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WORD_PATTERN = /[\p{L}\p{N}_]{2,}/gu;

/**
 * Pure candidate resolution (exported for tests): the completion text to
 * insert after `prefix`, or null when there is nothing useful to insert.
 */
export function findDocumentWordCompletion(docText: string, prefix: string): string | null {
  if (prefix.length === 0) {
    return null;
  }

  const candidates = new Set<string>();
  for (const match of docText.matchAll(WORD_PATTERN)) {
    const word = match[0];
    if (word.length > prefix.length && word.startsWith(prefix)) {
      candidates.add(word);
    }
  }
  if (candidates.size === 0) {
    return null;
  }

  const [first, ...rest] = [...candidates];
  if (rest.length === 0) {
    return first.slice(prefix.length);
  }

  let lcp = first;
  for (const word of rest) {
    while (lcp.length > 0 && !word.startsWith(lcp)) {
      lcp = lcp.slice(0, -1);
    }
  }
  const extension = lcp.slice(prefix.length);
  return extension.length > 0 ? extension : null;
}

/** Extracts the word prefix immediately before `headInLine` in `lineText`. */
export function wordPrefixBefore(lineText: string, headInLine: number): string {
  const before = lineText.slice(0, headInLine);
  let start = before.length;
  while (start > 0 && WORD_CHAR.test(before[start - 1])) {
    start--;
  }
  return before.slice(start);
}

export const tabCompleteFromDocument: Command = (view) => {
  const { main } = view.state.selection;
  if (!main.empty) {
    return false;
  }

  const line = view.state.doc.lineAt(main.head);
  const prefix = wordPrefixBefore(line.text, main.head - line.from);
  const completion = findDocumentWordCompletion(view.state.doc.toString(), prefix);
  if (completion === null) {
    return false;
  }

  view.dispatch({
    changes: { from: main.head, insert: completion },
    selection: { anchor: main.head + completion.length },
    userEvent: "input.complete"
  });
  return true;
};
