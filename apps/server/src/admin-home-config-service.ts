import { promises as fs } from "node:fs";
import path from "node:path";

import Ajv from "ajv";
import {
  adminHomeConfigSchema,
  defaultAdminHomeConfig,
  normalizeAdminHomeConfig,
  type AdminHomeConfig
} from "@blog-system/content-core";

import { ConfigValidationError } from "./errors.js";

const ajv = new Ajv({ allErrors: true });
const validateAdminHomeConfig = ajv.compile<AdminHomeConfig>(adminHomeConfigSchema);

function getAdminHomeConfigPath(configRoot: string) {
  return path.join(configRoot, "admin-home.json");
}

function validateParsedAdminHomeConfig(value: unknown) {
  if (!validateAdminHomeConfig(value)) {
    const message = (validateAdminHomeConfig.errors ?? [])
      .map((error) => `adminHomeConfig${error.instancePath} ${error.message}`)
      .join("; ");
    throw new ConfigValidationError(message);
  }

  return normalizeAdminHomeConfig(value);
}

export async function loadAdminHomeConfig(configRoot: string) {
  const configPath = getAdminHomeConfigPath(configRoot);

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const value = validateParsedAdminHomeConfig(JSON.parse(raw));
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
      raw: `${JSON.stringify(defaultAdminHomeConfig, null, 2)}\n`,
      value: defaultAdminHomeConfig
    };
  }
}

export async function saveAdminHomeConfig(configRoot: string, raw: string) {
  const value = validateParsedAdminHomeConfig(JSON.parse(raw));
  const configPath = getAdminHomeConfigPath(configRoot);
  const normalizedRaw = `${JSON.stringify(value, null, 2)}\n`;

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, normalizedRaw, "utf8");

  return {
    raw: normalizedRaw,
    value
  };
}
