import { promises as fs } from "node:fs";
import path from "node:path";

import Ajv from "ajv";
import {
  defaultMarkdownBlockConfig,
  findDuplicateMarkdownBlockRuleMarkers,
  markdownBlockConfigSchema,
  normalizeMarkdownBlockConfig,
  type MarkdownBlockConfig
} from "@blog-system/content-core";

import { ConfigValidationError } from "./errors.js";

const ajv = new Ajv({ allErrors: true });
const validateMarkdownBlockConfig = ajv.compile<MarkdownBlockConfig>(markdownBlockConfigSchema);

function getMarkdownBlockConfigPath(configRoot: string) {
  return path.join(configRoot, "markdown-blocks.json");
}

function validateParsedMarkdownBlockConfig(value: unknown) {
  if (!validateMarkdownBlockConfig(value)) {
    const message = (validateMarkdownBlockConfig.errors ?? [])
      .map((error) => `markdownBlockConfig${error.instancePath} ${error.message}`)
      .join("; ");
    throw new ConfigValidationError(message);
  }

  const normalized = normalizeMarkdownBlockConfig(value);
  const duplicates = findDuplicateMarkdownBlockRuleMarkers(normalized);
  const errors = [
    ...duplicates.duplicateStarts.map((entry) => `Duplicate start marker "${entry}".`),
    ...duplicates.duplicateEnds.map((entry) => `Duplicate end marker "${entry}".`)
  ];

  if (errors.length > 0) {
    throw new ConfigValidationError(errors.join(" "));
  }

  return normalized;
}

export async function loadMarkdownBlockConfig(configRoot: string) {
  const configPath = getMarkdownBlockConfigPath(configRoot);

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const value = validateParsedMarkdownBlockConfig(JSON.parse(raw));
    const normalizedRaw = `${JSON.stringify(value, null, 2)}\n`;
    return {
      raw: normalizedRaw,
      value
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return {
      raw: `${JSON.stringify(defaultMarkdownBlockConfig, null, 2)}\n`,
      value: defaultMarkdownBlockConfig
    };
  }
}

export async function saveMarkdownBlockConfig(configRoot: string, raw: string) {
  const value = validateParsedMarkdownBlockConfig(JSON.parse(raw));
  const configPath = getMarkdownBlockConfigPath(configRoot);
  const normalizedRaw = `${JSON.stringify(value, null, 2)}\n`;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, normalizedRaw, "utf8");

  return {
    raw: normalizedRaw,
    value
  };
}
