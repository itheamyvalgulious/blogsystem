import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import request from "supertest";

import { createApp } from "./app.js";

async function setupTempApp() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blog-system-server-"));
  const assetsRoot = path.join(tempRoot, "assets");
  const configRoot = path.join(tempRoot, "config");
  const contentRoot = path.join(tempRoot, "content");
  const projectsRoot = path.join(tempRoot, "projects");
  const editorConfigDir = path.join(configRoot, "editor");
  await fs.mkdir(path.join(contentRoot, "notes"), { recursive: true });
  await fs.mkdir(assetsRoot, { recursive: true });
  await fs.mkdir(editorConfigDir, { recursive: true });
  await fs.mkdir(projectsRoot, { recursive: true });

  await fs.writeFile(
    path.join(contentRoot, "notes", "draft.md"),
    `---
title: Draft Note
tags: [draft]
status: draft
---

# Draft Note
`,
    "utf8"
  );
  await fs.writeFile(path.join(editorConfigDir, "snippets.json"), "[]\n", "utf8");
  await fs.writeFile(path.join(editorConfigDir, "keybindings.json"), "[]\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "index.html"), "<!doctype html><title>Site Home</title><h1>Site Home</h1>", "utf8");
  await fs.writeFile(path.join(tempRoot, "404.html"), "<!doctype html><title>Site 404</title><h1>Site 404</h1>", "utf8");
  await fs.mkdir(path.join(tempRoot, "posts", "demo"), { recursive: true });
  await fs.writeFile(
    path.join(tempRoot, "posts", "demo", "index.html"),
    "<!doctype html><title>Demo Article</title><h1>Demo Article</h1>",
    "utf8"
  );

  const app = createApp({
    contentRoot,
    editorConfigDir,
    adminUsername: "admin",
    adminPassword: "secret",
    sessionSecret: "test-secret",
    adminDistDir: tempRoot,
    siteDistDir: tempRoot,
    port: 0,
    npmCommand: process.platform === "win32" ? "npm.cmd" : "npm",
    projectRoot: tempRoot,
    projectsRoot,
    workspaceRoot: tempRoot,
    configRoot,
    assetsRoot
  });
  const agent = request.agent(app);

  await agent.post("/api/auth/login").send({ username: "admin", password: "secret" }).expect(200);

  return { tempRoot, assetsRoot, contentRoot, projectsRoot, app, agent };
}

test("site dist is served from the server root with static 404 fallback", async () => {
  const { agent } = await setupTempApp();

  await agent.get("/").expect(200).expect(/Site Home/);
  await agent.get("/posts/demo/").expect(200).expect(/Demo Article/);
  await agent.get("/missing-page/").expect(404).expect(/Site 404/);
});

test("raw content/media/theme static mounts require authentication", async () => {
  const { app } = await setupTempApp();
  const anon = request.agent(app);

  // draft.md exists in contentRoot; an unauthenticated reader must not get the
  // raw markdown (which would include protected articles' frontmatter password).
  await anon.get("/content-files/notes/draft.md").expect(401);
  await anon.get("/media/anything.png").expect(401);
  await anon.get("/theme-files/anything").expect(401);
});

test("authenticated requests can still read raw content via static mounts", async () => {
  const { agent } = await setupTempApp();

  await agent.get("/content-files/notes/draft.md").expect(200).expect(/Draft Note/);
});

test("save endpoint fills missing title from first heading", async () => {
  const { agent } = await setupTempApp();
  const response = await agent
    .put("/api/article")
    .send({
      path: "notes/new-entry.md",
      rawContent: `---
tags: [one]
status: draft
---

# Auto Title
`
    })
    .expect(200);

  assert.equal(response.body.title, "Auto Title");
  assert.match(response.body.rawContent, /title: Auto Title/);
});

test("publishing a draft writes the publish date", async () => {
  const { agent } = await setupTempApp();
  const response = await agent
    .post("/api/article/status")
    .send({
      path: "notes/draft.md",
      status: "published"
    })
    .expect(200);

  assert.equal(response.body.status, "published");
  assert.match(response.body.date, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(response.body.rawContent, /^status: published/m);
});

test("publishing keeps an existing date unchanged", async () => {
  const { agent, contentRoot } = await setupTempApp();
  const existingDate = "2024-01-02T03:04:05.000Z";
  await fs.writeFile(
    path.join(contentRoot, "notes", "dated-draft.md"),
    `---
title: Dated Draft
status: draft
date: ${existingDate}
---

# Dated Draft
`,
    "utf8"
  );

  const response = await agent
    .post("/api/article/status")
    .send({
      path: "notes/dated-draft.md",
      status: "published"
    })
    .expect(200);

  assert.equal(response.body.date, existingDate);
  assert.match(response.body.rawContent, /^date:/m);
  assert.match(response.body.rawContent, new RegExp(existingDate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("pasting an image stores it in the workspace media library", async () => {
  const { agent, assetsRoot } = await setupTempApp();
  const response = await agent
    .post("/api/assets/paste-image")
    .send({
      articlePath: "notes/draft.md",
      images: [
        {
          mimeType: "image/png",
          base64Data: Buffer.from("fakepngbytes").toString("base64"),
          fileName: "clipboard.png"
        }
      ]
    })
    .expect(200);

  assert.equal(response.body.assets.length, 1);
  assert.match(response.body.assets[0].markdownPath, /^@media\//);

  const files = await fs.readdir(assetsRoot);
  assert.equal(files.length, 1);
});

test("editor config endpoint accepts VS Code style snippet objects and jsonc", async () => {
  const { agent, tempRoot } = await setupTempApp();

  const response = await agent
    .put("/api/editor-config")
    .send({
      markdownSnippetsRaw: `{
  // markdown snippets
  "Article Frontmatter": {
    "prefix": "frontmatter",
    "body": [
      "---",
      "title: $1",
      "$0"
    ],
  }
}`,
      latexSnippetsRaw: `{
  "divide": {
    "scope": "latex,tex",
    "prefix": [
      "/",
      "\\\\frac"
    ],
    "body": "\\\\dfrac{$1}{$2} $0"
  }
}`,
      keybindingsRaw: `[
  {
    "key": "ctrl+p",
    "command": "workbench.action.showCommands"
  },
  {
    "key": "escape",
    "command": "hideSuggestWidget",
    "when": "suggestWidgetVisible"
  },
]`,
      editorAssociationsRaw: `{
  "*.md": "workbench.article-markdown",
  "*.json": "workbench.code-text"
}`
    })
    .expect(200);

  assert.equal(response.body.markdownSnippets[0].name, "Article Frontmatter");
  assert.equal(response.body.latexSnippets[0].name, "divide");
  assert.equal(response.body.keybindings[0].command, "workbench.action.showCommands");
  assert.equal(response.body.editorAssociations["*.md"], "workbench.article-markdown");

  const persistedLatexRaw = await fs.readFile(path.join(tempRoot, "config", "editor", "latex.snippets.json"), "utf8");
  const persistedEditorAssociationsRaw = await fs.readFile(
    path.join(tempRoot, "config", "editor", "editor.associations.json"),
    "utf8"
  );
  assert.match(persistedLatexRaw, /"divide": \{/);
  assert.doesNotMatch(persistedLatexRaw, /"name": "divide"/);
  assert.match(persistedEditorAssociationsRaw, /"\*\.md": "workbench\.article-markdown"/);
});

test("file system endpoints create, rename, copy, and delete entries", async () => {
  const { agent, contentRoot } = await setupTempApp();

  const created = await agent
    .post("/api/fs/create")
    .send({
      parentPath: "notes",
      entryType: "file",
      name: "playwright.md",
      metadata: {
        title: "Created From Dialog",
        tags: "alpha, beta",
        top: "3"
      }
    })
    .expect(200);

  assert.equal(created.body.path, "notes/playwright.md");
  const createdRaw = await fs.readFile(path.join(contentRoot, "notes", "playwright.md"), "utf8");
  assert.match(createdRaw, /^title: Created From Dialog/m);
  assert.match(createdRaw, /^top: 3/m);
  assert.match(createdRaw, /- alpha/);

  const renamed = await agent
    .post("/api/fs/rename")
    .send({
      path: "notes/playwright.md",
      nextName: "renamed.md"
    })
    .expect(200);

  assert.equal(renamed.body.path, "notes/renamed.md");

  const copied = await agent
    .post("/api/fs/transfer")
    .send({
      sourcePath: "notes/renamed.md",
      targetDirectoryPath: "",
      mode: "copy"
    })
    .expect(200);

  assert.equal(copied.body.path, "renamed.md");

  await agent
    .post("/api/fs/delete")
    .send({
      path: "renamed.md"
    })
    .expect(200);

  await assert.rejects(() => fs.access(path.join(contentRoot, "renamed.md")));
  await fs.access(path.join(contentRoot, "notes", "renamed.md"));
});

test("directory metadata tags are inherited at read time, not baked into file source", async () => {
  const { agent, contentRoot } = await setupTempApp();

  await agent
    .post("/api/fs/create")
    .send({
      parentPath: "notes",
      entryType: "directory",
      name: "tagged",
      metadata: {
        tags: "folder-tag"
      }
    })
    .expect(200);

  await agent
    .post("/api/fs/create")
    .send({
      parentPath: "notes/tagged",
      entryType: "file",
      name: "child.md",
      metadata: {
        title: "Child"
      }
    })
    .expect(200);

  const childRaw = await fs.readFile(path.join(contentRoot, "notes", "tagged", "child.md"), "utf8");
  // Tags from folder metadata should NOT be baked into the file source
  assert.doesNotMatch(childRaw, /- folder-tag/);
});

test("saving file metadata persists summary and password fields", async () => {
  const { agent, contentRoot } = await setupTempApp();

  await agent
    .post("/api/fs/metadata")
    .send({
      path: "notes/draft.md",
      metadata: {
        summary: "Draft summary",
        password: "draft-pass",
        status: "working",
        date: "2026-06-12T10:00:00.000Z",
        slug: "draft-note-custom"
      }
    })
    .expect(200);

  const savedRaw = await fs.readFile(path.join(contentRoot, "notes", "draft.md"), "utf8");
  assert.match(savedRaw, /^summary: Draft summary/m);
  assert.match(savedRaw, /^password: draft-pass/m);
  assert.match(savedRaw, /^status: working/m);
  assert.match(savedRaw, /^date: '?2026-06-12T10:00:00.000Z'?/m);
  assert.match(savedRaw, /^slug: draft-note-custom/m);
});

test("saving file metadata does not bake inherited folder password into article frontmatter", async () => {
  const { agent, contentRoot } = await setupTempApp();

  await agent
    .post("/api/fs/create")
    .send({
      parentPath: "notes",
      entryType: "directory",
      name: "inherited",
      metadata: {
        password: "folder-pass"
      }
    })
    .expect(200);

  await agent
    .post("/api/fs/create")
    .send({
      parentPath: "notes/inherited",
      entryType: "file",
      name: "child.md",
      metadata: {
        title: "Child"
      }
    })
    .expect(200);

  await agent
    .post("/api/fs/metadata")
    .send({
      path: "notes/inherited/child.md",
      metadata: {
        summary: "Child summary"
      }
    })
    .expect(200);

  const childRaw = await fs.readFile(path.join(contentRoot, "notes", "inherited", "child.md"), "utf8");
  assert.match(childRaw, /^summary: Child summary/m);
  assert.doesNotMatch(childRaw, /^password: folder-pass/m);
});

test("clearing folder metadata removes the folder metadata indicator", async () => {
  const { agent, contentRoot } = await setupTempApp();

  const findFolder = (
    nodes: Array<{ path?: string; type?: string; children?: unknown[]; hasMetadata?: boolean }>,
    target: string
  ): { hasMetadata?: boolean } | undefined => {
    for (const node of nodes) {
      if (node.path === target && node.type === "directory") {
        return node;
      }
      if (node.children) {
        const found = findFolder(node.children as Array<{ path?: string; type?: string; children?: unknown[]; hasMetadata?: boolean }>, target);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };

  await agent
    .post("/api/fs/create")
    .send({ parentPath: "notes", entryType: "directory", name: "meta-folder" })
    .expect(200);

  await agent
    .post("/api/fs/metadata")
    .send({ path: "notes/meta-folder", metadata: { title: "Meta Folder" } })
    .expect(200);

  const metadataPath = path.join(contentRoot, "notes", "meta-folder", ".blog-system-folder.json");
  await fs.access(metadataPath);

  const treeWithMeta = (await agent.get("/api/tree").expect(200)).body.fileTree as Array<{
    path?: string;
    type?: string;
    children?: unknown[];
  }>;
  assert.equal(findFolder(treeWithMeta, "notes/meta-folder")?.hasMetadata, true);

  await agent
    .post("/api/fs/metadata")
    .send({
      path: "notes/meta-folder",
      metadata: {
        title: "",
        status: "",
        date: "",
        summary: "",
        slug: "",
        password: "",
        tags: [],
        top: ""
      }
    })
    .expect(200);

  const treeWithoutMeta = (await agent.get("/api/tree").expect(200)).body.fileTree as Array<{
    path?: string;
    type?: string;
    children?: unknown[];
  }>;
  assert.equal(findFolder(treeWithoutMeta, "notes/meta-folder")?.hasMetadata, false);

  await assert.rejects(() => fs.access(metadataPath));
});

test("a folder with a legacy empty metadata file does not show a metadata indicator", async () => {
  const { agent, contentRoot } = await setupTempApp();

  const findFolder = (
    nodes: Array<{ path?: string; type?: string; children?: unknown[]; hasMetadata?: boolean }>,
    target: string
  ): { hasMetadata?: boolean } | undefined => {
    for (const node of nodes) {
      if (node.path === target && node.type === "directory") {
        return node;
      }
      if (node.children) {
        const found = findFolder(node.children as Array<{ path?: string; type?: string; children?: unknown[]; hasMetadata?: boolean }>, target);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  };

  await agent
    .post("/api/fs/create")
    .send({ parentPath: "notes", entryType: "directory", name: "empty-meta" })
    .expect(200);

  // Simulate a leftover empty "{}" metadata file (the state the user reported).
  await fs.writeFile(
    path.join(contentRoot, "notes", "empty-meta", ".blog-system-folder.json"),
    "{}\n",
    "utf8"
  );

  const tree = (await agent.get("/api/tree").expect(200)).body.fileTree as Array<{
    path?: string;
    type?: string;
    children?: unknown[];
  }>;
  assert.equal(findFolder(tree, "notes/empty-meta")?.hasMetadata, false);
});

test("saveFileSystemMetadata accepts comma-separated string tags and normalizes them", async () => {
  const { agent, contentRoot } = await setupTempApp();

  await agent
    .post("/api/fs/create")
    .send({ parentPath: "notes", entryType: "directory", name: "str-tags" })
    .expect(200);

  await agent
    .post("/api/fs/metadata")
    .send({ path: "notes/str-tags", metadata: { tags: "alpha, beta " } })
    .expect(200);

  const raw = await fs.readFile(path.join(contentRoot, "notes", "str-tags", ".blog-system-folder.json"), "utf8");
  const parsed = JSON.parse(raw) as { tags?: unknown };
  assert.deepEqual(parsed.tags, ["alpha", "beta"]);
});

test("creating an article with a duplicate title returns a conflict payload", async () => {
  const { agent } = await setupTempApp();

  const response = await agent
    .post("/api/fs/create")
    .send({
      parentPath: "notes",
      entryType: "file",
      name: "duplicate-title.md",
      metadata: {
        title: "Draft Note"
      }
    })
    .expect(409);

  assert.equal(response.body.code, "duplicate_article_title");
  assert.equal(response.body.conflicts[0].path, "notes/draft.md");
});

test("creating articles with the same title in different directories succeeds", async () => {
  const { agent, contentRoot } = await setupTempApp();

  // Create "notes" directory already exists from setup.
  await fs.mkdir(path.join(contentRoot, "posts"), { recursive: true });

  const first = await agent
    .post("/api/fs/create")
    .send({
      parentPath: "notes",
      entryType: "file",
      name: "dup.md",
      metadata: { title: "Same" }
    })
    .expect(200);

  assert.equal(first.body.path, "notes/dup.md");

  const second = await agent
    .post("/api/fs/create")
    .send({
      parentPath: "posts",
      entryType: "file",
      name: "dup.md",
      metadata: { title: "Same" }
    })
    .expect(200);

  assert.equal(second.body.path, "posts/dup.md");
});

test("renaming an article to a duplicate title in the same directory returns a conflict", async () => {
  const { agent } = await setupTempApp();

  await agent
    .post("/api/fs/create")
    .send({
      parentPath: "notes",
      entryType: "file",
      name: "alpha.md",
      metadata: { title: "Alpha" }
    })
    .expect(200);

  await agent
    .post("/api/fs/create")
    .send({
      parentPath: "notes",
      entryType: "file",
      name: "beta.md",
      metadata: { title: "Beta" }
    })
    .expect(200);

  // Rename beta.md to title "Alpha" → conflict with alpha.md
  const response = await agent
    .post("/api/fs/rename")
    .send({
      path: "notes/beta.md",
      nextName: "beta.md",
      title: "Alpha"
    })
    .expect(409);

  assert.equal(response.body.code, "duplicate_article_title");
  assert.equal(response.body.conflicts[0].path, "notes/alpha.md");
});

test("allowDuplicateTitle overrides same-directory duplicate title on create", async () => {
  const { agent } = await setupTempApp();

  // The initial setup already has "notes/draft.md" with title "Draft Note".
  const response = await agent
    .post("/api/fs/create")
    .send({
      parentPath: "notes",
      entryType: "file",
      name: "another-draft.md",
      metadata: { title: "Draft Note" },
      allowDuplicateTitle: true
    })
    .expect(200);

  assert.equal(response.body.path, "notes/another-draft.md");
});

test("config endpoints expose markdown block rules and admin home defaults", async () => {
  const { agent } = await setupTempApp();

  const markdownBlocks = await agent.get("/api/markdown-block-config").expect(200);
  assert.deepEqual(markdownBlocks.body.value.rules, []);

  const adminHome = await agent.get("/api/admin-home-config").expect(200);
  assert.deepEqual(adminHome.body.value.widgetOrder, []);
  assert.deepEqual(adminHome.body.value.widgets, {});
});

test("publish config endpoint exposes and saves v2 config", async () => {
  const { agent, tempRoot } = await setupTempApp();

  const initial = await agent.get("/api/publish-config").expect(200);
  assert.equal(initial.body.value.defaultTarget, "github");
  assert.deepEqual(initial.body.value.targets, {});

  const saved = await agent
    .put("/api/publish-config")
    .send({
      raw: `{
  "defaultTarget": "github",
  "targets": {
    "github": {
      "deployRepo": "https://github.com/example/site.git",
      "deployBranch": "main",
      "siteBasePath": ""
    }
  }
}`
    })
    .expect(200);

  assert.equal(saved.body.value.targets.github.deployRepo, "https://github.com/example/site.git");
  const persisted = await fs.readFile(path.join(tempRoot, "config", "site-publish.local.json"), "utf8");
  assert.match(persisted, /"defaultTarget": "github"/);
});

test("usage stats endpoint persists net delta and active time", async () => {
  const { agent, tempRoot } = await setupTempApp();

  const initialStats = await agent.get("/api/usage-stats").expect(200);
  assert.equal(initialStats.body.value.totalNetCharacterDelta, 0);
  assert.equal(initialStats.body.value.totalActiveMilliseconds, 0);

  const recordedStats = await agent
    .post("/api/usage-stats")
    .send({
      activeMilliseconds: 90000,
      documents: [
        {
          documentId: "article:notes/draft.md",
          documentKind: "article",
          title: "Draft Note",
          netCharacterDelta: 12
        },
        {
          documentId: "article:notes/draft.md",
          documentKind: "article",
          title: "Draft Note",
          netCharacterDelta: -5
        }
      ]
    })
    .expect(200);

  assert.equal(recordedStats.body.value.totalActiveMilliseconds, 90000);
  assert.equal(recordedStats.body.value.totalNetCharacterDelta, 7);
  assert.equal(recordedStats.body.value.documents[0].netCharacterDelta, 7);
  assert.equal(recordedStats.body.value.daily.length, 1);
  assert.equal(recordedStats.body.value.daily[0].totalNetCharacterDelta, 7);
  assert.equal(recordedStats.body.value.daily[0].activeMilliseconds, 90000);

  const persistedRaw = await fs.readFile(path.join(tempRoot, "config", "usage-stats.json"), "utf8");
  assert.match(persistedRaw, /"daily": \[/);
  assert.match(persistedRaw, /"totalActiveMilliseconds": 90000/);
  assert.match(persistedRaw, /"netCharacterDelta": 7/);
});

test("usage stats period key follows local calendar day instead of UTC midnight", async () => {
  const { agent } = await setupTempApp();
  const originalDateNow = Date.now;
  const mockedNow = new Date("2026-05-04T16:30:00.000Z").valueOf();

  Date.now = () => mockedNow;

  try {
    const recordedStats = await agent
      .post("/api/usage-stats")
      .send({
        activeMilliseconds: 1000,
        documents: [
          {
            documentId: "article:notes/draft.md",
            documentKind: "article",
            title: "Draft Note",
            netCharacterDelta: 1
          }
        ]
      })
      .expect(200);

    const localDate = new Date(mockedNow);
    const expectedPeriodKey = new Date(
      localDate.getTime() - localDate.getTimezoneOffset() * 60_000
    )
      .toISOString()
      .slice(0, 10);

    assert.equal(recordedStats.body.value.daily[0].periodKey, expectedPeriodKey);
  } finally {
    Date.now = originalDateNow;
  }
});

test("site config rejects legacy about payloads", async () => {
  const { agent } = await setupTempApp();

  const response = await agent
    .put("/api/site-config")
    .send({
      raw: `{
  "siteTitle": "Knowledge Base",
  "enabledPlugins": ["home"],
  "about": {
    "title": "About",
    "body": "Legacy field"
  }
}`
    })
    .expect(500);

  assert.match(response.body.error, /siteConfig must NOT have additional properties/);
});

test("project endpoints create tasks, logs, and derived stats", async () => {
  const { agent, projectsRoot } = await setupTempApp();

  const createdProject = await agent
    .post("/api/project/create")
    .send({
      goal: "Ship the project workspace",
      targetDate: "2026-05-31",
      title: "Demo Project"
    })
    .expect(200);

  assert.equal(createdProject.body.value.id, "demo-project");
  assert.equal(createdProject.body.value.status, "active");
  assert.equal(createdProject.body.value.taskCount, 0);
  assert.match(createdProject.body.value.startDate, /^\d{4}-\d{2}-\d{2}$/);
  await fs.access(path.join(projectsRoot, "demo-project", "project.json"));

  const savedProject = await agent
    .put("/api/project")
    .send({
      projectId: "demo-project",
      raw: (createdProject.body.raw as string).replace('"status": "active"', '"status": "archieved"')
    })
    .expect(200);

  assert.equal(savedProject.body.value.status, "active");

  const createdTask = await agent
    .post("/api/project/task/create")
    .send({
      projectId: "demo-project",
      title: "Implement UI"
    })
    .expect(200);

  const createdChildTask = await agent
    .post("/api/project/task/create")
    .send({
      projectId: "demo-project",
      title: "Write tests"
    })
    .expect(200);

  const savedTask = await agent
    .put("/api/project/task")
    .send({
      projectId: "demo-project",
      taskId: createdTask.body.value.id,
      raw: `${(createdTask.body.raw as string).replace("status: todo", "status: blocked")}\nUpdated task body.\n`
    })
    .expect(200);

  assert.equal(savedTask.body.value.status, "todo");

  const savedChildTask = await agent
    .put("/api/project/task")
    .send({
      projectId: "demo-project",
      taskId: createdChildTask.body.value.id,
      raw: (createdChildTask.body.raw as string).replace("parentTaskId: ''", `parentTaskId: ${createdTask.body.value.id}`)
    })
    .expect(200);

  assert.equal(savedChildTask.body.value.parentTaskId, createdTask.body.value.id);

  const createdLog = await agent
    .post("/api/project/log/create")
    .send({
      projectId: "demo-project",
      taskId: createdTask.body.value.id,
      type: "progress"
    })
    .expect(200);

  assert.deepEqual(createdLog.body.value.taskIds, [createdTask.body.value.id]);

  const savedLog = await agent
    .put("/api/project/log")
    .send({
      projectId: "demo-project",
      logId: createdLog.body.value.id,
      raw: `${createdLog.body.raw}\nCaptured progress update.\n`
    })
    .expect(200);
  assert.equal(savedLog.body.value.type, "progress");

  const listedProjects = await agent.get("/api/projects").expect(200);
  assert.equal(listedProjects.body.projects[0].taskCount, 2);
  assert.equal(listedProjects.body.projects[0].completedTaskCount, 0);
  assert.equal(listedProjects.body.projects[0].recentActivityCount, 1);
});

test("project delete endpoint removes the project directory and listings", async () => {
  const { agent, projectsRoot } = await setupTempApp();

  await agent
    .post("/api/project/create")
    .send({
      title: "Delete Me"
    })
    .expect(200);

  const createdTask = await agent
    .post("/api/project/task/create")
    .send({
      projectId: "delete-me",
      title: "Temporary Task"
    })
    .expect(200);

  const createdLog = await agent
    .post("/api/project/log/create")
    .send({
      projectId: "delete-me",
      type: "note"
    })
    .expect(200);

  assert.ok(createdTask.body.value.id);
  assert.ok(createdLog.body.value.id);
  await fs.access(path.join(projectsRoot, "delete-me"));

  await agent
    .post("/api/project/delete")
    .send({
      projectId: "delete-me"
    })
    .expect(200);

  await assert.rejects(() => fs.access(path.join(projectsRoot, "delete-me")));

  const listedProjects = await agent.get("/api/projects").expect(200);
  assert.equal(listedProjects.body.projects.some((project: { id: string }) => project.id === "delete-me"), false);
});

test("theme group endpoints seed atlas and allow group asset creation", async () => {
  const { agent, tempRoot } = await setupTempApp();

  const seeded = await agent.get("/api/theme-groups").expect(200);
  assert.equal(seeded.body.groups[0].groupId, "atlas");
  assert.equal(seeded.body.groups[0].mode, "light");
  assert.equal(seeded.body.groups[0].files.length >= 4, true);
  assert.ok(seeded.body.groups[0].files.some((file: { fileName: string; colorMode?: string }) => file.fileName === "chrome.light.css" && file.colorMode === "light"));
  assert.ok(seeded.body.groups[0].files.some((file: { fileName: string; colorMode?: string }) => file.fileName === "chrome.dark.css" && file.colorMode === "dark"));

  const createdGroup = await agent
    .post("/api/theme-group/create")
    .send({
      groupId: "chalk"
    })
    .expect(200);

  assert.equal(createdGroup.body.groupId, "chalk");

  const createdAsset = await agent
    .post("/api/theme-asset/create")
    .send({
      groupId: "chalk",
      fileName: "notes",
      type: "css",
      adminPreview: true
    })
    .expect(200);

  assert.equal(createdAsset.body.fileName, "notes.light.css");
  assert.equal(createdAsset.body.adminPreview, true);
  assert.equal(createdAsset.body.colorMode, "light");
  await fs.access(path.join(tempRoot, "config", "theme", "chalk", "notes.light.css"));
});

test("markdown search preview returns all regex matches across files", async () => {
  const { agent, contentRoot } = await setupTempApp();

  await fs.writeFile(
    path.join(contentRoot, "notes", "second.md"),
    `---
title: Second Note
status: draft
---

Alpha one
Alpha two
Alpha three
`,
    "utf8"
  );

  const response = await agent
    .post("/api/search/markdown/preview")
    .send({
      pattern: "Alpha",
      replace: "Beta",
      scope: "body"
    })
    .expect(200);

  assert.equal(response.body.summary.filesMatched, 1);
  assert.equal(response.body.summary.matchesFound, 3);
  assert.equal(response.body.results[0].matches.length, 3);
  assert.equal(response.body.results[0].matches[2].lineNumber, 8);
});

test("markdown search replace-next applies one match at a time and returns next selection", async () => {
  const { agent, contentRoot } = await setupTempApp();

  await fs.writeFile(
    path.join(contentRoot, "notes", "replace-next.md"),
    `---
title: Replace Next
status: draft
---

foo
foo
foo
`,
    "utf8"
  );

  const preview = await agent
    .post("/api/search/markdown/preview")
    .send({
      pattern: "foo",
      replace: "bar",
      scope: "body"
    })
    .expect(200);

  const firstMatchKey = preview.body.results[0].matches[0].key as string;
  const replaced = await agent
    .post("/api/search/markdown/replace-next")
    .send({
      pattern: "foo",
      replace: "bar",
      scope: "body",
      matchKey: firstMatchKey
    })
    .expect(200);

  assert.equal(replaced.body.applied.replacementsMade, 1);
  assert.equal(replaced.body.summary.matchesFound, 2);
  assert.ok(replaced.body.applied.nextSelectionKey);

  const saved = await fs.readFile(path.join(contentRoot, "notes", "replace-next.md"), "utf8");
  assert.match(saved, /bar/);
  assert.match(saved, /foo\nfoo/);
});

test("markdown search supports capture group replacements with $1 syntax", async () => {
  const { agent, contentRoot } = await setupTempApp();

  await fs.writeFile(
    path.join(contentRoot, "notes", "capture.md"),
    `---
title: Capture
status: draft
---

Hello Alice
Hello Bob
`,
    "utf8"
  );

  const response = await agent
    .post("/api/search/markdown/replace-all")
    .send({
      flags: "m",
      pattern: "Hello\\s+(\\w+)",
      replace: "Hi, $1!",
      scope: "body"
    })
    .expect(200);

  assert.equal(response.body.applied.replacementsMade, 2);

  const saved = await fs.readFile(path.join(contentRoot, "notes", "capture.md"), "utf8");
  assert.match(saved, /Hi, Alice!/);
  assert.match(saved, /Hi, Bob!/);
});
