import { promises as fs } from "node:fs";
import path from "node:path";

import { ConfigValidationError } from "./errors.js";

export interface PublishConfigPayload {
  raw: string;
  value: {
    defaultTarget: "github" | "cloudflare";
    targets: {
      cloudflare?: Record<string, unknown>;
      github?: Record<string, unknown>;
    };
  };
}

const PUBLISH_CONFIG_FILE = "site-publish.local.json";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizePublishConfig(raw: unknown): PublishConfigPayload["value"] {
  if (!isObject(raw)) {
    throw new ConfigValidationError("Publish config must be an object.");
  }

  if (raw.defaultTarget !== "github" && raw.defaultTarget !== "cloudflare") {
    throw new ConfigValidationError('Publish config requires "defaultTarget" to be "github" or "cloudflare".');
  }

  if (!isObject(raw.targets)) {
    throw new ConfigValidationError('Publish config requires "targets" to be an object.');
  }

  return {
    defaultTarget: raw.defaultTarget,
    targets: {
      github: isObject(raw.targets.github) ? raw.targets.github : undefined,
      cloudflare: isObject(raw.targets.cloudflare) ? raw.targets.cloudflare : undefined
    }
  };
}

export async function loadPublishConfig(configRoot: string): Promise<PublishConfigPayload> {
  const configPath = path.join(configRoot, PUBLISH_CONFIG_FILE);
  let raw: string;

  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const value = normalizePublishConfig({
        defaultTarget: "github",
        targets: {}
      });
      return {
        raw: `${JSON.stringify(value, null, 2)}\n`,
        value
      };
    }
    throw error;
  }

  const value = normalizePublishConfig(JSON.parse(raw));
  return {
    raw: `${JSON.stringify(value, null, 2)}\n`,
    value
  };
}

export async function savePublishConfig(configRoot: string, raw: string): Promise<PublishConfigPayload> {
  const value = normalizePublishConfig(JSON.parse(raw));
  const configPath = path.join(configRoot, PUBLISH_CONFIG_FILE);
  const normalizedRaw = `${JSON.stringify(value, null, 2)}\n`;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, normalizedRaw, "utf8");

  return {
    raw: normalizedRaw,
    value
  };
}
