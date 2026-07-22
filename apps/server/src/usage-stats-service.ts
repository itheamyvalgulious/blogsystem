import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  UsageStats,
  UsageStatsDocumentEntry,
  UsageStatsPeriodEntry
} from "@blog-system/content-core";

const DEFAULT_USAGE_STATS: UsageStats = {
  daily: [],
  documents: [],
  totalActiveMilliseconds: 0,
  totalNetCharacterDelta: 0,
  updatedAt: new Date(0).toISOString()
};

interface UsageStatsPatch {
  activeMilliseconds?: number;
  documents?: Array<{
    documentId: string;
    documentKind: string;
    title: string;
    netCharacterDelta: number;
  }>;
}

function getUsageStatsPath(configRoot: string) {
  return path.join(configRoot, "usage-stats.json");
}

function getPeriodKeyForDate(date: Date, timeZoneOffsetMinutes = date.getTimezoneOffset()) {
  return new Date(date.getTime() - timeZoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function getCurrentPeriodKey(now = new Date(Date.now())) {
  return getPeriodKeyForDate(now);
}

function normalizeDocumentEntry(
  value: Partial<UsageStatsDocumentEntry> & { documentId: string }
): UsageStatsDocumentEntry {
  return {
    documentId: value.documentId,
    documentKind: typeof value.documentKind === "string" ? value.documentKind : "unknown",
    title: typeof value.title === "string" ? value.title : value.documentId,
    netCharacterDelta: Number.isFinite(value.netCharacterDelta) ? Number(value.netCharacterDelta) : 0,
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim()
        ? value.updatedAt
        : new Date().toISOString()
  };
}

function mergeDocumentEntries(entries: UsageStatsDocumentEntry[]) {
  const documentMap = new Map<string, UsageStatsDocumentEntry>();

  for (const entry of entries) {
    const current = documentMap.get(entry.documentId);
    if (!current) {
      documentMap.set(entry.documentId, normalizeDocumentEntry(entry));
      continue;
    }

    documentMap.set(
      entry.documentId,
      normalizeDocumentEntry({
        documentId: entry.documentId,
        documentKind: entry.documentKind || current.documentKind,
        title: entry.title || current.title,
        netCharacterDelta: current.netCharacterDelta + entry.netCharacterDelta,
        updatedAt: entry.updatedAt > current.updatedAt ? entry.updatedAt : current.updatedAt
      })
    );
  }

  return [...documentMap.values()].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function normalizePeriodEntry(
  value: Partial<UsageStatsPeriodEntry> & { periodKey: string }
): UsageStatsPeriodEntry {
  const documents = Array.isArray(value.documents)
    ? mergeDocumentEntries(
        value.documents.filter(
          (entry): entry is UsageStatsDocumentEntry =>
            Boolean(entry && typeof entry.documentId === "string" && entry.documentId.trim())
        )
      )
    : [];

  return {
    activeMilliseconds: Number.isFinite(value.activeMilliseconds)
      ? Math.max(0, Number(value.activeMilliseconds))
      : 0,
    documents,
    periodKey: value.periodKey,
    totalNetCharacterDelta: Number.isFinite(value.totalNetCharacterDelta)
      ? Number(value.totalNetCharacterDelta)
      : documents.reduce((sum, entry) => sum + entry.netCharacterDelta, 0),
    updatedAt:
      typeof value.updatedAt === "string" && value.updatedAt.trim()
        ? value.updatedAt
        : documents[0]?.updatedAt ?? new Date().toISOString()
  };
}

function normalizeUsageStats(value: Partial<UsageStats> | null | undefined): UsageStats {
  const daily = Array.isArray(value?.daily)
    ? value.daily
        .filter((entry) =>
          Boolean(entry && typeof entry.periodKey === "string" && /^\d{4}-\d{2}-\d{2}$/.test(entry.periodKey))
        )
        .map((entry) => normalizePeriodEntry(entry))
        .sort((left, right) => right.periodKey.localeCompare(left.periodKey))
    : [];

  const documents =
    Array.isArray(value?.documents) && value.documents.length > 0
      ? mergeDocumentEntries(
          value.documents.filter(
            (entry): entry is UsageStatsDocumentEntry =>
              Boolean(entry && typeof entry.documentId === "string" && entry.documentId.trim())
          )
        )
      : mergeDocumentEntries(daily.flatMap((entry) => entry.documents));

  return {
    daily,
    documents,
    totalActiveMilliseconds: Number.isFinite(value?.totalActiveMilliseconds)
      ? Math.max(0, Number(value?.totalActiveMilliseconds))
      : daily.reduce((sum, entry) => sum + entry.activeMilliseconds, 0),
    totalNetCharacterDelta: Number.isFinite(value?.totalNetCharacterDelta)
      ? Number(value?.totalNetCharacterDelta)
      : daily.reduce((sum, entry) => sum + entry.totalNetCharacterDelta, 0),
    updatedAt:
      typeof value?.updatedAt === "string" && value.updatedAt.trim()
        ? value.updatedAt
        : daily[0]?.updatedAt ?? documents[0]?.updatedAt ?? new Date().toISOString()
  };
}

async function readOptionalUsageStats(configRoot: string) {
  const filePath = getUsageStatsPath(configRoot);

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeUsageStats(JSON.parse(raw) as Partial<UsageStats>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }
}

function buildDailyAggregate(
  currentValue: UsageStats,
  periodKey: string,
  patch: UsageStatsPatch,
  now: string
) {
  const currentPeriod =
    currentValue.daily.find((entry) => entry.periodKey === periodKey) ??
    normalizePeriodEntry({
      activeMilliseconds: 0,
      documents: [],
      periodKey,
      totalNetCharacterDelta: 0,
      updatedAt: now
    });

  const patchDocuments = (patch.documents ?? []).filter((entry) => entry.documentId.trim()).map((entry) =>
    normalizeDocumentEntry({
      documentId: entry.documentId,
      documentKind: entry.documentKind,
      title: entry.title,
      netCharacterDelta: entry.netCharacterDelta,
      updatedAt: now
    })
  );

  return normalizePeriodEntry({
    activeMilliseconds:
      currentPeriod.activeMilliseconds +
      (Number.isFinite(patch.activeMilliseconds) ? Math.max(0, Number(patch.activeMilliseconds)) : 0),
    documents: [...currentPeriod.documents, ...patchDocuments],
    periodKey,
    totalNetCharacterDelta:
      currentPeriod.totalNetCharacterDelta +
      patchDocuments.reduce((sum, entry) => sum + entry.netCharacterDelta, 0),
    updatedAt: now
  });
}

export async function loadUsageStats(configRoot: string) {
  const value = (await readOptionalUsageStats(configRoot)) ?? DEFAULT_USAGE_STATS;
  return {
    raw: `${JSON.stringify(value, null, 2)}\n`,
    value
  };
}

export async function recordUsageStats(configRoot: string, patch: UsageStatsPatch) {
  const currentValue = (await readOptionalUsageStats(configRoot)) ?? DEFAULT_USAGE_STATS;
  const currentDate = new Date(Date.now());
  const now = currentDate.toISOString();
  const periodKey = getCurrentPeriodKey(currentDate);
  const nextDailyEntry = buildDailyAggregate(currentValue, periodKey, patch, now);
  const nextDaily = [
    nextDailyEntry,
    ...currentValue.daily.filter((entry) => entry.periodKey !== periodKey)
  ].sort((left, right) => right.periodKey.localeCompare(left.periodKey));

  const nextValue = normalizeUsageStats({
    daily: nextDaily,
    updatedAt: now
  });
  const filePath = getUsageStatsPath(configRoot);
  const raw = `${JSON.stringify(nextValue, null, 2)}\n`;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, raw, "utf8");

  return {
    raw,
    value: nextValue
  };
}
