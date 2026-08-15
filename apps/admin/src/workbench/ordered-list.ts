const LIST_PREFIX_PATTERN = /^([ \t]*)(?:(\d+)\.([ \t]+)|([-*+])([ \t]+))/;
const ORDERED_LIST_ITEM_PATTERN = /^([ \t]*)(\d+)\.([ \t]+)(.*)$/;

interface ParsedOrderedListItem {
  indent: string;
  number: number;
  numberText: string;
}

export interface OrderedListRenumberEdit {
  endColumn: number;
  lineNumber: number;
  startColumn: number;
  text: string;
}

interface SplitText {
  lines: string[];
  separators: string[];
}

function splitText(text: string): SplitText {
  const lines: string[] = [];
  const separators: string[] = [];
  const separatorPattern = /\r\n|\n|\r/g;
  let lineStart = 0;
  let match: RegExpExecArray | null;

  while ((match = separatorPattern.exec(text)) !== null) {
    lines.push(text.slice(lineStart, match.index));
    separators.push(match[0]);
    lineStart = separatorPattern.lastIndex;
  }

  lines.push(text.slice(lineStart));
  return { lines, separators };
}

function joinText(lines: string[], separators: string[]): string {
  let text = "";
  for (let index = 0; index < lines.length; index += 1) {
    text += lines[index] ?? "";
    text += separators[index] ?? "";
  }
  return text;
}

function parseOrderedListItem(line: string): ParsedOrderedListItem | null {
  const match = ORDERED_LIST_ITEM_PATTERN.exec(line);
  if (!match) {
    return null;
  }

  const number = Number.parseInt(match[2], 10);
  if (!Number.isSafeInteger(number)) {
    return null;
  }

  return {
    indent: match[1],
    number,
    numberText: match[2]
  };
}

function isIndentedContinuation(line: string, listIndent: string): boolean {
  if (line.trim().length === 0) {
    return false;
  }

  const lineIndent = /^[ \t]*/.exec(line)?.[0] ?? "";
  return lineIndent.length > listIndent.length;
}

function findOrderedListBlockStart(
  lines: string[],
  lineIndex: number,
  listIndent: string
): number {
  for (let previousIndex = lineIndex - 1; previousIndex >= 0; previousIndex -= 1) {
    const previousItem = parseOrderedListItem(lines[previousIndex] ?? "");
    if (previousItem?.indent === listIndent) {
      return previousIndex;
    }

    if (isIndentedContinuation(lines[previousIndex] ?? "", listIndent)) {
      continue;
    }

    return lineIndex;
  }

  return lineIndex;
}

function collectOrderedListBlockEdits(
  lines: string[],
  startIndex: number,
  listIndent: string,
  firstNumber: number
): OrderedListRenumberEdit[] {
  const edits: OrderedListRenumberEdit[] = [];
  let expectedNumber = firstNumber;

  for (let lineIndex = startIndex; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const item = parseOrderedListItem(line);
    if (item?.indent === listIndent) {
      const nextNumberText = String(expectedNumber);
      if (item.numberText !== nextNumberText) {
        const startColumn = item.indent.length + 1;
        edits.push({
          endColumn: startColumn + item.numberText.length,
          lineNumber: lineIndex + 1,
          startColumn,
          text: nextNumberText
        });
      }
      expectedNumber += 1;
      continue;
    }

    if (isIndentedContinuation(line, listIndent)) {
      continue;
    }

    break;
  }

  return edits;
}

/** Returns the number-prefix edits needed to normalize ordered-list blocks. */
export function getOrderedListRenumberEdits(text: string): OrderedListRenumberEdit[] {
  const { lines } = splitText(text);
  const edits: OrderedListRenumberEdit[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const item = parseOrderedListItem(lines[lineIndex] ?? "");
    if (!item || findOrderedListBlockStart(lines, lineIndex, item.indent) !== lineIndex) {
      continue;
    }

    edits.push(...collectOrderedListBlockEdits(lines, lineIndex, item.indent, item.number));
  }

  return edits;
}

/** Pure text form of ordered-list normalization. */
export function renumberOrderedLists(text: string): string {
  const { lines, separators } = splitText(text);
  const nextLines = [...lines];

  for (const edit of getOrderedListRenumberEdits(text)) {
    const lineIndex = edit.lineNumber - 1;
    const line = nextLines[lineIndex] ?? "";
    nextLines[lineIndex] =
      line.slice(0, edit.startColumn - 1) +
      edit.text +
      line.slice(edit.endColumn - 1);
  }

  return joinText(nextLines, separators);
}

/** Computes the prefix inserted after Enter on a non-empty list item. */
export function getListContinuationPrefix(beforeCursor: string): string | null {
  const match = LIST_PREFIX_PATTERN.exec(beforeCursor);
  if (!match || beforeCursor.slice(match[0].length).trim().length === 0) {
    return null;
  }

  if (match[2]) {
    const number = Number.parseInt(match[2], 10);
    if (!Number.isSafeInteger(number)) {
      return match[0];
    }
    return `${match[1]}${number + 1}.${match[3]}`;
  }

  return match[0];
}
