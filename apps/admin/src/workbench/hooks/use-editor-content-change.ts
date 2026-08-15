import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import GithubSlugger from "github-slugger";

import type {
  EditorContentChangedEvent,
  WorkbenchEditorHandle
} from "../editor-engine";

import {
  scanDocumentMathPairs,
  updateMathPairsCache,
  type MathPair
} from "../../markdown-math-scanner";
import {
  hashLine,
  scanHeadingsFromText,
  type CachedHeading
} from "../../markdown-outline";
import {
  isArticleDocument,
  shouldStoreLiveDocumentValue
} from "../document-builders";
import type { WorkbenchDocument } from "../types";

interface EditorContentChangeOptions {
  activeDocument: WorkbenchDocument | null;
  activeDocumentSupportsPreview: boolean;
  dirtyDocumentIdsRef: RefObject<Set<string>>;
  draftValuesRef: RefObject<Record<string, string>>;
  editorRef: RefObject<WorkbenchEditorHandle | null>;
  headingsRef: RefObject<CachedHeading[]>;
  markUsageActivity: () => void;
  mathPairsRef: RefObject<MathPair[]>;
  queueUsageDocumentDelta: (document: WorkbenchDocument, netCharacterDelta: number) => void;
  scheduleDocumentDirtyCheck: (documentId: string) => void;
  scheduleDocumentPreviewUpdate: (document: WorkbenchDocument, nextValue: string) => void;
  scheduleDraftValueSync: (document: WorkbenchDocument) => void;
  setDocuments: Dispatch<SetStateAction<WorkbenchDocument[]>>;
  syncOutlineHeadings: () => void;
}

export function useEditorContentChange({
  activeDocument,
  activeDocumentSupportsPreview,
  dirtyDocumentIdsRef,
  draftValuesRef,
  editorRef,
  headingsRef,
  markUsageActivity,
  mathPairsRef,
  queueUsageDocumentDelta,
  scheduleDocumentDirtyCheck,
  scheduleDocumentPreviewUpdate,
  scheduleDraftValueSync,
  setDocuments,
  syncOutlineHeadings
}: EditorContentChangeOptions) {
  const handleDocumentValueChange = useCallback(
    (nextValue: string) => {
      if (!activeDocument) {
        return;
      }

      const previousValue = draftValuesRef.current[activeDocument.id] ?? activeDocument.savedValue;
      const netCharacterDelta = nextValue.length - previousValue.length;

      draftValuesRef.current[activeDocument.id] = nextValue;
      const shouldStoreValue = shouldStoreLiveDocumentValue(activeDocument);
      setDocuments((current) => {
        let changed = false;
        const nextDocuments = current.map((document) => {
          if (document.id !== activeDocument.id) {
            return document;
          }

          const shouldBeDirty = true;
          if (
            document.dirty !== shouldBeDirty ||
            (shouldStoreValue && document.value !== nextValue)
          ) {
            changed = true;
            return {
              ...document,
              dirty: shouldBeDirty,
              value: shouldStoreValue ? nextValue : document.value
            };
          }

          return document;
        });

        return changed ? nextDocuments : current;
      });

      scheduleDocumentDirtyCheck(activeDocument.id);
      queueUsageDocumentDelta(activeDocument, netCharacterDelta);
      markUsageActivity();

      if (activeDocumentSupportsPreview) {
        scheduleDocumentPreviewUpdate(activeDocument, nextValue);
      }
    },
    [
      activeDocument,
      activeDocumentSupportsPreview,
      markUsageActivity,
      queueUsageDocumentDelta,
      scheduleDocumentDirtyCheck,
      scheduleDocumentPreviewUpdate
    ]
  );

  const handleEditorModelContentChange = useCallback(
    (event: EditorContentChangedEvent) => {
      if (!activeDocument || shouldStoreLiveDocumentValue(activeDocument)) {
        return;
      }

      const netCharacterDelta = event.changes.reduce(
        (sum, change) => sum + change.text.length - change.rangeLength,
        0
      );

      if (!dirtyDocumentIdsRef.current.has(activeDocument.id)) {
        dirtyDocumentIdsRef.current.add(activeDocument.id);
        setDocuments((current) => {
          let changed = false;
          const nextDocuments = current.map((document) => {
            if (document.id !== activeDocument.id || document.dirty) {
              return document;
            }

            changed = true;
            return { ...document, dirty: true };
          });

          return changed ? nextDocuments : current;
        });
      }

      if (isArticleDocument(activeDocument)) {
        const model = editorRef.current?.getModel();
        if (model) {
          const isSingleLine = event.changes.every(
            (c) => c.range.startLineNumber === c.range.endLineNumber && !c.text.includes("\n")
          );

          if (isSingleLine && event.changes.length === 1) {
            const change = event.changes[0];
            const lineNum = change.range.startLineNumber;
            const newLine = model.getLineContent(lineNum);

            // Incremental heading update
            const headings = headingsRef.current;
            let hLow = 0;
            let hHigh = headings.length - 1;
            let hIdx = -1;
            while (hLow <= hHigh) {
              const mid = (hLow + hHigh) >>> 1;
              if (headings[mid].lineNumber === lineNum) { hIdx = mid; break; }
              if (headings[mid].lineNumber < lineNum) hLow = mid + 1;
              else hHigh = mid - 1;
            }

            const headingMatch = /^(#{1,6})\s+(.+)$/.exec(newLine);
            if (hIdx >= 0) {
              if (headingMatch) {
                const newText = headingMatch[2].trim();
                const newHash = hashLine(newLine);
                if (headings[hIdx].text !== newText) {
                  const slugger = new GithubSlugger();
                  for (const h of headings) slugger.slug(h.text);
                  headings[hIdx] = { ...headings[hIdx], depth: headingMatch[1].length, text: newText, id: slugger.slug(newText), lineHash: newHash };
                } else {
                  headings[hIdx] = { ...headings[hIdx], depth: headingMatch[1].length, lineHash: newHash };
                }
              } else {
                headingsRef.current = headings.filter((_, i) => i !== hIdx);
              }
            } else if (headingMatch) {
              const newText = headingMatch[2].trim();
              if (newText) {
                const slugger = new GithubSlugger();
                for (const h of headings) slugger.slug(h.text);
                const newHeading: CachedHeading = {
                  depth: headingMatch[1].length,
                  text: newText,
                  id: slugger.slug(newText),
                  lineNumber: lineNum,
                  lineHash: hashLine(newLine)
                };
                const insertIdx = headings.findIndex((h) => h.lineNumber > lineNum);
                if (insertIdx === -1) headingsRef.current = [...headings, newHeading];
                else headingsRef.current = [...headings.slice(0, insertIdx), newHeading, ...headings.slice(insertIdx)];
              }
            }

            // Incremental math pairs update
            const pairs = mathPairsRef.current;
            let pLow = 0;
            let pHigh = pairs.length - 1;
            let pIdx = -1;
            while (pLow <= pHigh) {
              const mid = (pLow + pHigh) >>> 1;
              if (pairs[mid].endLine >= lineNum && pairs[mid].startLine <= lineNum) { pIdx = mid; break; }
              if (pairs[mid].endLine < lineNum) pLow = mid + 1;
              else pHigh = mid - 1;
            }

            const newDollarCount = (newLine.match(/\$/g) ?? []).length;
            // We can't easily get the old line, so we check if any pair boundary was on this line
            const affectedPair = pIdx >= 0 ? pairs[pIdx] : null;
            const pairBoundaryChanged = affectedPair
              ? (affectedPair.startLine === lineNum || affectedPair.endLine === lineNum)
              : newDollarCount > 0;

            if (pairBoundaryChanged) {
              // Full rescan of math pairs
              const fullText = model.getValue();
              const newPairs = scanDocumentMathPairs(fullText);
              mathPairsRef.current = newPairs;
              updateMathPairsCache(newPairs);
            }
          } else {
            // Multi-line change: full rebuild
            const fullText = model.getValue();
            headingsRef.current = scanHeadingsFromText(fullText);
            const newPairs = scanDocumentMathPairs(fullText);
            mathPairsRef.current = newPairs;
            updateMathPairsCache(newPairs);
          }

          syncOutlineHeadings();
        }
      }

      queueUsageDocumentDelta(activeDocument, netCharacterDelta);
      markUsageActivity();
      scheduleDraftValueSync(activeDocument);
    },
    [activeDocument, markUsageActivity, queueUsageDocumentDelta, scheduleDraftValueSync]
  );

  return {
    handleDocumentValueChange,
    handleEditorModelContentChange
  };
}
