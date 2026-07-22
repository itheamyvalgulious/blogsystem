import type { ArticleSummary, ProjectTaskRecord } from "@blog-system/content-core";

const NOTE_MENTION_PREFIX = "@note/";

export interface ProjectTaskTreeNode {
  children: ProjectTaskTreeNode[];
  task: ProjectTaskRecord;
}

export interface ProjectTaskListRow {
  depth: number;
  hasChildren: boolean;
  task: ProjectTaskRecord;
}

export interface ProjectTaskNoteLink {
  article: ArticleSummary;
  mentionText: string;
  startOffset: number;
}

export interface ProjectTaskNoteQuery {
  query: string;
  replacementText: string;
}

function compareProjectTasks(left: ProjectTaskRecord, right: ProjectTaskRecord) {
  if (left.order !== right.order) {
    return left.order - right.order;
  }

  if (left.updatedAt !== right.updatedAt) {
    return right.updatedAt.localeCompare(left.updatedAt);
  }

  return left.title.localeCompare(right.title);
}

function sortArticlesByMentionPriority(articles: ArticleSummary[]) {
  return [...articles].sort((left, right) => {
    if (left.title.length !== right.title.length) {
      return right.title.length - left.title.length;
    }

    const titleComparison = left.title.localeCompare(right.title);
    if (titleComparison !== 0) {
      return titleComparison;
    }

    return left.path.localeCompare(right.path);
  });
}

function isMentionBoundary(value: string) {
  return !value || !/[0-9A-Za-z_-]/.test(value);
}

export function buildProjectTaskTree(tasks: ProjectTaskRecord[]) {
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const childTaskIds = new Map<string, string[]>();
  const rootTasks = tasks.filter((task) => !task.parentTaskId || !taskById.has(task.parentTaskId) || task.parentTaskId === task.id);
  const sortedTasks = [...tasks].sort(compareProjectTasks);

  sortedTasks.forEach((task) => {
    if (!task.parentTaskId || !taskById.has(task.parentTaskId) || task.parentTaskId === task.id) {
      return;
    }

    const siblings = childTaskIds.get(task.parentTaskId) ?? [];
    siblings.push(task.id);
    childTaskIds.set(task.parentTaskId, siblings);
  });

  const visited = new Set<string>();

  const buildNode = (task: ProjectTaskRecord, stack: Set<string>): ProjectTaskTreeNode => {
    visited.add(task.id);
    stack.add(task.id);
    const childIds = childTaskIds.get(task.id) ?? [];
    const children = childIds
      .map((childId) => taskById.get(childId))
      .filter((child): child is ProjectTaskRecord => child !== undefined && !stack.has(child.id))
      .sort(compareProjectTasks)
      .map((child) => buildNode(child, new Set(stack)));

    return {
      children,
      task
    };
  };

  const tree = rootTasks.sort(compareProjectTasks).map((task) => buildNode(task, new Set<string>()));

  sortedTasks.forEach((task) => {
    if (visited.has(task.id)) {
      return;
    }

    tree.push(buildNode(task, new Set<string>()));
  });

  return tree;
}

export function buildProjectTaskRows(
  tasks: ProjectTaskRecord[],
  options?: {
    include?: (task: ProjectTaskRecord) => boolean;
    promoteHiddenParents?: boolean;
  }
) {
  const include = options?.include ?? (() => true);
  const rows: ProjectTaskListRow[] = [];

  const visit = (node: ProjectTaskTreeNode, depth: number) => {
    const visible = include(node.task);
    if (visible) {
      rows.push({
        depth,
        hasChildren: node.children.length > 0,
        task: node.task
      });
    }

    node.children.forEach((child) => {
      visit(child, visible || !options?.promoteHiddenParents ? depth + 1 : depth);
    });
  };

  buildProjectTaskTree(tasks).forEach((node) => visit(node, 0));
  return rows;
}

export function findProjectTaskDescendantIds(tasks: ProjectTaskRecord[], taskId: string) {
  const childTaskIds = new Map<string, string[]>();

  tasks.forEach((task) => {
    if (!task.parentTaskId || task.parentTaskId === task.id) {
      return;
    }

    const children = childTaskIds.get(task.parentTaskId) ?? [];
    children.push(task.id);
    childTaskIds.set(task.parentTaskId, children);
  });

  const descendants = new Set<string>();
  const queue = [...(childTaskIds.get(taskId) ?? [])];

  while (queue.length > 0) {
    const nextTaskId = queue.shift() as string;
    if (descendants.has(nextTaskId)) {
      continue;
    }

    descendants.add(nextTaskId);
    queue.push(...(childTaskIds.get(nextTaskId) ?? []));
  }

  return descendants;
}

export function formatProjectTaskOptionLabel(task: ProjectTaskRecord, depth: number) {
  if (depth <= 0) {
    return task.title;
  }

  return `${"|  ".repeat(Math.max(0, depth - 1))}|- ${task.title}`;
}

export function formatProjectTaskReferences(taskIds: string[], taskById: Map<string, ProjectTaskRecord>) {
  return taskIds.map((taskId) => taskById.get(taskId)?.title || taskId).join(", ");
}

export function getProjectTaskNoteQuery(linePrefix: string): ProjectTaskNoteQuery | null {
  const startIndex = linePrefix.lastIndexOf("@");
  if (startIndex === -1) {
    return null;
  }

  const replacementText = linePrefix.slice(startIndex);
  const normalizedReplacementText = replacementText.toLowerCase();
  if (!NOTE_MENTION_PREFIX.startsWith(normalizedReplacementText) && !normalizedReplacementText.startsWith(NOTE_MENTION_PREFIX)) {
    return null;
  }

  return {
    query: normalizedReplacementText.startsWith(NOTE_MENTION_PREFIX)
      ? replacementText.slice(NOTE_MENTION_PREFIX.length)
      : "",
    replacementText
  };
}

export function getProjectTaskNoteSuggestions(query: string, articles: ArticleSummary[]) {
  const normalizedQuery = query.trim().toLowerCase();
  const sorted = [...articles].sort((left, right) => {
    const titleComparison = left.title.localeCompare(right.title);
    if (titleComparison !== 0) {
      return titleComparison;
    }

    return left.path.localeCompare(right.path);
  });

  if (!normalizedQuery) {
    return sorted;
  }

  return sorted.filter((article) => {
    const title = article.title.toLowerCase();
    const path = article.path.toLowerCase();
    return title.includes(normalizedQuery) || path.includes(normalizedQuery);
  });
}

export function resolveProjectTaskNoteLinks(body: string, articles: ArticleSummary[]) {
  const resolved: ProjectTaskNoteLink[] = [];
  const seenPaths = new Set<string>();
  const sortedArticles = sortArticlesByMentionPriority(articles);
  const lowerBody = body.toLowerCase();
  let searchIndex = 0;

  while (searchIndex < body.length) {
    const mentionIndex = lowerBody.indexOf(NOTE_MENTION_PREFIX, searchIndex);
    if (mentionIndex === -1) {
      break;
    }

    const titleStart = mentionIndex + NOTE_MENTION_PREFIX.length;
    const matchedArticle = sortedArticles.find((article) => {
      const lowerTitle = article.title.toLowerCase();
      const titleEnd = titleStart + lowerTitle.length;

      return (
        lowerBody.slice(titleStart, titleEnd) === lowerTitle &&
        isMentionBoundary(body.slice(titleEnd, titleEnd + 1))
      );
    });

    if (!matchedArticle) {
      searchIndex = titleStart;
      continue;
    }

    if (!seenPaths.has(matchedArticle.path)) {
      seenPaths.add(matchedArticle.path);
      resolved.push({
        article: matchedArticle,
        mentionText: `${NOTE_MENTION_PREFIX}${matchedArticle.title}`,
        startOffset: mentionIndex
      });
    }

    searchIndex = titleStart + matchedArticle.title.length;
  }

  return resolved;
}
