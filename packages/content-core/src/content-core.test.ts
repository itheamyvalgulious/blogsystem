import assert from "node:assert/strict";
import test from "node:test";

import {
  applyMarkdownBlockRules,
  buildThemeColorModeVariantCss,
  builtInMarkdownBlockRules,
  createDefaultSlug,
  defaultMarkdownBlockConfig,
  extractHeadings,
  extractMarkdownBlocks,
  inferThemeColorModeFromCss,
  isProjectTaskCompletedStatus,
  normalizeEditorAssociations,
  normalizeArticleForSave,
  normalizeAdminHomeConfig,
  normalizeMarkdownBlockConfig,
  normalizeThemeGroupConfig,
  parseProjectLogRecord,
  parseProjectRecord,
  parseProjectTaskRecord,
  renderMarkdown,
  renderMarkdownFragmentWithKatex,
  renderMarkdownWithKatex,
  rewriteRelativeAssetUrls,
  toArticleSummary,
  type MarkdownBlockRule,
  type MarkdownFenceRendererDefinition,
  type ArticleRecord,
  validateEditorConfigShape
} from "./index.js";

test("normalizeArticleForSave fills title from first H1", () => {
  const record = normalizeArticleForSave(
    "notes/example.md",
    `---
tags:
  - one
status: draft
---

# Filled Title

Body`
  );

  assert.equal(record.title, "Filled Title");
  assert.match(record.rawContent, /title: Filled Title/);
});

test("normalizeArticleForSave migrates legacy state to status", () => {
  const record = normalizeArticleForSave(
    "notes/legacy.md",
    `---
state: published
---

# Legacy`
  );

  assert.equal(record.status, "published");
  assert.match(record.rawContent, /status: published/);
  assert.doesNotMatch(record.rawContent, /^state:/m);
});

test("normalizeArticleForSave preserves summary frontmatter", () => {
  const record = normalizeArticleForSave(
    "notes/summary.md",
    `---
summary: keep me?
---

# Summary`
  );

  assert.equal(record.summary, "keep me?");
  assert.match(record.rawContent, /^summary: keep me\?/m);
});

test("normalizeArticleForSave preserves unquoted yaml dates", () => {
  const record = normalizeArticleForSave(
    "notes/date.md",
    `---
date: 2024-01-02T03:04:05.000Z
---

# Date`
  );

  assert.equal(record.date, "2024-01-02T03:04:05.000Z");
});

test("normalizeArticleForSave preserves password frontmatter", () => {
  const record = normalizeArticleForSave(
    "notes/protected.md",
    `---
password: secret-code
---

# Protected`
  );

  assert.equal(record.frontmatter.password, "secret-code");
  assert.equal(record.isProtected, true);
  assert.match(record.rawContent, /password: secret-code/);
});

test("normalizeArticleForSave accepts utf8 bom before frontmatter", () => {
  const record = normalizeArticleForSave(
    "notes/bom.md",
    `\uFEFF---
title: BOM Title
status: published
---

# BOM Title

Body`
  );

  assert.equal(record.title, "BOM Title");
  assert.equal(record.status, "published");
});

test("normalizeArticleForSave treats blank password as unset", () => {
  const record = normalizeArticleForSave(
    "notes/unprotected.md",
    `---
password: "   "
---

# Public`
  );

  assert.equal(record.frontmatter.password, undefined);
  assert.equal(record.isProtected, false);
  assert.doesNotMatch(record.rawContent, /^password:/m);
});

test("createDefaultSlug uses title and date", () => {
  assert.equal(createDefaultSlug("Hello World", "2026-04-13T10:00:00.000Z"), "hello-world-2026-04-13");
});

test("toArticleSummary keeps top metadata", () => {
  const record = normalizeArticleForSave(
    "notes/top.md",
    `---
title: Top
status: published
top: 7
---

# Top`
  ) as ArticleRecord;

  assert.equal(toArticleSummary(record).top, 7);
});

test("toArticleSummary keeps protected metadata flag", () => {
  const record = normalizeArticleForSave(
    "notes/locked.md",
    `---
title: Locked
password: open-sesame
---

# Locked`
  ) as ArticleRecord;

  assert.equal(toArticleSummary(record).isProtected, true);
});

test("rewriteRelativeAssetUrls rewrites local asset references", () => {
  const html = `<p><img src="./assets/demo.svg"><a href="notes/file.pdf">file</a></p>`;
  const rewritten = rewriteRelativeAssetUrls(html, "notes", "/content-files");

  assert.match(rewritten, /src="\/content-files\/notes\/\.\/assets\/demo\.svg"/);
  assert.match(rewritten, /href="\/content-files\/notes\/notes\/file\.pdf"/);
});

test("validateEditorConfigShape allows overlapping VS Code style keybindings", () => {
  const result = validateEditorConfigShape({
    snippets: [
      {
        name: "One",
        key: "Ctrl+S",
        body: "test"
      }
    ],
    keybindings: [
      {
        key: "Ctrl+S",
        command: "-workbench.action.quickOpen"
      }
    ]
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("normalizeEditorAssociations trims values and keeps stable ordering", () => {
  assert.deepEqual(
    normalizeEditorAssociations({
      "*.json": " workbench.code-text ",
      "*.md": "workbench.article-markdown"
    }),
    {
      "*.json": "workbench.code-text",
      "*.md": "workbench.article-markdown"
    }
  );
});

test("project task parsing infers title from the body heading", () => {
  const record = parseProjectTaskRecord(
    "draft-task",
    `---
status: todo
order: 2
parentTaskId: Demo Parent
---

# Draft Task

Body`
  );

  assert.equal(record.id, "draft-task");
  assert.equal(record.title, "Draft Task");
  assert.equal(record.order, 2);
  assert.equal(record.parentTaskId, "demo-parent");
});

test("project parsing normalizes unknown status to active", () => {
  const record = parseProjectRecord(
    "demo-project",
    JSON.stringify({
      title: "Demo Project",
      status: "activef"
    })
  );

  assert.equal(record.status, "active");
});

test("project task parsing normalizes legacy done status to completed", () => {
  const record = parseProjectTaskRecord(
    "done-task",
    `---
status: done
---

# Done Task`
  );

  assert.equal(record.status, "completed");
});

test("project task parsing normalizes unknown status to todo", () => {
  const record = parseProjectTaskRecord(
    "unknown-task",
    `---
status: blocked
---

# Unknown Task`
  );

  assert.equal(record.status, "todo");
});

test("project log parsing builds a title from the first heading", () => {
  const record = parseProjectLogRecord(
    "event-1",
    `---
type: progress
taskIds:
  - Task A
---

## Finished the integration

Notes`
  );

  assert.equal(record.type, "progress");
  assert.equal(record.title, "Finished the integration");
  assert.deepEqual(record.taskIds, ["task-a"]);
});

test("isProjectTaskCompletedStatus matches done and completed", () => {
  assert.equal(isProjectTaskCompletedStatus("done"), true);
  assert.equal(isProjectTaskCompletedStatus("completed"), true);
  assert.equal(isProjectTaskCompletedStatus("todo"), false);
});

test("renderMarkdown outputs math placeholders for preview", async () => {
  const rendered = await renderMarkdown("Inline $a+b$\n\n$$\n\\int_0^1 x dx\n$$");

  assert.match(rendered.html, /class="math-placeholder inline"/);
  assert.match(rendered.html, /class="math-placeholder block"/);
  assert.doesNotMatch(rendered.html, /katex/);
});

test("renderMarkdownWithKatex keeps server-side math rendering", async () => {
  const rendered = await renderMarkdownWithKatex("$a+b$");

  assert.match(rendered.html, /katex/);
});

test("extractMarkdownBlocks returns top-level markdown ranges", () => {
  const markdown = ["# Title", "", "Paragraph one.", "", "$$", "x+y", "$$"].join("\n");
  const blocks = extractMarkdownBlocks(markdown);

  assert.equal(blocks.length, 3);
  assert.equal(blocks[0].startLine, 1);
  assert.equal(blocks[0].endLine, 1);
  assert.equal(blocks[1].startLine, 3);
  assert.equal(blocks[1].endLine, 3);
  assert.equal(blocks[2].startLine, 5);
  assert.match(blocks[2].source, /\$\$/);
});

test("extractHeadings includes source line numbers and ignores code fences", () => {
  const markdown = ["# Intro", "", "```md", "# Ignored", "```", "", "Section", "---", "", "## Deep"].join("\n");
  const headings = extractHeadings(markdown);

  assert.deepEqual(
    headings.map((heading) => ({
      depth: heading.depth,
      text: heading.text,
      lineNumber: heading.lineNumber
    })),
    [
      { depth: 1, text: "Intro", lineNumber: 1 },
      { depth: 2, text: "Section", lineNumber: 7 },
      { depth: 2, text: "Deep", lineNumber: 10 }
    ]
  );
});

test("extractMarkdownBlocks keeps paired html containers together", async () => {
  const markdown = ["<div>", "", "asdfasdf", "", "</div>"].join("\n");
  const blocks = extractMarkdownBlocks(markdown);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startLine, 1);
  assert.equal(blocks[0].endLine, 5);
  assert.equal(blocks[0].source, markdown);

  const html = await renderMarkdownFragmentWithKatex(blocks[0].source);
  assert.match(html, /^<div>\s*<p>asdfasdf<\/p>\s*<\/div>$/);
});

test("extractMarkdownBlocks keeps nested html containers together", () => {
  const markdown = ["<div>", "", "<section>", "", "# hi", "", "</section>", "", "</div>"].join("\n");
  const blocks = extractMarkdownBlocks(markdown);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].source, markdown);
});

test("extractMarkdownBlocks keeps paired custom elements together", () => {
  const markdown = ["<x-demo data-mode=\"callout\">", "", "text", "", "</x-demo>"].join("\n");
  const blocks = extractMarkdownBlocks(markdown);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].source, markdown);
});

test("extractMarkdownBlocks leaves unmatched and self-closing html nodes unchanged", () => {
  const unmatchedMarkdown = ["<div>", "", "text"].join("\n");
  const unmatchedBlocks = extractMarkdownBlocks(unmatchedMarkdown);

  assert.equal(unmatchedBlocks.length, 2);
  assert.equal(unmatchedBlocks[0].source, "<div>");
  assert.equal(unmatchedBlocks[1].source, "text");

  const selfClosingMarkdown = ["<div />", "", "text"].join("\n");
  const selfClosingBlocks = extractMarkdownBlocks(selfClosingMarkdown);

  assert.equal(selfClosingBlocks.length, 2);
  assert.equal(selfClosingBlocks[0].source, "<div />");
  assert.equal(selfClosingBlocks[1].source, "text");
});

test("renderMarkdownFragmentWithKatex renders math html", async () => {
  const html = await renderMarkdownFragmentWithKatex("$$\\n\\frac{1}{2}\\n$$");

  assert.match(html, /katex/);
});

test("renderMarkdownWithKatex applies fence renderers", async () => {
  const renderer: MarkdownFenceRendererDefinition = {
    language: "commutative",
    name: "test-graph",
    render(context) {
      return {
        cssText: ".demo-graph { color: red; }",
        html: `<div class="demo-graph">${context.content.trim()}</div>`
      };
    }
  };
  const rendered = await renderMarkdownWithKatex(
    "```commutative\n{\"demo\":true}\n```",
    null,
    [renderer]
  );

  assert.match(rendered.html, /data-markdown-fence-renderers/);
  assert.match(rendered.html, /class="demo-graph"/);
  assert.equal(rendered.errors?.length ?? 0, 0);
});

test("renderMarkdownWithKatex reports fence renderer errors", async () => {
  const renderer: MarkdownFenceRendererDefinition = {
    language: "commutative",
    name: "broken-graph",
    render() {
      throw new Error("bad graph");
    }
  };
  const rendered = await renderMarkdownWithKatex(
    "```commutative\n{}\n```",
    null,
    [renderer]
  );

  assert.equal(rendered.errors?.length, 1);
  assert.equal(rendered.errors?.[0]?.rendererName, "broken-graph");
  assert.match(rendered.html, /<pre><code class="(?:hljs )?language-commutative">/);
});

test("applyMarkdownBlockRules converts nested custom markers into html tags", () => {
  const markdown = [
    "::cbox",
    "outside",
    "::pbox",
    "inside",
    "::/pbox",
    "::/cbox"
  ].join("\n");
  const config = normalizeMarkdownBlockConfig({
    rules: [
      { start: "::cbox", end: "::/cbox", tag: "div", class: ["cbox"] },
      { start: "::pbox", end: "::/pbox", tag: "div", class: ["pbox"] }
    ]
  });

  const output = applyMarkdownBlockRules(markdown, config);

  assert.equal(
    output,
    ["<div class=\"cbox\">", "outside", "<div class=\"pbox\">", "inside", "</div>", "</div>"].join("\n")
  );
});

test("renderMarkdownWithKatex supports bracketed marker syntax", async () => {
  const rendered = await renderMarkdownWithKatex(
    ["[conc]", "", "hello", "", "[/conc]"].join("\n"),
    {
      rules: [
        {
          start: "[conc]",
          end: "[/conc]",
          tag: "div",
          class: ["cbox"]
        }
      ]
    }
  );

  assert.match(rendered.html, /class="cbox"/);
  assert.match(rendered.html, /hello/);
});

test("applyMarkdownBlockRules supports identical start and end markers as toggles", () => {
  const output = applyMarkdownBlockRules(
    ["%%box%%", "inside", "%%box%%"].join("\n"),
    {
      rules: [
        {
          start: "%%box%%",
          end: "%%box%%",
          tag: "div",
          class: ["bbox"]
        }
      ]
    }
  );

  assert.equal(output, ["<div class=\"bbox\">", "inside", "</div>"].join("\n"));
});

test("applyMarkdownBlockRules throws when markers close out of order", () => {
  assert.throws(
    () =>
      applyMarkdownBlockRules(
        ["::cbox", "::/pbox"].join("\n"),
        {
          rules: [
            { start: "::cbox", end: "::/cbox", tag: "div", class: ["cbox"] },
            { start: "::pbox", end: "::/pbox", tag: "div", class: ["pbox"] }
          ]
        }
      ),
    /must close/
  );
});

test("builtInMarkdownBlockRules exports the nopdf rule", () => {
  assert.equal(builtInMarkdownBlockRules.length, 1);
  const rule: MarkdownBlockRule = builtInMarkdownBlockRules[0];
  assert.equal(rule.start, "[nopdf]");
  assert.equal(rule.end, "[/nopdf]");
  assert.equal(rule.tag, "div");
  assert.deepEqual(rule.class, ["no-pdf"]);
});

test("defaultMarkdownBlockConfig includes built-in rules", () => {
  assert.equal(defaultMarkdownBlockConfig.rules.length, 1);
  assert.equal(defaultMarkdownBlockConfig.rules[0].start, "[nopdf]");
  assert.equal(defaultMarkdownBlockConfig.rules[0].end, "[/nopdf]");
});

test("applyMarkdownBlockRules renders nopdf block with no config", () => {
  const output = applyMarkdownBlockRules(
    ["[nopdf]", "hidden content", "[/nopdf]"].join("\n")
  );

  assert.match(output, /<div class="no-pdf">/);
  assert.match(output, /hidden content/);
  assert.match(output, /<\/div>/);
});

test("applyMarkdownBlockRules renders nopdf block with null config", () => {
  const output = applyMarkdownBlockRules(
    ["[nopdf]", "more hidden", "[/nopdf]"].join("\n"),
    null
  );

  assert.match(output, /<div class="no-pdf">/);
  assert.match(output, /more hidden/);
  assert.match(output, /<\/div>/);
});

test("applyMarkdownBlockRules merges built-in nopdf with user rules", () => {
  const output = applyMarkdownBlockRules(
    ["[nopdf]", "pdf skip", "[/nopdf]", "", "::cbox", "visible", "::/cbox"].join("\n"),
    {
      rules: [
        { start: "::cbox", end: "::/cbox", tag: "div", class: ["cbox"] }
      ]
    }
  );

  assert.match(output, /<div class="no-pdf">/);
  assert.match(output, /pdf skip/);
  assert.match(output, /<div class="cbox">/);
  assert.match(output, /visible/);
});

test("applyMarkdownBlockRules user rule cannot shadow built-in nopdf start marker", () => {
  const output = applyMarkdownBlockRules(
    ["[nopdf]", "shadow attempt", "[/nopdf]"].join("\n"),
    {
      rules: [
        { start: "[nopdf]", end: "[/nopdf]", tag: "span", class: ["shadow"] }
      ]
    }
  );

  // Built-in rule takes priority (first in merged list), so output uses div.no-pdf
  assert.match(output, /<div class="no-pdf">/);
  assert.doesNotMatch(output, /<span/);
  assert.match(output, /shadow attempt/);
});

test("renderMarkdownWithKatex supports nopdf block with default config (no custom config)", async () => {
  const rendered = await renderMarkdownWithKatex(
    ["[nopdf]", "", "print-hidden", "", "[/nopdf]"].join("\n")
  );

  assert.match(rendered.html, /class="no-pdf"/);
  assert.match(rendered.html, /print-hidden/);
});

test("renderMarkdownWithKatex supports nopdf block alongside user custom rules", async () => {
  const rendered = await renderMarkdownWithKatex(
    ["[nopdf]", "", "pdf-only", "", "[/nopdf]", "", "[conc]", "", "always", "", "[/conc]"].join("\n"),
    {
      rules: [
        { start: "[conc]", end: "[/conc]", tag: "div", class: ["cbox"] }
      ]
    }
  );

  assert.match(rendered.html, /class="no-pdf"/);
  assert.match(rendered.html, /pdf-only/);
  assert.match(rendered.html, /class="cbox"/);
  assert.match(rendered.html, /always/);
});

test("applyMarkdownBlockRules preserves existing custom block behavior with no nopdf markers", () => {
  const output = applyMarkdownBlockRules(
    ["::cbox", "unchanged", "::/cbox"].join("\n"),
    {
      rules: [
        { start: "::cbox", end: "::/cbox", tag: "div", class: ["cbox"] }
      ]
    }
  );

  assert.equal(output, ["<div class=\"cbox\">", "unchanged", "</div>"].join("\n"));
});

test("normalizeAdminHomeConfig keeps widget order unique", () => {
  const config = normalizeAdminHomeConfig({
    widgetOrder: ["widget-a", "widget-a", "widget-b"],
    widgets: {
      "widget-a": {
        items: []
      }
    }
  });

  assert.deepEqual(config.widgetOrder, ["widget-a", "widget-b"]);
});

test("normalizeThemeGroupConfig keeps group mode and css color mode", () => {
  const config = normalizeThemeGroupConfig({
    enable: true,
    files: [
      {
        adminPreview: true,
        colorMode: "dark",
        fileName: "prose.dark",
        type: "css"
      },
      {
        adminPreview: false,
        fileName: "custom",
        type: "js"
      }
    ],
    label: "Atlas",
    mode: "dark"
  });

  assert.equal(config.mode, "dark");
  assert.deepEqual(config.files, [
    {
      adminPreview: true,
      colorMode: "dark",
      fileName: "prose.dark.css",
      type: "css"
    },
    {
      adminPreview: false,
      fileName: "custom.js",
      type: "js"
    }
  ]);
});

test("inferThemeColorModeFromCss detects light and dark themes", () => {
  const lightCss = `
:root {
  --bg: #f5f1e8;
  --ink: #1f2937;
}

body {
  background: var(--bg);
  color: var(--ink);
}`;
  const darkCss = `
:root {
  --bg: #0f1720;
  --ink: #e6edf5;
}

body {
  background: var(--bg);
  color: var(--ink);
}`;

  assert.equal(inferThemeColorModeFromCss(lightCss), "light");
  assert.equal(inferThemeColorModeFromCss(darkCss), "dark");
});

test("buildThemeColorModeVariantCss flips representative light colors into a dark variant", () => {
  const lightCss = `
body {
  background: #f5f1e8;
  color: #1f2937;
  border-color: rgba(31, 41, 55, 0.12);
}`;
  const darkCss = buildThemeColorModeVariantCss(lightCss, "light", "dark");

  assert.equal(inferThemeColorModeFromCss(darkCss), "dark");
  assert.match(darkCss, /background:\s*#/i);
  assert.match(darkCss, /color:\s*#/i);
});
