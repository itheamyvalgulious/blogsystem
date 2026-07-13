import { promises as fs } from "node:fs";
import path from "node:path";
import { pathExists } from "./fs-utils.js";

import Ajv from "ajv";
import {
  buildDefaultThemeChromeCss,
  buildDefaultThemeProseCss,
  buildThemeColorModeVariantCss,
  defaultThemeGroupConfig,
  inferThemeColorModeFromCss,
  inferThemeColorModeFromFileName,
  normalizeThemeGroupConfig,
  themeGroupConfigSchema,
  toPosixPath,
  toThemeAssetLanguage,
  withThemeColorModeFileName,
  type ThemeAssetConfig,
  type ThemeAssetType,
  type ThemeColorMode,
  type ThemeCssAssetConfig,
  type ThemeGroupConfig,
  type ThemeGroupSummary
} from "@blog-system/content-core";

const ajv = new Ajv({ allErrors: true });
const validateThemeGroupConfig = ajv.compile<ThemeGroupConfig>(themeGroupConfigSchema);
const THEME_DIRECTORY_NAME = "theme";
const THEME_CONFIG_FILE_NAME = "theme.json";

interface ThemeAssetPayload {
  adminPreview: boolean;
  assetPath: string;
  colorMode?: ThemeColorMode;
  fileName: string;
  groupId: string;
  language: "css" | "javascript";
  raw: string;
  type: ThemeAssetType;
}

interface LegacyCssThemeAssetInput {
  adminPreview: boolean;
  fileName: string;
  inferredMode: ThemeColorMode;
  raw: string;
}

function getThemeRoot(configRoot: string) {
  return path.join(configRoot, THEME_DIRECTORY_NAME);
}

function serializeThemeGroupConfig(value: ThemeGroupConfig) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function getOtherThemeMode(mode: ThemeColorMode): ThemeColorMode {
  return mode === "dark" ? "light" : "dark";
}

function normalizeThemeGroupId(groupId: string) {
  const normalized = toPosixPath(groupId.trim()).replace(/\/{2,}/g, "/");

  if (!normalized || normalized.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Theme group id is invalid.");
  }

  return normalized;
}

function getThemeGroupDirectory(configRoot: string, groupId: string) {
  const themeRoot = path.resolve(getThemeRoot(configRoot));
  const normalizedGroupId = normalizeThemeGroupId(groupId);
  const groupDirectory = path.resolve(themeRoot, normalizedGroupId);

  if (!groupDirectory.startsWith(themeRoot)) {
    throw new Error("Theme group path escapes config/theme.");
  }

  return {
    groupDirectory,
    groupId: normalizedGroupId
  };
}

function getThemeConfigPath(configRoot: string, groupId: string) {
  const resolved = getThemeGroupDirectory(configRoot, groupId);
  return {
    ...resolved,
    configPath: path.join(resolved.groupDirectory, THEME_CONFIG_FILE_NAME)
  };
}

function normalizeThemeAssetFileName(fileName: string, type: ThemeAssetType) {
  const normalized = toPosixPath(fileName.trim()).replace(/\/{2,}/g, "/");
  const extension = type === "css" ? ".css" : ".js";
  const withExtension = normalized.toLowerCase().endsWith(extension) ? normalized : `${normalized}${extension}`;

  if (!withExtension || withExtension.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Theme asset file name is invalid.");
  }

  return withExtension;
}

function resolveThemeAssetPath(configRoot: string, groupId: string, fileName: string, type?: ThemeAssetType) {
  const resolved = getThemeGroupDirectory(configRoot, groupId);
  const normalizedFileName = type ? normalizeThemeAssetFileName(fileName, type) : toPosixPath(fileName.trim());
  const absolutePath = path.resolve(resolved.groupDirectory, normalizedFileName);

  if (!absolutePath.startsWith(resolved.groupDirectory)) {
    throw new Error("Theme asset path escapes config/theme.");
  }

  return {
    absolutePath,
    assetPath: `${resolved.groupId}/${normalizedFileName}`,
    fileName: normalizedFileName,
    groupId: resolved.groupId
  };
}

function validateParsedThemeGroupConfig(value: unknown) {
  if (!validateThemeGroupConfig(value)) {
    const message = (validateThemeGroupConfig.errors ?? [])
      .map((error) => `themeGroup${error.instancePath} ${error.message}`)
      .join("; ");
    throw new Error(message);
  }

  return normalizeThemeGroupConfig(value);
}

async function readLegacyThemePalette(configRoot: string) {
  const configPath = path.join(configRoot, "site-theme.atlas.json");

  try {
    const raw = await fs.readFile(configPath, "utf8");
    const parsed = JSON.parse(raw) as {
      colors?: Partial<{
        accent: string;
        accentAlt: string;
        background: string;
        foreground: string;
        line: string;
        muted: string;
        paper: string;
        shadow: string;
      }>;
    };

    return {
      accent: parsed.colors?.accent?.trim() || "#c2410c",
      accentAlt: parsed.colors?.accentAlt?.trim() || "#0f766e",
      background: parsed.colors?.background?.trim() || "#f5f1e8",
      foreground: parsed.colors?.foreground?.trim() || "#1f2937",
      line: parsed.colors?.line?.trim() || "rgba(31, 41, 55, 0.12)",
      muted: parsed.colors?.muted?.trim() || "#52606d",
      paper: parsed.colors?.paper?.trim() || "rgba(255, 251, 245, 0.94)",
      shadow: parsed.colors?.shadow?.trim() || "0 22px 60px rgba(31, 41, 55, 0.12)"
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return {
      accent: "#c2410c",
      accentAlt: "#0f766e",
      background: "#f5f1e8",
      foreground: "#1f2937",
      line: "rgba(31, 41, 55, 0.12)",
      muted: "#52606d",
      paper: "rgba(255, 251, 245, 0.94)",
      shadow: "0 22px 60px rgba(31, 41, 55, 0.12)"
    };
  }
}

async function readLegacyRenderConfig(configRoot: string) {
  const renderConfigPath = path.join(configRoot, "render.json");

  try {
    const raw = await fs.readFile(renderConfigPath, "utf8");
    const parsed = JSON.parse(raw) as {
      styles?: Array<{ directory?: string; enable?: boolean }>;
    };

    return Array.isArray(parsed.styles)
      ? parsed.styles
          .filter((style) => typeof style?.directory === "string" && style.directory.trim())
          .map((style) => ({
            directory: style.directory!.trim().replace(/\\/g, "/"),
            enable: style.enable === true
          }))
      : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    return [];
  }
}

function buildThemeAssetTemplate(groupId: string, fileName: string, type: ThemeAssetType) {
  return type === "js"
    ? `// config/theme/${groupId}/${fileName}\n\n`
    : `/* config/theme/${groupId}/${fileName} */\n\n`;
}

async function writeThemeFile(
  configRoot: string,
  groupId: string,
  fileName: string,
  raw: string
) {
  const resolved = resolveThemeAssetPath(configRoot, groupId, fileName);
  await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await fs.writeFile(resolved.absolutePath, raw, "utf8");
}

function createCssThemeAssetConfig(
  fileName: string,
  colorMode: ThemeColorMode,
  adminPreview: boolean
): ThemeCssAssetConfig {
  return {
    adminPreview,
    colorMode,
    fileName,
    type: "css"
  };
}

async function writeDualCssThemeAssets(
  configRoot: string,
  groupId: string,
  baseFileName: string,
  sourceRaw: string,
  sourceMode: ThemeColorMode,
  adminPreview: boolean
) {
  const lightFileName = withThemeColorModeFileName(baseFileName, "light");
  const darkFileName = withThemeColorModeFileName(baseFileName, "dark");
  const lightCss =
    sourceMode === "light"
      ? sourceRaw
      : buildThemeColorModeVariantCss(sourceRaw, sourceMode, "light");
  const darkCss =
    sourceMode === "dark"
      ? sourceRaw
      : buildThemeColorModeVariantCss(sourceRaw, sourceMode, "dark");

  await writeThemeFile(configRoot, groupId, lightFileName, lightCss);
  await writeThemeFile(configRoot, groupId, darkFileName, darkCss);

  return [
    createCssThemeAssetConfig(lightFileName, "light", adminPreview),
    createCssThemeAssetConfig(darkFileName, "dark", adminPreview)
  ] satisfies ThemeAssetConfig[];
}

async function ensureDefaultThemeGroups(configRoot: string) {
  const themeRoot = getThemeRoot(configRoot);
  await fs.mkdir(themeRoot, { recursive: true });
  const existingEntries = await fs.readdir(themeRoot, { withFileTypes: true });
  const hasThemeGroups = await Promise.all(
    existingEntries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => pathExists(path.join(themeRoot, entry.name, THEME_CONFIG_FILE_NAME)))
  );

  if (hasThemeGroups.some(Boolean)) {
    return;
  }

  const palette = await readLegacyThemePalette(configRoot);
  const atlasGroup = getThemeGroupDirectory(configRoot, "atlas");
  await fs.mkdir(atlasGroup.groupDirectory, { recursive: true });

  const atlasFiles = [
    ...(await writeDualCssThemeAssets(
      configRoot,
      atlasGroup.groupId,
      "chrome.css",
      buildDefaultThemeChromeCss(palette),
      "light",
      false
    )),
    ...(await writeDualCssThemeAssets(
      configRoot,
      atlasGroup.groupId,
      "prose.css",
      buildDefaultThemeProseCss(palette),
      "light",
      true
    ))
  ];

  await fs.writeFile(
    path.join(atlasGroup.groupDirectory, THEME_CONFIG_FILE_NAME),
    serializeThemeGroupConfig({
      enable: true,
      files: atlasFiles,
      label: "Atlas",
      mode: "light"
    }),
    "utf8"
  );

  const legacyStyles = await readLegacyRenderConfig(configRoot);
  const renderRoot = path.join(configRoot, "render");

  for (const style of legacyStyles) {
    const baseName = path.posix.basename(style.directory, path.posix.extname(style.directory));
    const groupId = `render-${baseName}`;
    const resolvedGroup = getThemeGroupDirectory(configRoot, groupId);
    await fs.mkdir(resolvedGroup.groupDirectory, { recursive: true });

    const legacySource = path.join(renderRoot, style.directory);
    if (!(await pathExists(legacySource))) {
      continue;
    }

    const sourceRaw = await fs.readFile(legacySource, "utf8");
    const sourceMode = inferThemeColorModeFromCss(sourceRaw);
    const files = await writeDualCssThemeAssets(
      configRoot,
      resolvedGroup.groupId,
      path.posix.basename(style.directory),
      sourceRaw,
      sourceMode,
      true
    );

    await fs.writeFile(
      path.join(resolvedGroup.groupDirectory, THEME_CONFIG_FILE_NAME),
      serializeThemeGroupConfig({
        enable: style.enable,
        files,
        label: `Render ${baseName}`,
        mode: sourceMode
      }),
      "utf8"
    );
  }
}

function isThemeColorMode(value: unknown): value is ThemeColorMode {
  return value === "light" || value === "dark";
}

function getThemeGroupCssBaseName(fileName: string) {
  return normalizeThemeAssetFileName(fileName, "css").replace(/\.(light|dark)\.css$/i, ".css");
}

async function migrateLegacyThemeGroupConfig(
  configRoot: string,
  groupId: string,
  value: Record<string, unknown>
) {
  const rawFiles = Array.isArray(value.files) ? value.files : [];
  const nextFiles: ThemeAssetConfig[] = [];
  const legacyCssEntries = new Map<string, Array<LegacyCssThemeAssetInput>>();
  const baseFileOrder: string[] = [];

  for (const rawFile of rawFiles) {
    if (!rawFile || typeof rawFile !== "object") {
      continue;
    }

    const file = rawFile as Partial<ThemeAssetConfig>;
    const type: ThemeAssetType = file.type === "js" ? "js" : "css";
    const fileName =
      typeof file.fileName === "string" && file.fileName.trim()
        ? normalizeThemeAssetFileName(file.fileName, type)
        : "";

    if (!fileName) {
      continue;
    }

    if (type === "js") {
      nextFiles.push({
        adminPreview: file.adminPreview === true,
        fileName,
        type
      });
      continue;
    }

    const resolved = resolveThemeAssetPath(configRoot, groupId, fileName, "css");
    const raw = await fs.readFile(resolved.absolutePath, "utf8");
    const inferredMode =
      (isThemeColorMode(file.colorMode) ? file.colorMode : null) ??
      inferThemeColorModeFromFileName(fileName) ??
      inferThemeColorModeFromCss(raw);
    const baseFileName = getThemeGroupCssBaseName(fileName);
    const bucketKey = baseFileName.toLowerCase();

    if (!legacyCssEntries.has(bucketKey)) {
      legacyCssEntries.set(bucketKey, []);
      baseFileOrder.push(baseFileName);
    }

    legacyCssEntries.get(bucketKey)?.push({
      adminPreview: file.adminPreview === true,
      fileName,
      inferredMode,
      raw
    });
  }

  for (const baseFileName of baseFileOrder) {
    const entries = legacyCssEntries.get(baseFileName.toLowerCase()) ?? [];
    const variants = new Map<ThemeColorMode, LegacyCssThemeAssetInput>();

    for (const entry of entries) {
      if (!variants.has(entry.inferredMode)) {
        variants.set(entry.inferredMode, entry);
      }
    }

    for (const colorMode of ["light", "dark"] as const) {
      const variant = variants.get(colorMode);
      const targetFileName = withThemeColorModeFileName(baseFileName, colorMode);

      if (variant) {
        const source = resolveThemeAssetPath(configRoot, groupId, variant.fileName, "css");
        const target = resolveThemeAssetPath(configRoot, groupId, targetFileName, "css");

        if (source.absolutePath !== target.absolutePath && !(await pathExists(target.absolutePath))) {
          await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
          await fs.rename(source.absolutePath, target.absolutePath);
        }

        if (!(await pathExists(target.absolutePath))) {
          await fs.writeFile(target.absolutePath, variant.raw, "utf8");
        }

        nextFiles.push(createCssThemeAssetConfig(targetFileName, colorMode, variant.adminPreview));
        continue;
      }

      const sourceVariant = variants.get(getOtherThemeMode(colorMode)) ?? entries[0];
      if (!sourceVariant) {
        continue;
      }

      await writeThemeFile(
        configRoot,
        groupId,
        targetFileName,
        buildThemeColorModeVariantCss(sourceVariant.raw, sourceVariant.inferredMode, colorMode)
      );
      nextFiles.push(createCssThemeAssetConfig(targetFileName, colorMode, sourceVariant.adminPreview));
    }
  }

  const primaryCssEntry =
    [...legacyCssEntries.values()].flat().find((entry) => entry.adminPreview === false) ??
    [...legacyCssEntries.values()].flat()[0];
  const migratedConfig = normalizeThemeGroupConfig({
    enable: value.enable !== false,
    files: nextFiles,
    label: typeof value.label === "string" && value.label.trim() ? value.label.trim() : defaultThemeGroupConfig.label,
    mode: isThemeColorMode(value.mode) ? value.mode : primaryCssEntry?.inferredMode ?? "light"
  });

  return {
    raw: serializeThemeGroupConfig(migratedConfig),
    value: migratedConfig
  };
}

async function readThemeGroupConfigInternal(configRoot: string, groupId: string) {
  await ensureDefaultThemeGroups(configRoot);
  const resolved = getThemeConfigPath(configRoot, groupId);
  const raw = await fs.readFile(resolved.configPath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const hasLegacyShape =
    !isThemeColorMode(parsed.mode) ||
    (Array.isArray(parsed.files) &&
      parsed.files.some(
        (file) =>
          file &&
          typeof file === "object" &&
          ((file as Partial<ThemeAssetConfig>).type ?? "css") !== "js" &&
          !isThemeColorMode((file as Partial<ThemeCssAssetConfig>).colorMode)
      ));

  const loaded = hasLegacyShape
    ? await migrateLegacyThemeGroupConfig(configRoot, resolved.groupId, parsed)
    : {
        raw: serializeThemeGroupConfig(validateParsedThemeGroupConfig(parsed)),
        value: validateParsedThemeGroupConfig(parsed)
      };

  if (loaded.raw !== raw) {
    await fs.mkdir(resolved.groupDirectory, { recursive: true });
    await fs.writeFile(resolved.configPath, loaded.raw, "utf8");
  }

  return {
    groupDirectory: resolved.groupDirectory,
    groupId: resolved.groupId,
    raw: loaded.raw,
    value: loaded.value
  };
}

function themeGroupToSummary(groupId: string, value: ThemeGroupConfig): ThemeGroupSummary {
  return {
    ...value,
    groupId
  };
}

export async function listThemeGroups(configRoot: string) {
  await ensureDefaultThemeGroups(configRoot);
  const themeRoot = getThemeRoot(configRoot);
  const entries = await fs.readdir(themeRoot, { withFileTypes: true });
  const groups: ThemeGroupSummary[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const configPath = path.join(themeRoot, entry.name, THEME_CONFIG_FILE_NAME);
    if (!(await pathExists(configPath))) {
      continue;
    }

    const loaded = await readThemeGroupConfigInternal(configRoot, entry.name);
    groups.push(themeGroupToSummary(loaded.groupId, loaded.value));
  }

  groups.sort((left, right) => left.groupId.localeCompare(right.groupId));
  return {
    groups
  };
}

export async function readThemeGroupConfig(configRoot: string, groupId: string) {
  const loaded = await readThemeGroupConfigInternal(configRoot, groupId);
  return {
    groupId: loaded.groupId,
    raw: loaded.raw,
    value: loaded.value
  };
}

export async function saveThemeGroupConfig(configRoot: string, groupId: string, raw: string) {
  const resolved = getThemeConfigPath(configRoot, groupId);
  const value = validateParsedThemeGroupConfig(JSON.parse(raw));
  const normalizedRaw = serializeThemeGroupConfig(value);

  await fs.mkdir(resolved.groupDirectory, { recursive: true });
  await fs.writeFile(resolved.configPath, normalizedRaw, "utf8");

  return {
    groupId: resolved.groupId,
    raw: normalizedRaw,
    value
  };
}

export async function createThemeGroup(configRoot: string, groupId: string) {
  const resolved = getThemeGroupDirectory(configRoot, groupId);

  if (await pathExists(resolved.groupDirectory)) {
    throw new Error(`Theme group "${resolved.groupId}" already exists.`);
  }

  await fs.mkdir(resolved.groupDirectory, { recursive: false });
  await fs.writeFile(
    path.join(resolved.groupDirectory, THEME_CONFIG_FILE_NAME),
    serializeThemeGroupConfig({
      ...defaultThemeGroupConfig,
      label: resolved.groupId
    }),
    "utf8"
  );

  return readThemeGroupConfig(configRoot, resolved.groupId);
}

export async function renameThemeGroup(configRoot: string, groupId: string, nextGroupId: string) {
  const source = getThemeGroupDirectory(configRoot, groupId);
  const target = getThemeGroupDirectory(configRoot, nextGroupId);

  if (!(await pathExists(source.groupDirectory))) {
    throw new Error(`Theme group "${source.groupId}" does not exist.`);
  }

  if (await pathExists(target.groupDirectory)) {
    throw new Error(`Theme group "${target.groupId}" already exists.`);
  }

  await fs.rename(source.groupDirectory, target.groupDirectory);
  return readThemeGroupConfig(configRoot, target.groupId);
}

export async function deleteThemeGroup(configRoot: string, groupId: string) {
  const resolved = getThemeGroupDirectory(configRoot, groupId);

  if (!(await pathExists(resolved.groupDirectory))) {
    throw new Error(`Theme group "${resolved.groupId}" does not exist.`);
  }

  await fs.rm(resolved.groupDirectory, { recursive: true, force: false });
  return {
    groupId: resolved.groupId
  };
}

function inferThemeAssetType(fileName: string) {
  return fileName.toLowerCase().endsWith(".js") ? "js" : "css";
}

export async function readThemeAsset(configRoot: string, groupId: string, fileName: string): Promise<ThemeAssetPayload> {
  const config = await readThemeGroupConfigInternal(configRoot, groupId);
  const normalizedFileName = toPosixPath(fileName.trim());
  const metadata = config.value.files.find(
    (file) => file.fileName.toLowerCase() === normalizedFileName.toLowerCase()
  );

  if (!metadata) {
    throw new Error(`Theme asset "${normalizedFileName}" is not registered in group "${config.groupId}".`);
  }

  const resolved = resolveThemeAssetPath(configRoot, config.groupId, metadata.fileName);
  const raw = await fs.readFile(resolved.absolutePath, "utf8");

  return {
    adminPreview: metadata.adminPreview,
    assetPath: resolved.assetPath,
    colorMode: metadata.type === "css" ? metadata.colorMode : undefined,
    fileName: metadata.fileName,
    groupId: config.groupId,
    language: toThemeAssetLanguage(metadata.type),
    raw,
    type: metadata.type
  };
}

export async function saveThemeAsset(configRoot: string, groupId: string, fileName: string, raw: string) {
  const config = await readThemeGroupConfigInternal(configRoot, groupId);
  const metadata = config.value.files.find(
    (file) => file.fileName.toLowerCase() === toPosixPath(fileName.trim()).toLowerCase()
  );

  if (!metadata) {
    throw new Error(`Theme asset "${fileName}" is not registered in group "${config.groupId}".`);
  }

  const resolved = resolveThemeAssetPath(configRoot, config.groupId, metadata.fileName);
  await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await fs.writeFile(resolved.absolutePath, raw, "utf8");

  return readThemeAsset(configRoot, config.groupId, metadata.fileName);
}

export async function createThemeAsset(
  configRoot: string,
  groupId: string,
  fileName: string,
  type: ThemeAssetType,
  adminPreview: boolean,
  colorMode?: ThemeColorMode
) {
  const config = await readThemeGroupConfigInternal(configRoot, groupId);
  const resolvedColorMode = type === "css" ? colorMode ?? config.value.mode : undefined;
  const normalizedFileName =
    type === "css"
      ? withThemeColorModeFileName(fileName, resolvedColorMode ?? "light")
      : normalizeThemeAssetFileName(fileName, type);

  if (config.value.files.some((file) => file.fileName.toLowerCase() === normalizedFileName.toLowerCase())) {
    throw new Error(`Theme asset "${normalizedFileName}" already exists in group "${config.groupId}".`);
  }

  const resolved = resolveThemeAssetPath(configRoot, config.groupId, normalizedFileName, type);
  await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
  await fs.writeFile(
    resolved.absolutePath,
    buildThemeAssetTemplate(config.groupId, normalizedFileName, type),
    "utf8"
  );

  await saveThemeGroupConfig(
    configRoot,
    config.groupId,
    JSON.stringify(
      {
        ...config.value,
        files: [
          ...config.value.files,
          type === "css"
            ? {
                adminPreview,
                colorMode: resolvedColorMode ?? "light",
                fileName: normalizedFileName,
                type
              }
            : {
                adminPreview,
                fileName: normalizedFileName,
                type
              }
        ]
      },
      null,
      2
    )
  );

  return readThemeAsset(configRoot, config.groupId, normalizedFileName);
}

export async function renameThemeAsset(
  configRoot: string,
  groupId: string,
  fileName: string,
  nextFileName: string
) {
  const config = await readThemeGroupConfigInternal(configRoot, groupId);
  const metadata = config.value.files.find(
    (file) => file.fileName.toLowerCase() === toPosixPath(fileName.trim()).toLowerCase()
  );

  if (!metadata) {
    throw new Error(`Theme asset "${fileName}" is not registered in group "${config.groupId}".`);
  }

  const nextNormalizedFileName =
    metadata.type === "css"
      ? withThemeColorModeFileName(nextFileName, metadata.colorMode)
      : normalizeThemeAssetFileName(nextFileName, metadata.type);

  if (
    config.value.files.some(
      (file) =>
        file.fileName.toLowerCase() === nextNormalizedFileName.toLowerCase() &&
        file.fileName.toLowerCase() !== metadata.fileName.toLowerCase()
    )
  ) {
    throw new Error(`Theme asset "${nextNormalizedFileName}" already exists in group "${config.groupId}".`);
  }

  const source = resolveThemeAssetPath(configRoot, config.groupId, metadata.fileName);
  const target = resolveThemeAssetPath(configRoot, config.groupId, nextNormalizedFileName, metadata.type);
  await fs.mkdir(path.dirname(target.absolutePath), { recursive: true });
  await fs.rename(source.absolutePath, target.absolutePath);

  await saveThemeGroupConfig(
    configRoot,
    config.groupId,
    JSON.stringify(
      {
        ...config.value,
        files: config.value.files.map((file) =>
          file.fileName.toLowerCase() === metadata.fileName.toLowerCase()
            ? { ...file, fileName: nextNormalizedFileName }
            : file
        )
      },
      null,
      2
    )
  );

  return readThemeAsset(configRoot, config.groupId, nextNormalizedFileName);
}

export async function deleteThemeAsset(configRoot: string, groupId: string, fileName: string) {
  const config = await readThemeGroupConfigInternal(configRoot, groupId);
  const metadata = config.value.files.find(
    (file) => file.fileName.toLowerCase() === toPosixPath(fileName.trim()).toLowerCase()
  );

  if (!metadata) {
    throw new Error(`Theme asset "${fileName}" is not registered in group "${config.groupId}".`);
  }

  const resolved = resolveThemeAssetPath(configRoot, config.groupId, metadata.fileName);
  await fs.rm(resolved.absolutePath, { force: false });
  await saveThemeGroupConfig(
    configRoot,
    config.groupId,
    JSON.stringify(
      {
        ...config.value,
        files: config.value.files.filter(
          (file) => file.fileName.toLowerCase() !== metadata.fileName.toLowerCase()
        )
      },
      null,
      2
    )
  );

  return {
    assetPath: resolved.assetPath,
    fileName: metadata.fileName,
    groupId: config.groupId
  };
}

export async function listEnabledThemeAssets(configRoot: string) {
  const payload = await listThemeGroups(configRoot);
  return payload.groups.flatMap((group) =>
    group.enable
      ? group.files
          .filter((file) => file.type === "js" || file.colorMode === group.mode)
          .map((file) => ({
            ...file,
            assetPath: `${group.groupId}/${file.fileName}`,
            groupId: group.groupId,
            language: toThemeAssetLanguage(file.type)
          }))
      : []
  );
}

export function getThemeGroupsRoot(configRoot: string) {
  return getThemeRoot(configRoot);
}
