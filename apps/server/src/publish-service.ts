import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { ServerSettings } from "./config.js";
import { pathExists } from "./fs-utils.js";
import { PublishTargetError } from "../../site/src/publish-targets/types.js";

interface PublisherModule {
  publishSite(customSettings?: {
    assetsRoot?: string;
    configRoot?: string;
    contentRoot?: string;
    projectRoot?: string;
    workspaceRoot?: string;
  }): Promise<{
    target: string;
    message: string;
    url?: string;
    deploymentId?: string;
    uploaded: number;
    skipped: number;
    durationMs: number;
  }>;
}

export interface PublishServiceResult {
  stdout: string;
  stderr: string;
  target: string;
  url?: string;
  deploymentId?: string;
  uploaded: number;
  skipped: number;
  durationMs: number;
}

export interface PublishServiceError {
  message: string;
  target?: string;
  phase?: string;
  status?: number;
  detail?: string;
}

interface PublisherRuntime {
  publisherEntry: string;
  shouldBuildRuntime: boolean;
}

interface BuildSiteRuntimeResult {
  publisherEntry: string;
  stdout: string;
  stderr: string;
}

function quoteWindowsShellArgument(value: string) {
  if (value.length === 0) {
    return '""';
  }

  if (!/[\s"]/u.test(value)) {
    return value;
  }

  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
}

export function createNpmSpawnInvocation(
  npmCommand: string,
  npmArgs: string[],
  platform = process.platform,
  comspec = process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe"
) {
  const normalizedCommand = npmCommand.trim() || (platform === "win32" ? "npm.cmd" : "npm");

  if (platform === "win32") {
    return {
      args: ["/d", "/s", "/c", [normalizedCommand, ...npmArgs].map(quoteWindowsShellArgument).join(" ")],
      command: comspec
    };
  }

  return {
    args: npmArgs,
    command: normalizedCommand
  };
}

export async function resolvePublisherRuntime(projectRoot: string): Promise<PublisherRuntime> {
  const siteWorkspacePackagePath = path.join(projectRoot, "apps", "site", "package.json");
  const publisherEntry = path.join(projectRoot, "apps", "site", "runtime-dist", "publisher.js");

  if (await pathExists(siteWorkspacePackagePath)) {
    return {
      publisherEntry,
      shouldBuildRuntime: true
    };
  }

  if (await pathExists(publisherEntry)) {
    return {
      publisherEntry,
      shouldBuildRuntime: false
    };
  }

  throw new PublishTargetError(
    "publish",
    "build-runtime",
    `Cannot prepare the static site publisher. Missing ${siteWorkspacePackagePath} and ${publisherEntry}.`
  );
}

async function buildSiteRuntime(settings: ServerSettings) {
  const publisherRuntime = await resolvePublisherRuntime(settings.projectRoot);

  if (!publisherRuntime.shouldBuildRuntime) {
    return {
      publisherEntry: publisherRuntime.publisherEntry,
      stderr: "",
      stdout: "Using bundled apps/site/runtime-dist publisher."
    } satisfies BuildSiteRuntimeResult;
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  await new Promise<void>((resolve, reject) => {
    const invocation = createNpmSpawnInvocation(settings.npmCommand, [
      "run",
      "build-runtime",
      "-w",
      "apps/site"
    ]);
    const child = spawn(invocation.command, invocation.args, {
      cwd: settings.projectRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(String(chunk));
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(String(chunk));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      const detail = `${stdoutChunks.join("")}${stderrChunks.join("")}`.trim();
      reject(
        new PublishTargetError(
          "publish",
          "build-runtime",
          `Failed to rebuild apps/site runtime-dist before publishing (exit code: ${code ?? "unknown"}).`,
          detail ? { detail: detail.slice(-4000) } : undefined
        )
      );
    });
  });

  return {
    publisherEntry: publisherRuntime.publisherEntry,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join("")
  } satisfies BuildSiteRuntimeResult;
}

export async function publishSite(settings: ServerSettings): Promise<PublishServiceResult> {
  const buildOutput = await buildSiteRuntime(settings);
  const publisherUrl = pathToFileURL(buildOutput.publisherEntry);
  publisherUrl.searchParams.set("ts", `${Date.now()}`);
  const publisherModule = (await import(publisherUrl.href)) as PublisherModule;
  const result = await publisherModule.publishSite({
    assetsRoot: settings.assetsRoot,
    configRoot: settings.configRoot,
    contentRoot: settings.contentRoot,
    projectRoot: settings.projectRoot,
    workspaceRoot: settings.workspaceRoot
  });

  return {
    stderr: buildOutput.stderr,
    stdout: [buildOutput.stdout.trim(), result.message].filter(Boolean).join("\n"),
    target: result.target,
    url: result.url,
    deploymentId: result.deploymentId,
    uploaded: result.uploaded,
    skipped: result.skipped,
    durationMs: result.durationMs
  };
}
