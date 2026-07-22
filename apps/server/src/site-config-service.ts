import { promises as fs } from "node:fs";
import path from "node:path";

import Ajv from "ajv";

import { ConfigValidationError } from "./errors.js";

export const siteConfigSchema = {
  type: "object",
  additionalProperties: false,
  required: ["siteTitle", "enabledPlugins"],
  properties: {
    siteTitle: { type: "string", minLength: 1 },
    siteDescription: { type: "string" },
    backgroundImage: { type: "string" },
    enabledPlugins: {
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true
    }
  }
} as const;

const ajv = new Ajv({ allErrors: true });
const validateSiteConfig = ajv.compile(siteConfigSchema);

function normalizeSiteConfigValue(value: {
  backgroundImage?: unknown;
  enabledPlugins?: unknown;
  siteDescription?: unknown;
  siteTitle?: unknown;
}) {
  return {
    backgroundImage: typeof value.backgroundImage === "string" ? value.backgroundImage : "",
    enabledPlugins: Array.isArray(value.enabledPlugins) ? value.enabledPlugins : [],
    siteDescription: typeof value.siteDescription === "string" ? value.siteDescription : "",
    siteTitle: typeof value.siteTitle === "string" ? value.siteTitle : ""
  };
}

function getSiteConfigPath(configRoot: string) {
  return path.join(configRoot, "site.json");
}

export async function loadSiteConfig(configRoot: string) {
  const siteConfigPath = getSiteConfigPath(configRoot);
  const raw = await fs.readFile(siteConfigPath, "utf8");
  const parsed = JSON.parse(raw);

  if (!validateSiteConfig(parsed)) {
    const message = (validateSiteConfig.errors ?? [])
      .map((error) => `siteConfig${error.instancePath} ${error.message}`)
      .join("; ");
    throw new ConfigValidationError(message);
  }

  return {
    raw: `${JSON.stringify(normalizeSiteConfigValue(parsed), null, 2)}\n`,
    value: normalizeSiteConfigValue(parsed)
  };
}

export async function saveSiteConfig(configRoot: string, raw: string) {
  const parsed = JSON.parse(raw);

  if (!validateSiteConfig(parsed)) {
    const message = (validateSiteConfig.errors ?? [])
      .map((error) => `siteConfig${error.instancePath} ${error.message}`)
      .join("; ");
    throw new ConfigValidationError(message);
  }

  const siteConfigPath = getSiteConfigPath(configRoot);
  const normalizedValue = normalizeSiteConfigValue(parsed);
  const normalizedRaw = `${JSON.stringify(normalizedValue, null, 2)}\n`;
  await fs.mkdir(path.dirname(siteConfigPath), { recursive: true });
  await fs.writeFile(siteConfigPath, normalizedRaw, "utf8");

  return {
    raw: normalizedRaw,
    value: normalizedValue
  };
}
