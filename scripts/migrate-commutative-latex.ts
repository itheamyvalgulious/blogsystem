import { promises as fs } from "node:fs";
import path from "node:path";

import {
  encodeCommutativeBase64,
  parseCommutative,
  stripTikzcdWrappers
} from "@blog-system/commutative";
import { getErrorMessage } from "@blog-system/content-core";
import { chromium, type Page } from "playwright";

const FENCE_RE = /^```commutative([^\n]*)\n([\s\S]*?)^```$/gm;

interface LegacyFencePayload {
  encodedBase64: string;
}

interface MigrateResult {
  migratedFiles: number;
  migratedBlocks: number;
  skippedBlocks: number;
  failedBlocks: number;
  errors: Array<{ file: string; blockIndex: number; error: string }>;
}

interface CliOptions {
  contentDir: string;
  dryRun: boolean;
  quiverUrl: string;
}

function getLegacyFencePayload(body: string): LegacyFencePayload | null {
  const trimmed = body.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const document = parseCommutative(trimmed);
    return {
      encodedBase64: encodeCommutativeBase64(document)
    };
  } catch {
    return null;
  }
}

async function exportTikzCd(page: Page, quiverUrl: string, encodedBase64: string) {
  const evaluator = new Function(
    "arg",
    `
      const src = arg[0];
      const timeoutMs = arg[1];
      const frame = document.getElementById("quiver-frame");
      if (!frame) {
        throw new Error("quiver iframe not found");
      }

      const ready = new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => {
          frame.removeEventListener("load", onLoad);
          reject(new Error("Timed out waiting for quiver export bridge after " + timeoutMs + "ms."));
        }, timeoutMs);

        const finish = () => {
          window.clearTimeout(timer);
          frame.removeEventListener("load", onLoad);
          resolve();
        };

        const onLoad = () => {
          const probe = window.setInterval(() => {
            const frameWindow = frame.contentWindow;
            if (frameWindow && typeof frameWindow.__BLOG_SYSTEM_EXPORT_TIKZCD__ === "function") {
              window.clearInterval(probe);
              finish();
            }
          }, 50);
          window.setTimeout(() => window.clearInterval(probe), timeoutMs);
        };

        frame.addEventListener("load", onLoad);
      });

      frame.src = src;
      if (frame.contentWindow && typeof frame.contentWindow.__BLOG_SYSTEM_EXPORT_TIKZCD__ === "function") {
        return frame.contentWindow.__BLOG_SYSTEM_EXPORT_TIKZCD__();
      }
      return ready.then(() => {
        const frameWindow = frame.contentWindow;
        if (!frameWindow || typeof frameWindow.__BLOG_SYSTEM_EXPORT_TIKZCD__ !== "function") {
          throw new Error("quiver export bridge is unavailable");
        }
        return frameWindow.__BLOG_SYSTEM_EXPORT_TIKZCD__();
      });
    `
  ) as (arg: [string, number]) => Promise<string>;

  return page.evaluate(evaluator, [`${quiverUrl}#q=${encodeURIComponent(encodedBase64)}`, 15000] as [string, number]);
}

async function collectMarkdownFiles(contentDir: string) {
  const files: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.isFile() && /\.(md|mdx)$/i.test(entry.name)) {
        files.push(abs);
      }
    }
  }

  await walk(contentDir);
  return files;
}

async function migrateDirectory(
  contentDir: string,
  quiverUrl: string,
  dryRun = false
): Promise<MigrateResult> {
  const result: MigrateResult = {
    migratedFiles: 0,
    migratedBlocks: 0,
    skippedBlocks: 0,
    failedBlocks: 0,
    errors: []
  };

  const files = await collectMarkdownFiles(contentDir);
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setContent(`
    <html><body>
    <iframe id="quiver-frame" src="${quiverUrl}" style="width:0;height:0;border:none;"></iframe>
    </body></html>
  `);
  console.log(`[migrate] quiver iframe loaded at ${quiverUrl}`);

  try {
    for (const filePath of files) {
      const content = await fs.readFile(filePath, "utf8");
      let modified = content;
      let blockIndex = 0;
      let fileChanged = false;

      for (const match of content.matchAll(FENCE_RE)) {
        const infoString = match[1].trim();
        const body = match[2];
        const legacyPayload = getLegacyFencePayload(body);

        if (!legacyPayload) {
          const normalizedBody = stripTikzcdWrappers(body);
          if (normalizedBody !== body.trim()) {
            const info = infoString ? ` ${infoString}` : "";
            const newFence = `\`\`\`commutative${info}\n${normalizedBody}\n\`\`\``;
            modified = modified.replace(match[0], newFence);
            fileChanged = true;
            result.migratedBlocks++;
          } else {
            result.skippedBlocks++;
          }
          blockIndex++;
          continue;
        }

        let exportResponse: string;
        try {
          exportResponse = await exportTikzCd(page, quiverUrl, legacyPayload.encodedBase64);
        } catch (error) {
          result.failedBlocks++;
          result.errors.push({
            file: path.relative(contentDir, filePath),
            blockIndex,
            error: `quiver export failed: ${getErrorMessage(error)}`
          });
          blockIndex++;
          continue;
        }

        if (exportResponse.startsWith("% export")) {
          result.failedBlocks++;
          result.errors.push({
            file: path.relative(contentDir, filePath),
            blockIndex,
            error: `quiver export failed: ${exportResponse.slice(1).trim()}`
          });
          blockIndex++;
          continue;
        }

        const latexBody = stripTikzcdWrappers(exportResponse);
        const info = infoString ? ` ${infoString}` : "";
        const newFence = `\`\`\`commutative${info}\n${latexBody}\n\`\`\``;

        modified = modified.replace(match[0], newFence);
        fileChanged = true;
        result.migratedBlocks++;
        blockIndex++;
      }

      if (fileChanged) {
        if (!dryRun) {
          await fs.writeFile(filePath, modified, "utf8");
        }
        result.migratedFiles++;
      }
    }
  } finally {
    await browser.close();
  }

  return result;
}

function resolveQuiverUrl(devServer: string) {
  return `${devServer.replace(/\/+$/, "")}/quiver/index.html`;
}

function parseCliOptions(argv: string[]): CliOptions {
  if (argv.length < 1) {
    throw new Error(
      "Usage: npx tsx scripts/migrate-commutative-latex.ts <content-dir> [--dev-server=http://localhost:4174] [--dry-run]"
    );
  }

  const [contentDir, ...rest] = argv;
  let devServer: string | undefined;
  let dryRun = false;

  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--dev-server=")) {
      devServer = arg.slice("--dev-server=".length).trim();
      continue;
    }
    if (arg === "--dev-server") {
      const next = rest[index + 1];
      if (!next || next.startsWith("--")) {
        throw new Error('Missing value after "--dev-server".');
      }
      devServer = next.trim();
      index += 1;
      continue;
    }
  }

  const envDevServer = process.env.npm_config_dev_server?.trim();
  const envDryRun = process.env.npm_config_dry_run?.trim();
  const resolvedDevServer = devServer || envDevServer || "http://localhost:4174";

  return {
    contentDir,
    dryRun: dryRun || envDryRun === "true",
    quiverUrl: resolveQuiverUrl(resolvedDevServer)
  };
}

async function main() {
  const { contentDir, quiverUrl, dryRun } = parseCliOptions(process.argv.slice(2));

  console.log(`[migrate] scanning ${contentDir}`);
  console.log(`[migrate] quiver URL: ${quiverUrl}`);
  if (dryRun) {
    console.log("[migrate] DRY RUN - files will not be written");
  }

  const result = await migrateDirectory(contentDir, quiverUrl, dryRun);

  console.log("[migrate] done.");
  console.log(`  migrated ${result.migratedBlocks} blocks across ${result.migratedFiles} files`);
  console.log(`  skipped ${result.skippedBlocks} already-latex blocks`);
  console.log(`  failed ${result.failedBlocks} blocks`);
  if (result.errors.length > 0) {
    console.log("  errors:");
    for (const error of result.errors) {
      console.log(`    ${error.file} block #${error.blockIndex}: ${error.error}`);
    }
  }
}

main().catch((error) => {
  console.error("[migrate] fatal:", error);
  process.exit(1);
});
