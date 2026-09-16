import assert from "node:assert/strict";
import test from "node:test";

import { scanHeadingsFromText, findActiveMarkdownOutlineItemId } from "./markdown-outline";

test("scanHeadingsFromText offsets frontmatter lines and nests headings", () => {
  const rawContent = [
    "---",
    "title: Demo",
    "---",
    "",
    "# Intro",
    "",
    "```md",
    "# Ignored",
    "```",
    "",
    "Section",
    "---",
    "",
    "## Deep"
  ].join("\n");

  const headings = scanHeadingsFromText(rawContent);

  assert.equal(headings.length, 2);
  assert.equal(headings[0].text, "Intro");
  assert.equal(headings[0].lineNumber, 5);
  assert.equal(headings[1].text, "Deep");
  assert.equal(headings[1].lineNumber, 14);
});

test("findActiveMarkdownOutlineItemId returns the closest heading above the cursor", () => {
  const headings = scanHeadingsFromText(
    ["# Intro", "", "## Setup", "", "## Usage", "", "### Detail"].join("\n")
  );

  assert.equal(findActiveMarkdownOutlineItemId(headings, 1), headings[0].id);
  assert.equal(findActiveMarkdownOutlineItemId(headings, 4), headings[1].id);
  assert.equal(findActiveMarkdownOutlineItemId(headings, 7), headings[3].id);
});
