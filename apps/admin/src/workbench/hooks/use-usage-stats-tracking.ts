import { startTransition, useCallback, useEffect, useRef, type Dispatch, type SetStateAction } from "react";

import { api, type UsageStatsPayload } from "../../api";
import { buildUsageStatsDocument } from "../document-builders";
import type { WorkbenchDocument, WorkbenchEditorId } from "../types";

const USAGE_STATS_FLUSH_DEBOUNCE_MS = 2500;
const USAGE_STATS_ACTIVITY_TICK_MS = 15000;
const USAGE_STATS_ACTIVITY_IDLE_MS = 60000;

interface UsageStatsTrackingOptions {
  authenticated: boolean;
  setDocuments: Dispatch<SetStateAction<WorkbenchDocument[]>>;
  setPageError: (message: string | null) => void;
  setUsageStatsPayload: Dispatch<SetStateAction<UsageStatsPayload | null>>;
  withResolvedEditor: <T extends WorkbenchDocument>(document: T, preferredEditorId?: WorkbenchEditorId) => T;
}

export function useUsageStatsTracking({
  authenticated,
  setDocuments,
  setPageError,
  setUsageStatsPayload,
  withResolvedEditor
}: UsageStatsTrackingOptions) {
  const usageStatsFlushTimerRef = useRef<number | null>(null);
  const usageStatsActivityTimerRef = useRef<number | null>(null);
  const usageStatsPendingActiveMsRef = useRef(0);
  const usageStatsPendingDocumentDeltaRef = useRef<
    Map<string, { documentId: string; documentKind: string; title: string; netCharacterDelta: number }>
  >(new Map());
  const usageStatsLastInteractionAtRef = useRef<number | null>(null);

  const flushUsageStats = useCallback(async () => {
    if (!authenticated) {
      return null;
    }

    if (usageStatsFlushTimerRef.current !== null) {
      window.clearTimeout(usageStatsFlushTimerRef.current);
      usageStatsFlushTimerRef.current = null;
    }

    const activeMilliseconds = usageStatsPendingActiveMsRef.current;
    const documents = [...usageStatsPendingDocumentDeltaRef.current.values()].filter(
      (entry) => entry.netCharacterDelta !== 0
    );

    if (activeMilliseconds <= 0 && documents.length === 0) {
      return null;
    }

    usageStatsPendingActiveMsRef.current = 0;
    usageStatsPendingDocumentDeltaRef.current = new Map();

    const payload = await api.recordUsageStats({
      activeMilliseconds,
      documents
    });

    startTransition(() => {
      setUsageStatsPayload(payload);
      setDocuments((current) =>
        current.map((document) =>
          document.kind === "usageStats"
            ? withResolvedEditor(buildUsageStatsDocument(payload), document.editorId)
            : document
        )
      );
    });

    return payload;
  }, [authenticated, withResolvedEditor]);

  const scheduleUsageStatsFlush = useCallback(() => {
    if (!authenticated) {
      return;
    }

    if (usageStatsFlushTimerRef.current !== null) {
      return;
    }

    usageStatsFlushTimerRef.current = window.setTimeout(() => {
      void flushUsageStats().catch((error: Error) => {
        setPageError(error.message);
      });
    }, USAGE_STATS_FLUSH_DEBOUNCE_MS);
  }, [authenticated, flushUsageStats]);

  const queueUsageDocumentDelta = useCallback(
    (document: WorkbenchDocument, netCharacterDelta: number) => {
      if (!authenticated || netCharacterDelta === 0 || document.kind === "home" || document.kind === "usageStats") {
        return;
      }

      const current =
        usageStatsPendingDocumentDeltaRef.current.get(document.id) ?? {
          documentId: document.id,
          documentKind: document.kind,
          title: document.title,
          netCharacterDelta: 0
        };

      usageStatsPendingDocumentDeltaRef.current.set(document.id, {
        ...current,
        documentKind: document.kind,
        title: document.title,
        netCharacterDelta: current.netCharacterDelta + netCharacterDelta
      });
      scheduleUsageStatsFlush();
    },
    [authenticated, scheduleUsageStatsFlush]
  );

  const markUsageActivity = useCallback(() => {
    if (!authenticated) {
      return;
    }

    const now = Date.now();
    const previous = usageStatsLastInteractionAtRef.current;
    usageStatsLastInteractionAtRef.current = now;

    if (previous === null) {
      return;
    }

    const elapsed = now - previous;
    if (elapsed <= 0 || elapsed > USAGE_STATS_ACTIVITY_IDLE_MS) {
      return;
    }

    usageStatsPendingActiveMsRef.current += elapsed;
    scheduleUsageStatsFlush();
  }, [authenticated, scheduleUsageStatsFlush]);

  useEffect(() => {
    if (!authenticated) {
      usageStatsLastInteractionAtRef.current = null;
      if (usageStatsActivityTimerRef.current !== null) {
        window.clearInterval(usageStatsActivityTimerRef.current);
        usageStatsActivityTimerRef.current = null;
      }
      return;
    }

    usageStatsLastInteractionAtRef.current = Date.now();
    const activityListener = () => {
      markUsageActivity();
    };
    const activityEvents: Array<keyof WindowEventMap> = [
      "pointerdown",
      "keydown",
      "mousemove",
      "focus"
    ];

    for (const eventName of activityEvents) {
      window.addEventListener(eventName, activityListener, true);
    }

    usageStatsActivityTimerRef.current = window.setInterval(() => {
      markUsageActivity();
    }, USAGE_STATS_ACTIVITY_TICK_MS);

    return () => {
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, activityListener, true);
      }

      if (usageStatsActivityTimerRef.current !== null) {
        window.clearInterval(usageStatsActivityTimerRef.current);
        usageStatsActivityTimerRef.current = null;
      }
    };
  }, [authenticated, markUsageActivity]);

  return {
    flushUsageStats,
    markUsageActivity,
    queueUsageDocumentDelta,
    usageStatsActivityTimerRef,
    usageStatsFlushTimerRef
  };
}
