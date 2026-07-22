import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getErrorMessage } from "@blog-system/content-core";

import { buildSite, getSiteSettings, type SiteBuildSettings } from "./generator.js";
import { loadPublishConfig } from "./publish-config.js";
import { getTarget } from "./publish-targets/index.js";
import type {
  PublishContext,
  PublishResult,
  PublishTarget
} from "./publish-targets/types.js";
import { PublishTargetError } from "./publish-targets/types.js";

export type {
  CloudflareTargetConfig,
  GithubTargetConfig,
  PublishConfig,
  PublishContext,
  PublishResult,
  PublishTarget
} from "./publish-targets/types.js";
export { PublishTargetError } from "./publish-targets/types.js";

export type LegacyGithubPublishConfig = {
  authToken?: string;
  deployBranch?: string;
  deployRepo: string;
  siteBasePath?: string;
  userEmail?: string;
  userName?: string;
};

export interface PublishOutcome extends PublishResult {
  target: string;
  message: string;
}

interface PublishOptions {
  logger?: (line: string) => void;
  targetId?: string;
}

export async function publishSite(
  customSettings?: Partial<SiteBuildSettings>,
  options: PublishOptions = {}
): Promise<PublishOutcome> {
  const settings: SiteBuildSettings = {
    ...getSiteSettings(),
    ...customSettings
  };
  const logger = options.logger ?? ((line) => process.stdout.write(`${line}\n`));

  const { config, exists, configPath } = await loadPublishConfig(settings.configRoot);
  if (!exists) {
    throw new PublishTargetError("publish", "load-config", `Publish config not found at ${configPath}.`);
  }

  const targetId = options.targetId ?? config.defaultTarget;
  let target: PublishTarget<unknown>;
  try {
    target = getTarget(targetId);
  } catch (error) {
    throw new PublishTargetError("publish", "resolve-target", getErrorMessage(error));
  }

  const rawTargetConfig = config.targets[targetId as keyof typeof config.targets];
  if (!rawTargetConfig) {
    throw new PublishTargetError(target.id, "load-config", `Publish config has no entry for target "${targetId}".`);
  }

  const targetConfig = target.validateConfig(rawTargetConfig);
  const siteBasePath = (targetConfig as { siteBasePath?: string }).siteBasePath ?? settings.basePath ?? "";

  const publishDistDir = await fs.mkdtemp(path.join(os.tmpdir(), "blog-system-publish-dist-"));
  let distDir: string;
  try {
    distDir = await buildSite({
      ...settings,
      basePath: siteBasePath,
      distDir: publishDistDir
    });
  } catch (error) {
    throw new PublishTargetError(target.id, "build-site", getErrorMessage(error), {
      cause: error
    });
  }

  const ctx: PublishContext = {
    distDir,
    workspaceRoot: settings.workspaceRoot,
    siteBasePath,
    logger
  };

  try {
    const result = await target.publish(targetConfig, ctx);
    const message = formatSummary(target.id, result);
    logger(message);
    return { ...result, target: target.id, message };
  } finally {
    try {
      await fs.rm(publishDistDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function formatSummary(targetId: string, result: PublishResult): string {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const url = result.url ? ` -> ${result.url}` : "";
  return `[publish] ${targetId}: uploaded=${result.uploaded} skipped=${result.skipped} in ${seconds}s${url}`;
}
