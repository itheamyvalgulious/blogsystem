import type { FileSystemNode } from "@blog-system/content-core";

import type { SortOrder, StatusFilter } from "../workbench-session";

export function buildFileTreeMap(nodes: FileSystemNode[]) {
  const entries = new Map<string, FileSystemNode>();
  const visit = (node: FileSystemNode) => {
    entries.set(node.path, node);
    if (node.type === "directory") {
      node.children.forEach(visit);
    }
  };
  nodes.forEach(visit);
  return entries;
}

export function filterFileTreeNode(node: FileSystemNode, searchQuery: string, selectedTag: string, selectedStatus: StatusFilter, showAssets: boolean): boolean {
  const query = searchQuery.trim().toLowerCase();
  if (node.type === "directory") {
    return (
      query.length === 0 ||
      node.name.toLowerCase().includes(query) ||
      node.path.toLowerCase().includes(query) ||
      node.children.some((child) => filterFileTreeNode(child, searchQuery, selectedTag, selectedStatus, showAssets))
    );
  }
  if (!showAssets && node.fileKind === "asset") {
    return false;
  }
  const article = node.article;
  const matchesQuery =
    query.length === 0 ||
    node.name.toLowerCase().includes(query) ||
    node.path.toLowerCase().includes(query) ||
    article?.title.toLowerCase().includes(query) ||
    article?.tags.some((tag) => tag.toLowerCase().includes(query));
  const matchesTag = !article || selectedTag === "all" || article.tags.includes(selectedTag);
  const matchesStatus = !article || selectedStatus === "all" || article.status === selectedStatus;
  return Boolean(matchesQuery && matchesTag && matchesStatus);
}

export function sortTreeNodes(nodes: FileSystemNode[], sortOrder: SortOrder): FileSystemNode[] {
  const now = Date.now();
  return nodes
    .map((node): FileSystemNode => {
      if (node.type === "directory") {
        return { ...node, children: sortTreeNodes(node.children, sortOrder) };
      }
      return node;
    })
    .sort((left, right) => {
      if (left.type === "directory" || right.type === "directory") {
        if (left.type === "directory" && right.type === "directory") {
          return left.name.localeCompare(right.name);
        }
        return left.type === "directory" ? -1 : 1;
      }
      const leftTitle = left.article?.title ?? left.name;
      const rightTitle = right.article?.title ?? right.name;
      if (sortOrder.startsWith("date")) {
        const leftDate = left.fileKind === "asset" ? Infinity
          : left.article?.date ? Date.parse(left.article.date) : now;
        const rightDate = right.fileKind === "asset" ? Infinity
          : right.article?.date ? Date.parse(right.article.date) : now;
        if (leftDate !== rightDate) {
          return sortOrder === "date-inc" ? leftDate - rightDate : rightDate - leftDate;
        }
        return leftTitle.localeCompare(rightTitle) * (sortOrder === "date-inc" ? 1 : -1);
      }
      const titleCmp = leftTitle.localeCompare(rightTitle);
      return sortOrder === "title-inc" ? titleCmp : -titleCmp;
    });
}
