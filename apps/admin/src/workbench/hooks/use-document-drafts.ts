import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { WorkbenchEditorHandle } from "../editor-engine";

import {
  canReadFullDocumentValueFromEditor
} from "../document-builders";
import type { PluginRuntime } from "../plugin-runtime";
import type { WorkbenchDocument } from "../types";

const DIRTY_CHECK_DEBOUNCE_MS = 700;

interface DocumentDraftsOptions {
  activeDocument: WorkbenchDocument | null;
  activeDocumentId: string | null;
  activeDocumentIdRef: RefObject<string | null>;
  dirtyCheckTimerRef: RefObject<number | null>;
  dirtyDocumentIdsRef: RefObject<Set<string>>;
  draftValuesRef: RefObject<Record<string, string>>;
  draftValueSyncTimerRef: RefObject<number | null>;
  editorRef: RefObject<WorkbenchEditorHandle | null>;
  pluginRuntime: PluginRuntime;
  setActiveDocumentId: Dispatch<SetStateAction<string | null>>;
  setDocuments: Dispatch<SetStateAction<WorkbenchDocument[]>>;
}

export function useDocumentDrafts({
  activeDocument,
  activeDocumentId,
  activeDocumentIdRef,
  dirtyCheckTimerRef,
  dirtyDocumentIdsRef,
  draftValuesRef,
  draftValueSyncTimerRef,
  editorRef,
  pluginRuntime,
  setActiveDocumentId,
  setDocuments
}: DocumentDraftsOptions) {
  const getDraftValue = useCallback(
    (document: WorkbenchDocument) => {
      if (document.id === activeDocumentId && canReadFullDocumentValueFromEditor(document)) {
        return editorRef.current?.getValue() ?? draftValuesRef.current[document.id] ?? document.savedValue;
      }

      return draftValuesRef.current[document.id] ?? document.savedValue;
    },
    [activeDocumentId]
  );

  const getRenderDraftValue = useCallback(
    (document: WorkbenchDocument) => draftValuesRef.current[document.id] ?? document.savedValue,
    []
  );

  const computeDocumentDirtyState = useCallback(
    (document: WorkbenchDocument, nextValue: string) =>
      pluginRuntime.getEditorContribution(document.editorId)?.isDirty?.(document, nextValue) ??
      nextValue !== document.value,
    [pluginRuntime]
  );

  const scheduleDocumentDirtyCheck = useCallback(
    (documentId: string) => {
      if (dirtyCheckTimerRef.current !== null) {
        window.clearTimeout(dirtyCheckTimerRef.current);
      }

      dirtyCheckTimerRef.current = window.setTimeout(() => {
        dirtyCheckTimerRef.current = null;
        setDocuments((current) => {
          let changed = false;
          const nextDocuments = current.map((document) => {
            if (document.id !== documentId) {
              return document;
            }

            const nextValue = draftValuesRef.current[document.id] ?? document.value;
            const shouldBeDirty = computeDocumentDirtyState(document, nextValue);
            if (document.dirty === shouldBeDirty) {
              return document;
            }

            changed = true;
            return { ...document, dirty: shouldBeDirty };
          });

          return changed ? nextDocuments : current;
        });
      }, DIRTY_CHECK_DEBOUNCE_MS);
    },
    [computeDocumentDirtyState]
  );

  const cancelPendingDirtyCheck = useCallback(() => {
    if (dirtyCheckTimerRef.current !== null) {
      window.clearTimeout(dirtyCheckTimerRef.current);
      dirtyCheckTimerRef.current = null;
    }
  }, []);

  const flushDocumentDraft = useCallback(
    (document: WorkbenchDocument | null = activeDocument) => {
      if (!document || !canReadFullDocumentValueFromEditor(document)) {
        return null;
      }

      const editor = editorRef.current;
      if (!editor || activeDocumentIdRef.current !== document.id) {
        return null;
      }

      if (draftValueSyncTimerRef.current !== null) {
        window.clearTimeout(draftValueSyncTimerRef.current);
        draftValueSyncTimerRef.current = null;
      }

      const nextValue = editor.getValue();
      draftValuesRef.current[document.id] = nextValue;
      const shouldBeDirty = computeDocumentDirtyState(document, nextValue);
      if (shouldBeDirty) {
        dirtyDocumentIdsRef.current.add(document.id);
      } else {
        dirtyDocumentIdsRef.current.delete(document.id);
      }
      setDocuments((current) => {
        let changed = false;
        const nextDocuments = current.map((currentDocument) => {
          if (currentDocument.id !== document.id || currentDocument.dirty === shouldBeDirty) {
            return currentDocument;
          }

          changed = true;
          return { ...currentDocument, dirty: shouldBeDirty };
        });

        return changed ? nextDocuments : current;
      });
      return nextValue;
    },
    [activeDocument, computeDocumentDirtyState]
  );

  const activateDocument = useCallback(
    (nextDocumentIdOrUpdater: SetStateAction<string | null>) => {
      flushDocumentDraft();
      setActiveDocumentId(nextDocumentIdOrUpdater);
    },
    [flushDocumentDraft]
  );

  return {
    activateDocument,
    cancelPendingDirtyCheck,
    computeDocumentDirtyState,
    flushDocumentDraft,
    getDraftValue,
    getRenderDraftValue,
    scheduleDocumentDirtyCheck
  };
}
