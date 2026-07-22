import assert from "node:assert/strict";
import test from "node:test";

import type { ArticleSummary, ProjectTaskRecord } from "@blog-system/content-core";

import {
  buildProjectTaskRows,
  findProjectTaskDescendantIds,
  formatProjectTaskOptionLabel,
  getProjectTaskNoteQuery,
  resolveProjectTaskNoteLinks
} from "./project-task-utils";

function createTask(overrides: Partial<ProjectTaskRecord> & Pick<ProjectTaskRecord, "id" | "title">): ProjectTaskRecord {
  return {
    body: "",
    createdAt: "2026-04-28T00:00:00.000Z",
    dueDate: "",
    excerpt: "",
    order: 1,
    parentTaskId: "",
    rawContent: "",
    startDate: "2026-04-28",
    status: "todo",
    updatedAt: "2026-04-28T00:00:00.000Z",
    ...overrides
  };
}

function createArticle(path: string, title: string): ArticleSummary {
  return {
    date: undefined,
    directory: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    excerpt: "",
    fileName: path.split("/").at(-1) ?? path,
    isProtected: false,
    path,
    slug: title.toLowerCase().replace(/\s+/g, "-"),
    status: "draft",
    summary: undefined,
    tags: [],
    title,
    top: 0,
    urlPath: `/posts/${title.toLowerCase().replace(/\s+/g, "-")}/`
  };
}

test("buildProjectTaskRows flattens nested tasks with depth", () => {
  const rows = buildProjectTaskRows([
    createTask({ id: "parent", order: 1, title: "Parent" }),
    createTask({ id: "child", order: 2, parentTaskId: "parent", title: "Child" }),
    createTask({ id: "grandchild", order: 3, parentTaskId: "child", title: "Grandchild" })
  ]);

  assert.deepEqual(
    rows.map((row) => ({
      depth: row.depth,
      id: row.task.id
    })),
    [
      { depth: 0, id: "parent" },
      { depth: 1, id: "child" },
      { depth: 2, id: "grandchild" }
    ]
  );
  assert.equal(formatProjectTaskOptionLabel(rows[2].task, rows[2].depth), "|  |- Grandchild");
});

test("buildProjectTaskRows can promote visible children when parents are filtered out", () => {
  const rows = buildProjectTaskRows(
    [
      createTask({ id: "completed-parent", status: "completed", title: "Completed Parent" }),
      createTask({ id: "todo-child", parentTaskId: "completed-parent", title: "Todo Child" })
    ],
    {
      include: (task) => task.status === "todo",
      promoteHiddenParents: true
    }
  );

  assert.deepEqual(
    rows.map((row) => ({
      depth: row.depth,
      id: row.task.id
    })),
    [{ depth: 0, id: "todo-child" }]
  );
});

test("findProjectTaskDescendantIds returns nested descendants", () => {
  const descendants = findProjectTaskDescendantIds(
    [
      createTask({ id: "parent", title: "Parent" }),
      createTask({ id: "child", parentTaskId: "parent", title: "Child" }),
      createTask({ id: "grandchild", parentTaskId: "child", title: "Grandchild" })
    ],
    "parent"
  );

  assert.deepEqual([...descendants].sort(), ["child", "grandchild"]);
});

test("resolveProjectTaskNoteLinks matches note titles with spaces", () => {
  const articles = [
    createArticle("notes/kickoff.md", "Kickoff Notes"),
    createArticle("notes/plan.md", "Implementation Plan")
  ];

  const resolved = resolveProjectTaskNoteLinks(
    "Review @note/Kickoff Notes before continuing with @note/Implementation Plan tomorrow.",
    articles
  );

  assert.deepEqual(
    resolved.map((entry) => entry.article.path),
    ["notes/kickoff.md", "notes/plan.md"]
  );
});

test("getProjectTaskNoteQuery recognizes partial note mentions", () => {
  assert.deepEqual(getProjectTaskNoteQuery("See @n"), {
    query: "",
    replacementText: "@n"
  });
  assert.deepEqual(getProjectTaskNoteQuery("See @note/Kick"), {
    query: "Kick",
    replacementText: "@note/Kick"
  });
});
