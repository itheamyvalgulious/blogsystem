import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { loadAdminCredentials } from "./config.js";
import { ConfigValidationError } from "./errors.js";

async function setupConfigRoot() {
  return mkdtemp(path.join(tmpdir(), "blog-system-admin-credentials-"));
}

async function writeCredentials(configRoot: string, raw: string) {
  await writeFile(path.join(configRoot, "admin.local.json"), raw, "utf8");
}

test("loadAdminCredentials returns {} when the file is missing", async () => {
  const configRoot = await setupConfigRoot();
  try {
    assert.deepEqual(loadAdminCredentials(configRoot), {});
  } finally {
    await rm(configRoot, { force: true, recursive: true });
  }
});

test("loadAdminCredentials reads and trims all fields", async () => {
  const configRoot = await setupConfigRoot();
  try {
    await writeCredentials(
      configRoot,
      `{ "adminUsername": " root ", "adminPassword": " pw ", "sessionSecret": " sec " }`
    );
    assert.deepEqual(loadAdminCredentials(configRoot), {
      adminUsername: "root",
      adminPassword: "pw",
      sessionSecret: "sec"
    });
  } finally {
    await rm(configRoot, { force: true, recursive: true });
  }
});

test("loadAdminCredentials keeps partial fields", async () => {
  const configRoot = await setupConfigRoot();
  try {
    await writeCredentials(configRoot, `{ "adminPassword": "pw" }`);
    assert.deepEqual(loadAdminCredentials(configRoot), { adminPassword: "pw" });
  } finally {
    await rm(configRoot, { force: true, recursive: true });
  }
});

test("loadAdminCredentials rejects malformed files", async () => {
  const configRoot = await setupConfigRoot();
  try {
    await writeCredentials(configRoot, "not json");
    assert.throws(() => loadAdminCredentials(configRoot), ConfigValidationError);

    await writeCredentials(configRoot, `["pw"]`);
    assert.throws(() => loadAdminCredentials(configRoot), ConfigValidationError);

    await writeCredentials(configRoot, `{ "adminPassword": 42 }`);
    assert.throws(() => loadAdminCredentials(configRoot), ConfigValidationError);

    await writeCredentials(configRoot, `{ "adminUsername": "  " }`);
    assert.throws(() => loadAdminCredentials(configRoot), ConfigValidationError);
  } finally {
    await rm(configRoot, { force: true, recursive: true });
  }
});
