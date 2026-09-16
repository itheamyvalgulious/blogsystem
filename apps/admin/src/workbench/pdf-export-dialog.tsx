/**
 * PDF export settings dialog.
 *
 * Allows the user to configure page size, orientation, margins, scale, and
 * print-background before triggering the export. The dialog is opened from
 * the file-tree context menu ("Export PDF") on article nodes.
 *
 * The actual export is delegated to the `onExport` callback which receives
 * the final settings and the article identity from the parent.
 */

import { useState } from "react";
import { getErrorMessage } from "@blog-system/content-core";

import type {
  PdfExportSettings,
  PdfPageSize,
  PdfOrientation,
  PdfMarginsMm
} from "./pdf-types";
import { DEFAULT_PDF_SETTINGS } from "./pdf-types";

export interface PdfExportDialogProps {
  articlePath: string;
  articleTitle: string;
  /** Called when the dialog closes without exporting. */
  onClose: () => void;
  /** Called with settings + article path when the user confirms export. */
  onExport: (settings: PdfExportSettings, info: { articlePath: string }) => Promise<void>;
}

export function PdfExportDialog({
  articlePath,
  articleTitle,
  onClose,
  onExport
}: PdfExportDialogProps) {
  const [settings, setSettings] = useState<PdfExportSettings>(DEFAULT_PDF_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async () => {
    setBusy(true);
    setError(null);
    try {
      await onExport(settings, { articlePath });
      onClose();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const updateSetting = <K extends keyof PdfExportSettings>(
    key: K,
    value: PdfExportSettings[K]
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const updateMargin = (key: keyof PdfMarginsMm, value: string) => {
    const num = Number(value);
    if (!Number.isFinite(num)) return;
    setSettings((prev) => ({
      ...prev,
      marginsMm: { ...prev.marginsMm, [key]: Math.max(0, Math.min(50, num)) }
    }));
  };

  const pageSizes: { value: PdfPageSize; label: string }[] = [
    { value: "A4", label: "A4 (210 × 297 mm)" },
    { value: "A5", label: "A5 (148 × 210 mm)" },
    { value: "Letter", label: "Letter (215.9 × 279.4 mm)" },
    { value: "Legal", label: "Legal (215.9 × 355.6 mm)" }
  ];

  return (
    <div className="dialog-backdrop" onClick={onClose} role="presentation">
      <div className="dialog-card pdf-export-dialog" onClick={(e) => e.stopPropagation()}>
        <p className="title-overline">PDF Export</p>
        <h2>{articleTitle}</h2>
        <p className="body-muted">{articlePath}</p>

        <div className="pdf-export-settings">
          <label>
            <span>Paper Size</span>
            <select
              value={settings.pageSize}
              onChange={(e) => updateSetting("pageSize", e.target.value as PdfPageSize)}
            >
              {pageSizes.map((size) => (
                <option key={size.value} value={size.value}>{size.label}</option>
              ))}
            </select>
          </label>

          <label>
            <span>Orientation</span>
            <select
              value={settings.orientation}
              onChange={(e) => updateSetting("orientation", e.target.value as PdfOrientation)}
            >
              <option value="portrait">Portrait</option>
              <option value="landscape">Landscape</option>
            </select>
          </label>

          <fieldset className="pdf-export-margins">
            <legend>Margins (mm)</legend>
            <div className="pdf-export-margin-grid">
              <label>
                <span>Top</span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={settings.marginsMm.top}
                  onChange={(e) => updateMargin("top", e.target.value)}
                />
              </label>
              <label>
                <span>Right</span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={settings.marginsMm.right}
                  onChange={(e) => updateMargin("right", e.target.value)}
                />
              </label>
              <label>
                <span>Bottom</span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={settings.marginsMm.bottom}
                  onChange={(e) => updateMargin("bottom", e.target.value)}
                />
              </label>
              <label>
                <span>Left</span>
                <input
                  type="number"
                  min={0}
                  max={50}
                  value={settings.marginsMm.left}
                  onChange={(e) => updateMargin("left", e.target.value)}
                />
              </label>
            </div>
          </fieldset>

          <label>
            <span>Scale: {settings.scale.toFixed(2)}x</span>
            <input
              type="range"
              min={0.5}
              max={2}
              step={0.05}
              value={settings.scale}
              onChange={(e) => updateSetting("scale", Number(e.target.value))}
            />
          </label>

          <label className="pdf-export-checkbox">
            <input
              type="checkbox"
              checked={settings.printBackground}
              onChange={(e) => updateSetting("printBackground", e.target.checked)}
            />
            <span>Print background (colors & images)</span>
          </label>
        </div>

        {error ? <p className="error-text">{error}</p> : null}

        <div className="dialog-actions">
          <button className="action-button ghost" onClick={onClose} type="button" disabled={busy}>
            Cancel
          </button>
          <button
            className="action-button primary"
            onClick={() => void handleExport()}
            type="button"
            disabled={busy}
          >
            {busy ? "Exporting..." : "Export PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}