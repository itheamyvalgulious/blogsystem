import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadPublishConfig, normalizePublishConfig } from "../publish-config.js";
import { cloudflareTarget, parseWindowsProxyServer, proxyBypassed } from "./cloudflare.js";
import { githubTarget } from "./github.js";
import {
  _resetRegistryForTests,
  getTarget,
  hasTarget,
  listTargets,
  registerTarget
} from "./index.js";
import { PublishTargetError } from "./types.js";

test("registry exposes the built-in targets", () => {
  assert.ok(hasTarget("github"));
  assert.ok(hasTarget("cloudflare"));
  assert.ok(listTargets().includes("github"));
  assert.ok(listTargets().includes("cloudflare"));
  assert.equal(getTarget("github").id, "github");
});

test("parseWindowsProxyServer reads bare and per-protocol proxy values", () => {
  assert.equal(parseWindowsProxyServer("127.0.0.1:7890"), "http://127.0.0.1:7890");
  assert.equal(
    parseWindowsProxyServer("http=127.0.0.1:7890;https=127.0.0.1:7891"),
    "http://127.0.0.1:7891"
  );
  assert.equal(parseWindowsProxyServer("http=127.0.0.1:7890"), undefined);
  assert.equal(parseWindowsProxyServer("socks=127.0.0.1:7890"), undefined);
  assert.equal(parseWindowsProxyServer("http://proxy.internal:8080"), "http://proxy.internal:8080");
  assert.equal(parseWindowsProxyServer("  "), undefined);
});

test("proxyBypassed matches NO_PROXY entries against the API hostname", () => {
  assert.equal(proxyBypassed("api.cloudflare.com", "*"), true);
  assert.equal(proxyBypassed("api.cloudflare.com", "cloudflare.com"), true);
  assert.equal(proxyBypassed("api.cloudflare.com", ".cloudflare.com"), true);
  assert.equal(proxyBypassed("api.cloudflare.com", "api.cloudflare.com"), true);
  assert.equal(proxyBypassed("api.cloudflare.com", "example.com"), false);
  assert.equal(proxyBypassed("api.cloudflare.com", undefined), false);
  assert.equal(proxyBypassed("api.cloudflare.com", ""), false);
});

test("getTarget throws for unknown ids", () => {
  assert.throws(() => getTarget("nope"), /Unknown publish target/);
});

test("registerTarget can add a custom target after a registry reset", () => {
  const before = listTargets();
  _resetRegistryForTests();
  assert.equal(listTargets().length, 0);
  registerTarget({
    id: "custom",
    validateConfig: (raw) => raw,
    publish: async () => ({ uploaded: 0, skipped: 0, durationMs: 0 })
  });
  assert.ok(hasTarget("custom"));
  registerTarget(githubTarget);
  registerTarget(cloudflareTarget);
  for (const id of before) {
    assert.ok(hasTarget(id));
  }
});

test("github target validates configs", () => {
  assert.throws(
    () => githubTarget.validateConfig({}),
    (error: Error) =>
      error instanceof PublishTargetError &&
      error.target === "github" &&
      /deployRepo/.test(error.message)
  );
});

test("cloudflare target validates configs", () => {
  assert.throws(
    () => cloudflareTarget.validateConfig({ accountId: "a" }),
    (error: Error) =>
      error instanceof PublishTargetError &&
      error.target === "cloudflare" &&
      /accountId/.test(error.message)
  );
});

test("normalizePublishConfig accepts v2 config", () => {
  const cfg = normalizePublishConfig({
    defaultTarget: "cloudflare",
    targets: {
      cloudflare: {
        accountId: "acc",
        projectName: "blog",
        apiToken: "tok",
        branch: "main",
        siteBasePath: ""
      }
    }
  });
  assert.equal(cfg.defaultTarget, "cloudflare");
  assert.equal(cfg.targets.cloudflare?.projectName, "blog");
});

test("loadPublishConfig returns empty v2 when file missing", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blog-system-publish-empty-"));
  try {
    const { config, exists } = await loadPublishConfig(dir);
    assert.equal(exists, false);
    assert.equal(config.defaultTarget, "github");
    assert.deepEqual(config.targets, {});
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

interface CapturedCall {
  bodyForm?: { branch?: string; manifest?: unknown };
  bodyJson?: unknown;
  headers: Record<string, string>;
  method: string;
  url: string;
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) }
  });
}

async function buildDistFixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "blog-system-publish-dist-"));
  await fs.writeFile(path.join(dir, "index.html"), "<html>hello</html>", "utf8");
  await fs.writeFile(path.join(dir, "robots.txt"), "User-agent: *", "utf8");
  await fs.mkdir(path.join(dir, "assets"));
  await fs.writeFile(path.join(dir, "assets", "site.css"), "body{}", "utf8");
  return dir;
}

function installFetchMock(handler: (call: CapturedCall) => Response | Promise<Response>) {
  const calls: CapturedCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as URL).toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const key of Object.keys(h)) {
        headers[key.toLowerCase()] = h[key];
      }
    }
    let bodyJson: unknown;
    let bodyForm: { branch?: string; manifest?: unknown } | undefined;
    if (init?.body instanceof FormData) {
      const manifest = init.body.get("manifest");
      const branch = init.body.get("branch");
      bodyForm = {
        manifest: typeof manifest === "string" ? JSON.parse(manifest) : undefined,
        branch: typeof branch === "string" ? branch : undefined
      };
    } else if (typeof init?.body === "string") {
      bodyJson = JSON.parse(init.body);
    }
    const call: CapturedCall = { bodyForm, bodyJson, headers, method, url };
    calls.push(call);
    return handler(call);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = realFetch;
    }
  };
}

test("cloudflare target follows upload-token to deployment flow", async () => {
  const distDir = await buildDistFixture();
  try {
    const cfg = cloudflareTarget.validateConfig({
      accountId: "acc_42",
      projectName: "blog",
      apiToken: "tok_xyz"
    });
    const mock = installFetchMock(async (call) => {
      if (call.method === "GET" && call.url.endsWith("/upload-token")) {
        return jsonResponse({ success: true, result: { jwt: "jwt_token" } });
      }
      if (call.method === "POST" && call.url.endsWith("/check-missing")) {
        const hashes = (call.bodyJson as { hashes: string[] }).hashes;
        return jsonResponse({ success: true, result: hashes.slice(0, 2) });
      }
      if (call.method === "POST" && call.url.endsWith("/pages/assets/upload")) {
        return jsonResponse({ success: true, result: {} });
      }
      if (call.method === "POST" && call.url.endsWith("/pages/assets/upsert-hashes")) {
        return jsonResponse({ success: true });
      }
      if (call.method === "POST" && call.url.endsWith("/deployments")) {
        return jsonResponse({ success: true, result: { id: "dep_1", url: "https://blog.pages.dev" } });
      }
      if (call.method === "GET" && /\/deployments\/dep_1$/.test(call.url)) {
        return jsonResponse({
          success: true,
          result: {
            aliases: ["blog.pages.dev"],
            latest_stage: { name: "deploy", status: "success" },
            url: "https://blog.pages.dev"
          }
        });
      }
      throw new Error(`Unexpected call: ${call.method} ${call.url}`);
    });
    try {
      const result = await cloudflareTarget.publish(cfg, {
        distDir,
        logger: () => {},
        siteBasePath: "",
        workspaceRoot: distDir
      });
      assert.equal(result.deploymentId, "dep_1");
      assert.equal(result.url, "https://blog.pages.dev");
      assert.equal(result.uploaded, 2);
      const phases = mock.calls.map((call) => {
        if (call.url.endsWith("/upload-token")) return "token";
        if (call.url.endsWith("/check-missing")) return "missing";
        if (call.url.endsWith("/upload")) return "upload";
        if (call.url.endsWith("/upsert-hashes")) return "upsert";
        if (call.url.endsWith("/deployments")) return "deployment";
        if (/\/deployments\/dep_1$/.test(call.url)) return "status";
        return "?";
      });
      assert.deepEqual(phases, ["token", "missing", "upload", "upsert", "deployment", "status"]);
      assert.equal(mock.calls[0].headers.authorization, "Bearer tok_xyz");
      assert.equal(mock.calls[1].headers.authorization, "Bearer jwt_token");
      assert.equal(mock.calls[4].headers.authorization, "Bearer tok_xyz");
      const manifest = mock.calls[4].bodyForm?.manifest as Record<string, string> | undefined;
      assert.ok(manifest);
      const firstEntry = Object.values(manifest)[0];
      assert.equal(typeof firstEntry, "string");
      assert.match(firstEntry, /^[a-f0-9]{32}$/);
    } finally {
      mock.restore();
    }
  } finally {
    await fs.rm(distDir, { recursive: true, force: true });
  }
});

test("cloudflare target uses wrangler-compatible BLAKE3 asset hashes", async () => {
  const distDir = await fs.mkdtemp(path.join(os.tmpdir(), "blog-system-cf-hash-"));
  try {
    const filePath = path.join(distDir, "index.html");
    await fs.writeFile(filePath, "<html>hello</html>", "utf8");
    const cfg = cloudflareTarget.validateConfig({
      accountId: "acc_42",
      projectName: "blog",
      apiToken: "tok_xyz"
    });
    const mock = installFetchMock(async (call) => {
      if (call.method === "GET" && call.url.endsWith("/upload-token")) {
        return jsonResponse({ success: true, result: { jwt: "jwt_token" } });
      }
      if (call.method === "POST" && call.url.endsWith("/check-missing")) {
        return jsonResponse({ success: true, result: [] });
      }
      if (call.method === "POST" && call.url.endsWith("/deployments")) {
        return jsonResponse({ success: true, result: { id: "dep_1", url: "https://blog.pages.dev" } });
      }
      if (call.method === "GET" && /\/deployments\/dep_1$/.test(call.url)) {
        return jsonResponse({
          success: true,
          result: {
            aliases: ["blog.pages.dev"],
            latest_stage: { name: "deploy", status: "success" },
            url: "https://blog.pages.dev"
          }
        });
      }
      if (call.method === "POST" && call.url.endsWith("/pages/assets/upsert-hashes")) {
        return jsonResponse({ success: true });
      }
      throw new Error(`Unexpected call: ${call.method} ${call.url}`);
    });
    try {
      await cloudflareTarget.publish(cfg, {
        distDir,
        logger: () => {},
        siteBasePath: "",
        workspaceRoot: distDir
      });
      const postedHashes = (mock.calls.find((call) => call.url.endsWith("/check-missing"))?.bodyJson as { hashes: string[] }).hashes;
      assert.deepEqual(postedHashes, ["6cf797d9121e836b4c8fbd09ade71c54"]);
    } finally {
      mock.restore();
    }
  } finally {
    await fs.rm(distDir, { recursive: true, force: true });
  }
});
