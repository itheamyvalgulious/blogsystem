import { promises as fs } from "node:fs";
import path from "node:path";

import { getErrorMessage } from "@blog-system/content-core";

import { PublishTargetError } from "./publish-targets/types.js";
import type { PublishConfig } from "./publish-targets/types.js";

const PUBLISH_CONFIG_FILE = "site-publish.local.json";

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizePublishConfig(raw: unknown): PublishConfig {
  if (!isObject(raw)) {
    throw new PublishTargetError("publish", "load-config", "Publish config must be an object.");
  }

  if (raw.defaultTarget !== "github" && raw.defaultTarget !== "cloudflare") {
    throw new PublishTargetError(
      "publish",
      "load-config",
      'Publish config requires "defaultTarget" to be "github" or "cloudflare".'
    );
  }

  if (!isObject(raw.targets)) {
    throw new PublishTargetError("publish", "load-config", 'Publish config requires "targets" to be an object.');
  }

  const targets: PublishConfig["targets"] = {};
  if (isObject(raw.targets.github)) {
    // Shape only checked for objectness here; each target's validateConfig()
    // does the real field validation before use.
    targets.github = raw.targets.github as unknown as PublishConfig["targets"]["github"];
  }
  if (isObject(raw.targets.cloudflare)) {
    targets.cloudflare = raw.targets.cloudflare as unknown as PublishConfig["targets"]["cloudflare"];
  }

  return {
    defaultTarget: raw.defaultTarget,
    targets
  };
}

export interface LoadedPublishConfig {
  config: PublishConfig;
  configPath: string;
  exists: boolean;
}

export async function loadPublishConfig(configRoot: string): Promise<LoadedPublishConfig> {
  const configPath = path.join(configRoot, PUBLISH_CONFIG_FILE);
  let raw: string;

  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        config: { defaultTarget: "github", targets: {} },
        configPath,
        exists: false
      };
    }
    throw error;
  }

  try {
    return {
      config: normalizePublishConfig(JSON.parse(raw)),
      configPath,
      exists: true
    };
  } catch (error) {
    if (error instanceof PublishTargetError) {
      throw error;
    }
    throw new PublishTargetError("publish", "load-config", `Failed to parse ${configPath}: ${getErrorMessage(error)}`);
  }
}

export async function savePublishConfig(configRoot: string, raw: string) {
  const config = normalizePublishConfig(JSON.parse(raw));
  const configPath = path.join(configRoot, PUBLISH_CONFIG_FILE);
  const normalizedRaw = `${JSON.stringify(config, null, 2)}\n`;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, normalizedRaw, "utf8");

  return {
    config,
    configPath,
    exists: true,
    raw: normalizedRaw
  };
}
