import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import request from "supertest";

import {
  completeAiInline,
  loadAiCompletionConfig,
  resolveAiCompletionStatus,
  saveAiCompletionConfig
} from "./ai-completion-service.js";
import { createApp } from "./app.js";
import { ApiError, ConfigValidationError } from "./errors.js";

const AI_COMPLETION_ENV_KEYS = [
  "AI_COMPLETION_ENABLED",
  "AI_COMPLETION_BASE_URL",
  "AI_COMPLETION_MODEL",
  "AI_COMPLETION_API_KEY",
  "AI_COMPLETION_PROVIDER"
] as const;

function snapshotAiCompletionEnv() {
  return new Map(AI_COMPLETION_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreAiCompletionEnv(snapshot: Map<string, string | undefined>) {
  for (const key of AI_COMPLETION_ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

function clearAiCompletionEnv() {
  const snapshot = snapshotAiCompletionEnv();
  for (const key of AI_COMPLETION_ENV_KEYS) {
    delete process.env[key];
  }
  return () => restoreAiCompletionEnv(snapshot);
}

function stubFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = handler as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

async function setupConfigRoot() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blog-system-ai-completion-"));
  return path.join(tempRoot, "config");
}

test("loadAiCompletionConfig returns defaults when the file is missing", async () => {
  const configRoot = await setupConfigRoot();

  const payload = await loadAiCompletionConfig(configRoot);

  assert.equal(payload.value.enabled, false);
  assert.equal(payload.value.baseUrl, "https://api.openai.com/v1");
  assert.equal(payload.value.model, "");
  assert.equal(payload.value.maxTokens, 128);
  assert.equal(payload.value.temperature, 0.2);
  assert.match(payload.raw, /"enabled": false/);
});

test("saveAiCompletionConfig persists and loadAiCompletionConfig reads it back", async () => {
  const configRoot = await setupConfigRoot();

  const saved = await saveAiCompletionConfig(
    configRoot,
    `{
  "enabled": true,
  "baseUrl": "https://llm.example.com/v1/",
  "model": "demo-model",
  "apiKey": "sk-test",
  "provider": "anthropic",
  "maxTokens": 32,
  "temperature": 0.5
}`
  );
  assert.equal(saved.value.enabled, true);
  assert.equal(saved.value.model, "demo-model");
  assert.equal(saved.value.provider, "anthropic");

  const loaded = await loadAiCompletionConfig(configRoot);
  assert.deepEqual(loaded.value, saved.value);
  assert.equal(loaded.raw, saved.raw);

  const persisted = await fs.readFile(path.join(configRoot, "ai-completion.local.json"), "utf8");
  assert.match(persisted, /"model": "demo-model"/);
  assert.match(persisted, /"provider": "anthropic"/);
});

test("saveAiCompletionConfig rejects invalid JSON and invalid field types", async () => {
  const configRoot = await setupConfigRoot();

  await assert.rejects(() => saveAiCompletionConfig(configRoot, "{ not json"), SyntaxError);
  await assert.rejects(
    () => saveAiCompletionConfig(configRoot, `{"enabled": "yes", "baseUrl": "x", "model": "m"}`),
    ConfigValidationError
  );
  await assert.rejects(
    () => saveAiCompletionConfig(configRoot, `{"enabled": true, "baseUrl": 3, "model": "m"}`),
    ConfigValidationError
  );
  await assert.rejects(
    () => saveAiCompletionConfig(configRoot, `{"enabled": true, "baseUrl": "x", "model": 2}`),
    ConfigValidationError
  );
  await assert.rejects(
    () => saveAiCompletionConfig(configRoot, `{"enabled": true, "baseUrl": "x", "model": "m", "provider": "gpt"}`),
    ConfigValidationError
  );
  await assert.rejects(
    () => saveAiCompletionConfig(configRoot, `{"enabled": true, "baseUrl": "x", "model": "m", "maxTokens": "64"}`),
    ConfigValidationError
  );
  await assert.rejects(
    () => saveAiCompletionConfig(configRoot, `{"enabled": true, "baseUrl": "x", "model": "m", "temperature": "0.2"}`),
    ConfigValidationError
  );
});

test("resolveAiCompletionStatus applies env overrides without leaking apiKey", async () => {
  const restoreEnv = clearAiCompletionEnv();

  try {
    const configRoot = await setupConfigRoot();

    await saveAiCompletionConfig(
      configRoot,
      `{
  "enabled": false,
  "baseUrl": "https://file.example.com/v1",
  "model": "file-model",
  "apiKey": "sk-secret"
}`
    );

    const fileStatus = await resolveAiCompletionStatus(configRoot);
    assert.deepEqual(fileStatus, {
      enabled: false,
      provider: "openai",
      model: "file-model",
      baseUrl: "https://file.example.com/v1"
    });
    assert.equal("apiKey" in fileStatus, false);

    process.env.AI_COMPLETION_ENABLED = "1";
    process.env.AI_COMPLETION_BASE_URL = "https://env.example.com/v1";
    process.env.AI_COMPLETION_MODEL = "env-model";

    const envStatus = await resolveAiCompletionStatus(configRoot);
    assert.deepEqual(envStatus, {
      enabled: true,
      provider: "openai",
      model: "env-model",
      baseUrl: "https://env.example.com/v1"
    });

    process.env.AI_COMPLETION_ENABLED = "off";
    const ignoredStatus = await resolveAiCompletionStatus(configRoot);
    assert.equal(ignoredStatus.enabled, false);
  } finally {
    restoreEnv();
  }
});

test("resolveAiCompletionStatus honors defaults and AI_COMPLETION_* overrides without a config file", async () => {
  const restoreEnv = clearAiCompletionEnv();

  try {
    // No file, no env: disabled with defaults.
    const configRoot = await setupConfigRoot();
    const defaultStatus = await resolveAiCompletionStatus(configRoot);
    assert.deepEqual(defaultStatus, {
      enabled: false,
      provider: "openai",
      model: "",
      baseUrl: "https://api.openai.com/v1"
    });

    // AI_COMPLETION_* env provides a deployment-level override without any file.
    process.env.AI_COMPLETION_ENABLED = "true";
    process.env.AI_COMPLETION_BASE_URL = "https://api.anthropic.com";
    process.env.AI_COMPLETION_MODEL = "env-model";
    assert.deepEqual(await resolveAiCompletionStatus(configRoot), {
      enabled: true,
      provider: "anthropic",
      model: "env-model",
      baseUrl: "https://api.anthropic.com"
    });

    // Explicit false wins over a file that enables the feature.
    await saveAiCompletionConfig(
      configRoot,
      `{
  "enabled": true,
  "baseUrl": "https://file.example.com/v1",
  "model": "file-model"
}`
    );
    process.env.AI_COMPLETION_ENABLED = "false";
    assert.equal((await resolveAiCompletionStatus(configRoot)).enabled, false);
  } finally {
    restoreEnv();
  }
});

test("resolveAiCompletionStatus resolves provider from env, file, then baseUrl", async () => {
  const restoreEnv = clearAiCompletionEnv();

  try {
    // Auto-detection from baseUrl.
    const autoRoot = await setupConfigRoot();
    process.env.AI_COMPLETION_BASE_URL = "https://gateway.example.com/anthropic-proxy";
    assert.equal((await resolveAiCompletionStatus(autoRoot)).provider, "anthropic");

    // Invalid AI_COMPLETION_PROVIDER is ignored in favor of auto-detection.
    process.env.AI_COMPLETION_PROVIDER = "gpt";
    assert.equal((await resolveAiCompletionStatus(autoRoot)).provider, "anthropic");

    // Explicit AI_COMPLETION_PROVIDER wins over baseUrl detection.
    process.env.AI_COMPLETION_PROVIDER = "openai";
    assert.equal((await resolveAiCompletionStatus(autoRoot)).provider, "openai");
    delete process.env.AI_COMPLETION_PROVIDER;

    // File provider wins over baseUrl detection when no env override exists.
    const fileRoot = await setupConfigRoot();
    await saveAiCompletionConfig(
      fileRoot,
      `{
  "enabled": true,
  "baseUrl": "https://api.anthropic.com",
  "model": "file-model",
  "provider": "openai"
}`
    );
    delete process.env.AI_COMPLETION_BASE_URL;
    assert.equal((await resolveAiCompletionStatus(fileRoot)).provider, "openai");
  } finally {
    restoreEnv();
  }
});

test("completeAiInline returns stripped completion text from the upstream response", async () => {
  const restoreEnv = clearAiCompletionEnv();
  const configRoot = await setupConfigRoot();
  await saveAiCompletionConfig(
    configRoot,
    `{
  "enabled": true,
  "baseUrl": "https://llm.example.com/v1/",
  "model": "demo-model",
  "apiKey": "sk-test"
}`
  );

  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const restoreFetch = stubFetch(async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "```latex\n\\\\end{align*}\n```" } }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const result = await completeAiInline(configRoot, {
      prefix: "\\begin{align*}\n  x &= 1",
      suffix: "",
      language: "latex"
    });

    assert.equal(result.completion, "\\\\end{align*}");
    assert.equal(capturedUrl, "https://llm.example.com/v1/chat/completions");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer sk-test");
    const body = JSON.parse(String(capturedInit?.body)) as {
      model: string;
      max_tokens: number;
      temperature: number;
      stop: string[];
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(body.model, "demo-model");
    assert.equal(body.max_tokens, 128);
    assert.equal(body.temperature, 0.2);
    assert.deepEqual(body.stop, ["\n\n"]);
    assert.match(body.messages[1].content, /<prefix>/);
    assert.match(body.messages[1].content, /<cursor\/>/);
    assert.match(body.messages[1].content, /<suffix>/);
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("completeAiInline strips reasoning <think> blocks from the completion", async () => {
  const restoreEnv = clearAiCompletionEnv();
  const configRoot = await setupConfigRoot();
  await saveAiCompletionConfig(
    configRoot,
    `{
  "enabled": true,
  "baseUrl": "https://llm.example.com/v1",
  "model": "reasoning-model",
  "apiKey": "sk-test"
}`
  );

  const cases: Array<{ content: string; expected: string }> = [
    {
      content: "<think> Euler identity completes the expression. </think> + 1 = 0$",
      expected: "+ 1 = 0$"
    },
    { content: "no thinking here, just text", expected: "no thinking here, just text" },
    // Unclosed block: the whole budget went to reasoning, nothing to insert.
    { content: "<think> still reasoning forever", expected: "" }
  ];

  for (const { content, expected } of cases) {
    const restoreFetch = stubFetch(
      async () =>
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        })
    );
    try {
      const result = await completeAiInline(configRoot, { prefix: "$e^{i\\pi}", suffix: "", language: "latex" });
      assert.equal(result.completion, expected);
    } finally {
      restoreFetch();
    }
  }

  restoreEnv();
});

test("completeAiInline uses the Anthropic messages protocol when provider is anthropic", async () => {
  const restoreEnv = clearAiCompletionEnv();
  const configRoot = await setupConfigRoot();
  await saveAiCompletionConfig(
    configRoot,
    `{
  "enabled": true,
  "baseUrl": "https://api.anthropic.com",
  "model": "claude-demo",
  "apiKey": "sk-ant-test",
  "provider": "anthropic"
}`
  );

  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const restoreFetch = stubFetch(async (url, init) => {
    capturedUrl = url;
    capturedInit = init;
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: "```latex\n\\\\end{align*}\n```" }]
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  });

  try {
    const result = await completeAiInline(configRoot, {
      prefix: "\\begin{align*}\n  x &= 1",
      suffix: "",
      language: "latex"
    });

    assert.equal(result.completion, "\\\\end{align*}");
    // Trailing-slash-less baseUrl gets /v1/messages appended.
    assert.equal(capturedUrl, "https://api.anthropic.com/v1/messages");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers["content-type"], "application/json");
    assert.equal(headers["x-api-key"], "sk-ant-test");
    assert.equal(headers["anthropic-version"], "2023-06-01");
    assert.equal("Authorization" in headers, false);
    const body = JSON.parse(String(capturedInit?.body)) as Record<string, unknown> & {
      model: string;
      max_tokens: number;
      temperature: number;
      system: string;
      stop_sequences: string[];
      messages: Array<{ role: string; content: string }>;
    };
    assert.equal(body.model, "claude-demo");
    assert.equal(body.max_tokens, 128);
    assert.equal(body.temperature, 0.2);
    // system is a top-level field, not a chat message.
    assert.equal(typeof body.system, "string");
    assert.match(body.system, /补全引擎/);
    assert.equal(body.messages.length, 1);
    assert.equal(body.messages[0].role, "user");
    assert.match(body.messages[0].content, /<prefix>/);
    assert.match(body.messages[0].content, /<cursor\/>/);
    assert.match(body.messages[0].content, /<suffix>/);
    assert.deepEqual(body.stop_sequences, ["\n\n"]);
    assert.equal("stop" in body, false);
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("completeAiInline keeps a baseUrl that already ends with /v1/messages", async () => {
  const restoreEnv = clearAiCompletionEnv();
  const configRoot = await setupConfigRoot();
  await saveAiCompletionConfig(
    configRoot,
    `{
  "enabled": true,
  "baseUrl": "https://proxy.example.com/anthropic/v1/messages/",
  "model": "claude-demo"
}`
  );

  let capturedUrl = "";
  const restoreFetch = stubFetch(async (url) => {
    capturedUrl = url;
    return new Response(JSON.stringify({ content: [{ type: "text", text: "done" }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  });

  try {
    // No explicit provider: the "anthropic" substring in the baseUrl selects
    // the Anthropic protocol automatically.
    const result = await completeAiInline(configRoot, { prefix: "a", suffix: "b", language: "markdown" });

    assert.equal(result.completion, "done");
    assert.equal(capturedUrl, "https://proxy.example.com/anthropic/v1/messages");
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("completeAiInline maps Anthropic upstream failures to ApiError 502", async () => {
  const restoreEnv = clearAiCompletionEnv();
  const configRoot = await setupConfigRoot();
  await saveAiCompletionConfig(
    configRoot,
    `{
  "enabled": true,
  "baseUrl": "https://api.anthropic.com",
  "model": "claude-demo",
  "provider": "anthropic"
}`
  );

  const restoreFetch = stubFetch(async () => new Response("upstream boom", { status: 500 }));

  try {
    await assert.rejects(
      () => completeAiInline(configRoot, { prefix: "a", suffix: "b", language: "markdown" }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502);
        assert.equal(error.message, "AI completion request failed.");
        return true;
      }
    );
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("completeAiInline maps upstream failures to ApiError 502", async () => {
  const restoreEnv = clearAiCompletionEnv();
  const configRoot = await setupConfigRoot();
  await saveAiCompletionConfig(
    configRoot,
    `{
  "enabled": true,
  "baseUrl": "https://llm.example.com/v1",
  "model": "demo-model"
}`
  );

  const restoreFetch = stubFetch(async () => new Response("upstream boom", { status: 500 }));

  try {
    await assert.rejects(
      () => completeAiInline(configRoot, { prefix: "a", suffix: "b", language: "markdown" }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502);
        assert.equal(error.message, "AI completion request failed.");
        return true;
      }
    );
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("completeAiInline maps network errors to ApiError 502", async () => {
  const restoreEnv = clearAiCompletionEnv();
  const configRoot = await setupConfigRoot();
  await saveAiCompletionConfig(
    configRoot,
    `{
  "enabled": true,
  "baseUrl": "https://llm.example.com/v1",
  "model": "demo-model"
}`
  );

  const restoreFetch = stubFetch(async () => {
    throw new TypeError("fetch failed");
  });

  try {
    await assert.rejects(
      () => completeAiInline(configRoot, { prefix: "a", suffix: "b", language: "markdown" }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 502);
        return true;
      }
    );
  } finally {
    restoreFetch();
    restoreEnv();
  }
});

test("completeAiInline rejects when completion is disabled or model is empty", async () => {
  const restoreEnv = clearAiCompletionEnv();
  try {
    const configRoot = await setupConfigRoot();

    await assert.rejects(
      () => completeAiInline(configRoot, { prefix: "", suffix: "", language: "markdown" }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        assert.equal(error.message, "AI completion is not enabled.");
        return true;
      }
    );

    await saveAiCompletionConfig(
      configRoot,
      `{
  "enabled": true,
  "baseUrl": "https://llm.example.com/v1",
  "model": ""
}`
    );

    await assert.rejects(
      () => completeAiInline(configRoot, { prefix: "", suffix: "", language: "markdown" }),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.status, 400);
        return true;
      }
    );
  } finally {
    restoreEnv();
  }
});

async function setupTempApp() {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "blog-system-server-ai-"));
  const assetsRoot = path.join(tempRoot, "assets");
  const configRoot = path.join(tempRoot, "config");
  const contentRoot = path.join(tempRoot, "content");
  const projectsRoot = path.join(tempRoot, "projects");
  const editorConfigDir = path.join(configRoot, "editor");
  await fs.mkdir(path.join(contentRoot, "notes"), { recursive: true });
  await fs.mkdir(assetsRoot, { recursive: true });
  await fs.mkdir(editorConfigDir, { recursive: true });
  await fs.mkdir(projectsRoot, { recursive: true });

  await fs.writeFile(path.join(editorConfigDir, "snippets.json"), "[]\n", "utf8");
  await fs.writeFile(path.join(editorConfigDir, "keybindings.json"), "[]\n", "utf8");
  await fs.writeFile(path.join(tempRoot, "index.html"), "<!doctype html><title>Site Home</title>", "utf8");
  await fs.writeFile(path.join(tempRoot, "404.html"), "<!doctype html><title>Site 404</title>", "utf8");

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

  return { tempRoot, configRoot, app, agent };
}

test("ai completion endpoints require authentication", async () => {
  const { app } = await setupTempApp();
  const anon = request.agent(app);

  await anon.post("/api/ai/completion").send({ prefix: "", suffix: "", language: "markdown" }).expect(401);
  await anon.get("/api/ai/completion-config").expect(401);
  await anon.put("/api/ai/completion-config").send({ raw: "{}" }).expect(401);
});

test("ai completion endpoint validates the request body", async () => {
  const { agent } = await setupTempApp();

  await agent.post("/api/ai/completion").send({ suffix: "", language: "markdown" }).expect(400);
  await agent.post("/api/ai/completion").send({ prefix: "", language: "markdown" }).expect(400);
  await agent.post("/api/ai/completion").send({ prefix: "", suffix: "", language: "python" }).expect(400);

  const badPut = await agent.put("/api/ai/completion-config").send({}).expect(400);
  assert.match(badPut.body.error, /raw is required/);
});

test("ai completion endpoint returns completions when enabled", async () => {
  const restoreEnv = clearAiCompletionEnv();
  try {
    const { agent, configRoot } = await setupTempApp();

    await saveAiCompletionConfig(
      configRoot,
      `{
  "enabled": true,
  "baseUrl": "https://llm.example.com/v1",
  "model": "demo-model"
}`
    );

    const restoreFetch = stubFetch(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: "commutes." } }]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

    try {
      const response = await agent
        .post("/api/ai/completion")
        .send({ prefix: "The diagram ", suffix: "", language: "markdown" })
        .expect(200);

      assert.equal(response.body.completion, "commutes.");
    } finally {
      restoreFetch();
    }
  } finally {
    restoreEnv();
  }
});

test("ai completion config endpoint exposes raw, value, and status", async () => {
  const restoreEnv = clearAiCompletionEnv();
  try {
    const { agent } = await setupTempApp();

    const initial = await agent.get("/api/ai/completion-config").expect(200);
    assert.equal(typeof initial.body.raw, "string");
    assert.equal(initial.body.value.enabled, false);
    assert.deepEqual(initial.body.status, {
      enabled: false,
      provider: "openai",
      model: "",
      baseUrl: "https://api.openai.com/v1"
    });
    assert.equal("apiKey" in initial.body.status, false);

    const saved = await agent
      .put("/api/ai/completion-config")
      .send({
        raw: `{
  "enabled": true,
  "baseUrl": "https://llm.example.com/v1",
  "model": "demo-model",
  "apiKey": "sk-test"
}`
      })
      .expect(200);

    assert.equal(saved.body.value.model, "demo-model");
    assert.equal(saved.body.status.enabled, true);
    assert.equal(saved.body.status.model, "demo-model");

    const reloaded = await agent.get("/api/ai/completion-config").expect(200);
    assert.equal(reloaded.body.value.apiKey, "sk-test");
    assert.equal(reloaded.body.status.enabled, true);
  } finally {
    restoreEnv();
  }
});
