import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
import { getErrorMessage } from "@blog-system/content-core";
import { ProxyAgent, setGlobalDispatcher } from "undici";

import type {
  CloudflareTargetConfig,
  PublishContext,
  PublishResult,
  PublishTarget
} from "./types.js";
import { PublishTargetError } from "./types.js";

const TARGET_ID = "cloudflare";
const API_ROOT = "https://api.cloudflare.com/client/v4";
const API_HOSTNAME = "api.cloudflare.com";
const UPLOAD_BATCH_SIZE = 100;
const UPLOAD_CONCURRENCY = 5;
const MAX_BASE64_CHUNK_BYTES = 24 * 1024 * 1024;
const PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "https_proxy",
  "ALL_PROXY",
  "all_proxy",
  "HTTP_PROXY",
  "http_proxy"
];
const WINDOWS_INTERNET_SETTINGS_KEY =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

interface FileEntry {
  absPath: string;
  hash: string;
  relPath: string;
  size: number;
}

interface CfApiResponse<T> {
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
  success: boolean;
}

interface UploadTokenResult {
  jwt: string;
}

interface DeploymentResult {
  id: string;
  url?: string;
}

interface DeploymentStatusResult {
  aliases?: string[];
  latest_stage?: {
    name?: string;
    status?: string;
  };
  url?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function trimOrUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function hashAssetPayload(filePath: string, data: Buffer) {
  const base64Contents = data.toString("base64");
  const extension = path.extname(filePath).slice(1);
  const input = `${base64Contents}${extension}`;
  return bytesToHex(blake3(new TextEncoder().encode(input))).slice(0, 32);
}

async function walkDist(dir: string, base = dir, accum: FileEntry[] = []): Promise<FileEntry[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkDist(absPath, base, accum);
    } else if (entry.isFile()) {
      const data = await fs.readFile(absPath);
      const hash = hashAssetPayload(absPath, data);
      const relPath = path.posix.join(...path.relative(base, absPath).split(path.sep));
      accum.push({ absPath, hash, relPath, size: data.length });
    }
  }
  return accum;
}

function buildManifest(files: FileEntry[]): Record<string, string> {
  return Object.fromEntries(
    files.map((file) => [
      file.relPath.startsWith("/") ? file.relPath : `/${file.relPath}`,
      file.hash
    ])
  );
}

export function normalizeProxyUrl(candidate: string): string | undefined {
  const value = candidate.trim();
  if (!value) {
    return undefined;
  }

  if (/^socks/i.test(value)) {
    return undefined;
  }

  if (/^https?:\/\//i.test(value)) {
    return value;
  }

  return `http://${value}`;
}

export function parseWindowsProxyServer(rawProxyServer: string): string | undefined {
  const value = rawProxyServer.trim();
  if (!value) {
    return undefined;
  }

  const parts = value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const perProtocol = parts.filter((part) => /^[a-z-]+=./i.test(part));

  if (perProtocol.length > 0) {
    const httpsEntry = perProtocol.find((part) => /^https=/i.test(part));
    return httpsEntry ? normalizeProxyUrl(httpsEntry.slice("https=".length)) : undefined;
  }

  return normalizeProxyUrl(parts[0] ?? "");
}

export function proxyBypassed(hostname: string, noProxyValue: string | undefined): boolean {
  const entries = (noProxyValue ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (entries.includes("*")) {
    return true;
  }

  const host = hostname.toLowerCase();
  return entries.some((entry) => {
    const normalized = entry.startsWith(".") ? entry.slice(1) : entry;
    return host === normalized || host.endsWith(`.${normalized}`);
  });
}

let cachedWindowsProxy: string | undefined | null = null;

function readWindowsSystemProxy(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  if (cachedWindowsProxy !== null) {
    return cachedWindowsProxy ?? undefined;
  }

  const query = (value: string) =>
    spawnSync("reg", ["query", WINDOWS_INTERNET_SETTINGS_KEY, "/v", value], {
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true
    });
  const enabledOutput = query("ProxyEnable");
  const enabled = Boolean(enabledOutput.stdout?.match(/ProxyEnable\s+REG_DWORD\s+0x1\b/i));
  const proxyServerOutput = enabled ? query("ProxyServer") : null;
  cachedWindowsProxy = enabled
    ? parseWindowsProxyServer(
        proxyServerOutput?.stdout?.match(/ProxyServer\s+REG_SZ\s+(.+)/i)?.[1] ?? ""
      ) ?? null
    : null;

  return cachedWindowsProxy ?? undefined;
}

function resolveProxyUrl(): string | undefined {
  for (const key of PROXY_ENV_KEYS) {
    const value = process.env[key]?.trim();
    if (value) {
      return normalizeProxyUrl(value);
    }
  }

  return readWindowsSystemProxy();
}

function describeNetworkError(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;

  while (current && messages.length < 4) {
    const message = getErrorMessage(current);
    if (message && messages[messages.length - 1] !== message) {
      messages.push(message);
    }
    current = (current as { cause?: unknown }).cause;
  }

  return messages.join(" | cause: ");
}

let proxyConfigured = false;

function ensureProxyDispatcher(logger: (line: string) => void) {
  if (proxyConfigured) {
    return;
  }

  proxyConfigured = true;
  const proxyUrl = resolveProxyUrl();
  if (!proxyUrl) {
    return;
  }

  if (proxyBypassed(API_HOSTNAME, process.env.NO_PROXY ?? process.env.no_proxy)) {
    logger("[publish] cloudflare: proxy detected, but NO_PROXY bypasses the Cloudflare API; going direct.");
    return;
  }

  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  logger(`[publish] cloudflare: routing API traffic through proxy ${proxyUrl}.`);
}

async function cfFetch<T>(
  url: string,
  init: RequestInit,
  phase: string,
  options: { requireResult?: boolean } = {}
): Promise<T> {
  const method = (init.method ?? "GET").toUpperCase();
  const maxAttempts = method === "GET" ? 3 : 1;
  let response: Response | undefined;
  let networkError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      response = await fetch(url, init);
      networkError = null;
      break;
    } catch (error) {
      networkError = error;
      if (attempt === maxAttempts) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }

  if (networkError !== null || !response) {
    const detail = networkError !== null ? describeNetworkError(networkError) : "no response";
    throw new PublishTargetError(
      TARGET_ID,
      phase,
      `Network error talking to Cloudflare: ${detail}`,
      networkError !== null ? { cause: networkError } : undefined
    );
  }

  let bodyText = "";
  let parsed: unknown = null;
  try {
    bodyText = await response.text();
    parsed = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    parsed = null;
  }

  const body = isObject(parsed) ? (parsed as unknown as CfApiResponse<T>) : null;

  if (!response.ok || !body || body.success === false) {
    const message = body?.errors?.[0]?.message ?? (bodyText.slice(0, 200) || response.statusText);
    throw new PublishTargetError(TARGET_ID, phase, `${response.status} ${message}`, {
      status: response.status,
      detail: bodyText.slice(0, 1000)
    });
  }

  if (options.requireResult !== false && !("result" in body)) {
    throw new PublishTargetError(
      TARGET_ID,
      phase,
      `Malformed Cloudflare API response during ${phase}: missing "result" field.`,
      {
        status: response.status,
        detail: bodyText.slice(0, 1000)
      }
    );
  }

  return body.result as T;
}

function guessContentType(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "application/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".webp":
      return "image/webp";
    case ".gif":
      return "image/gif";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    case ".xml":
      return "application/xml";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}

async function getUploadToken(cfg: CloudflareTargetConfig) {
  return cfFetch<UploadTokenResult>(
    `${API_ROOT}/accounts/${encodeURIComponent(cfg.accountId)}/pages/projects/${encodeURIComponent(cfg.projectName)}/upload-token`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`
      }
    },
    "fetch-upload-token"
  );
}

async function checkMissing(jwt: string, hashes: string[]) {
  return cfFetch<string[]>(
    `${API_ROOT}/pages/assets/check-missing`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ hashes })
    },
    "check-missing-assets"
  );
}

async function uploadAssetsBatch(
  jwt: string,
  payload: Array<{
    base64: true;
    key: string;
    metadata: { contentType: string };
    value: string;
  }>
) {
  await cfFetch<unknown>(
    `${API_ROOT}/pages/assets/upload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    },
    "upload-assets"
  );
}

async function upsertHashes(jwt: string, hashes: string[]) {
  await cfFetch<unknown>(
    `${API_ROOT}/pages/assets/upsert-hashes`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwt}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ hashes })
    },
    "upsert-hashes",
    { requireResult: false }
  );
}

async function createDeployment(cfg: CloudflareTargetConfig, manifest: Record<string, string>) {
  const formData = new FormData();
  formData.set("manifest", JSON.stringify(manifest));
  if (cfg.branch) {
    formData.set("branch", cfg.branch);
  }

  return cfFetch<DeploymentResult>(
    `${API_ROOT}/accounts/${encodeURIComponent(cfg.accountId)}/pages/projects/${encodeURIComponent(cfg.projectName)}/deployments`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`
      },
      body: formData
    },
    "create-deployment"
  );
}

async function getDeploymentStatus(cfg: CloudflareTargetConfig, deploymentId: string) {
  return cfFetch<DeploymentStatusResult>(
    `${API_ROOT}/accounts/${encodeURIComponent(cfg.accountId)}/pages/projects/${encodeURIComponent(cfg.projectName)}/deployments/${encodeURIComponent(deploymentId)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.apiToken}`
      }
    },
    "get-deployment-status"
  );
}

async function uploadMissing(
  files: FileEntry[],
  missingHashes: Set<string>,
  jwt: string,
  logger: (line: string) => void
) {
  const seen = new Set<string>();
  const queue: Array<{
    base64: true;
    key: string;
    metadata: { contentType: string };
    value: string;
  }> = [];

  for (const file of files) {
    if (!missingHashes.has(file.hash) || seen.has(file.hash)) {
      continue;
    }
    seen.add(file.hash);
    const data = await fs.readFile(file.absPath);
    if (data.length > MAX_BASE64_CHUNK_BYTES) {
      throw new PublishTargetError(
        TARGET_ID,
        "upload-assets",
        `Asset ${file.relPath} exceeds Cloudflare's 25 MiB direct-upload limit (${data.length} bytes).`
      );
    }
    queue.push({
      base64: true,
      key: file.hash,
      metadata: { contentType: guessContentType(file.absPath) },
      value: data.toString("base64")
    });
  }

  const batches: Array<typeof queue> = [];
  for (let index = 0; index < queue.length; index += UPLOAD_BATCH_SIZE) {
    batches.push(queue.slice(index, index + UPLOAD_BATCH_SIZE));
  }

  if (batches.length > 0) {
    logger(`[publish] cloudflare: uploading ${queue.length} unique blobs in ${batches.length} batches.`);
  }

  let uploaded = 0;
  for (let index = 0; index < batches.length; index += UPLOAD_CONCURRENCY) {
    const slice = batches.slice(index, index + UPLOAD_CONCURRENCY);
    await Promise.all(slice.map((batch) => uploadAssetsBatch(jwt, batch)));
    for (const batch of slice) {
      uploaded += batch.length;
    }
  }

  try {
    await upsertHashes(jwt, files.map((file) => file.hash));
  } catch (error) {
    logger(
      `[publish] cloudflare: warning - asset upload succeeded, but upsert-hashes failed: ${getErrorMessage(error)}`
    );
  }

  return uploaded;
}

async function resolveDeploymentUrl(
  cfg: CloudflareTargetConfig,
  deploymentId: string,
  fallbackUrl: string | undefined
) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000 * (attempt + 1)));
    try {
      const deployment = await getDeploymentStatus(cfg, deploymentId);
      const alias = deployment.aliases?.find((entry) => entry.endsWith(".pages.dev"));
      const url = deployment.url ?? (alias ? `https://${alias}` : undefined);
      if (url) {
        return url;
      }
    } catch {
      // best effort
    }
  }

  return fallbackUrl;
}

export const cloudflareTarget: PublishTarget<CloudflareTargetConfig> = {
  id: TARGET_ID,
  validateConfig(raw): CloudflareTargetConfig {
    if (!isObject(raw)) {
      throw new PublishTargetError(TARGET_ID, "validate", "Cloudflare publish config must be an object.");
    }

    const accountId = trimOrUndefined(raw.accountId);
    const projectName = trimOrUndefined(raw.projectName);
    const apiToken = trimOrUndefined(raw.apiToken);

    if (!accountId || !projectName || !apiToken) {
      throw new PublishTargetError(
        TARGET_ID,
        "validate",
        'Cloudflare publish config requires "accountId", "projectName" and "apiToken".'
      );
    }

    return {
      accountId,
      projectName,
      apiToken,
      branch: trimOrUndefined(raw.branch) ?? "main",
      siteBasePath: trimOrUndefined(raw.siteBasePath) ?? ""
    };
  },
  async publish(cfg, ctx: PublishContext): Promise<PublishResult> {
    const startedAt = Date.now();
    ensureProxyDispatcher(ctx.logger);
    ctx.logger(`[publish] cloudflare -> ${cfg.projectName} (branch: ${cfg.branch}).`);
    ctx.logger("[publish] cloudflare: scanning dist + hashing files...");

    const files = await walkDist(ctx.distDir);
    if (files.length === 0) {
      throw new PublishTargetError(TARGET_ID, "scan", `No files to publish in ${ctx.distDir}.`);
    }

    ctx.logger(`[publish] cloudflare: ${files.length} files found.`);
    ctx.logger("[publish] cloudflare: requesting upload token...");
    const { jwt } = await getUploadToken(cfg);

    ctx.logger("[publish] cloudflare: checking missing assets...");
    const missingHashes = new Set(await checkMissing(jwt, files.map((file) => file.hash)));
    const totalUnique = new Set(files.map((file) => file.hash)).size;
    const skipped = totalUnique - missingHashes.size;

    let uploaded = 0;
    if (missingHashes.size > 0) {
      uploaded = await uploadMissing(files, missingHashes, jwt, ctx.logger);
    } else {
      ctx.logger("[publish] cloudflare: no missing assets, skipping upload phase.");
    }

    ctx.logger("[publish] cloudflare: creating deployment...");
    const deployment = await createDeployment(cfg, buildManifest(files));
    const url = await resolveDeploymentUrl(cfg, deployment.id, deployment.url);

    return {
      url,
      deploymentId: deployment.id,
      uploaded,
      skipped,
      durationMs: Date.now() - startedAt
    };
  }
};
