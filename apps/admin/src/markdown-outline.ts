import GithubSlugger from "github-slugger";

export interface CachedHeading {
  depth: number;
  text: string;
  id: string;
  lineNumber: number;
  lineHash: number;
}

export interface MarkdownOutlineItem {
  depth: number;
  text: string;
  id: string;
  lineNumber: number;
  children: MarkdownOutlineItem[];
}

export function hashLine(line: string): number {
  let hash = 0;
  for (let i = 0; i < line.length; i++) {
    hash = ((hash << 5) - hash + line.charCodeAt(i)) | 0;
  }
  return hash;
}

export function scanHeadingsFromText(text: string): CachedHeading[] {
  const lines = text.split("\n");
  const headings: CachedHeading[] = [];
  const slugger = new GithubSlugger();
  let inFence = false;
  let fenceMarker: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const fenceMatch = /^(?<marker>`{3,}|~{3,})/.exec(trimmed);

    if (fenceMatch) {
      const marker = fenceMatch.groups!.marker;
      if (fenceMarker === marker) {
        inFence = false;
        fenceMarker = null;
        continue;
      }
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
        continue;
      }
    }

    if (inFence) continue;

    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const text = headingMatch[2].trim();
      if (text) {
        headings.push({
          depth: headingMatch[1].length,
          text,
          id: slugger.slug(text),
          lineNumber: i + 1,
          lineHash: hashLine(line)
        });
      }
    }
  }

  return headings;
}

export function buildOutlineTree(headings: CachedHeading[]): MarkdownOutlineItem[] {
  const roots: MarkdownOutlineItem[] = [];
  const stack: MarkdownOutlineItem[] = [];

  for (const h of headings) {
    const node: MarkdownOutlineItem = {
      depth: h.depth,
      text: h.text,
      id: h.id,
      lineNumber: h.lineNumber,
      children: []
    };

    while (stack.length > 0 && stack.at(-1)!.depth >= node.depth) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack.at(-1)!.children.push(node);
    }

    stack.push(node);
  }

  return roots;
}

export function findActiveMarkdownOutlineItemId(
  headings: CachedHeading[],
  lineNumber: number | null
): string | null {
  if (!Number.isFinite(lineNumber) || headings.length === 0) {
    return null;
  }

  const target = Number(lineNumber);
  let low = 0;
  let high = headings.length - 1;
  let result: string | null = null;

  while (low <= high) {
    const mid = (low + high) >>> 1;
    if (headings[mid].lineNumber <= target) {
      result = headings[mid].id;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}
