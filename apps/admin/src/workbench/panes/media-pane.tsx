import { useEffect, useState } from "react";

import { getErrorMessage } from "@blog-system/content-core";

import { api, type MediaAssetPayload } from "../../api";
import { formatBytes } from "../../utils";

import type { PaneComponentProps } from "../types";

async function fileToBase64(file: File) {
  return new Promise<{ mimeType: string; base64Data: string; fileName: string }>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve({
        mimeType: file.type,
        base64Data: result.split(",")[1] ?? "",
        fileName: file.name
      });
    };
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read media file."));
    reader.readAsDataURL(file);
  });
}

export function MediaPane({ api: workbenchApi }: PaneComponentProps) {
  const [assets, setAssets] = useState<MediaAssetPayload[]>([]);

  const loadAssets = async () => {
    try {
      const response = await api.listMediaAssets();
      setAssets(response.assets);
      workbenchApi.showError(null);
    } catch (error) {
      workbenchApi.showError(getErrorMessage(error));
    }
  };

  useEffect(() => {
    queueMicrotask(() => {
      void loadAssets();
    });
  }, []);

  const uploadFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) {
      return;
    }

    workbenchApi.setBusy("Uploading media...");
    try {
      const images = await Promise.all(Array.from(files).map((file) => fileToBase64(file)));
      await api.uploadMediaAssets(images);
      await loadAssets();
      workbenchApi.showError(null);
    } catch (error) {
      workbenchApi.showError(getErrorMessage(error));
    } finally {
      workbenchApi.setBusy(null);
    }
  };

  return (
    <div className="sidebar-scroll">
      <div className="sidebar-section">
        <label>
          <span>Upload Images</span>
          <input
            accept="image/*"
            onChange={(event) => void uploadFiles(event.target.files)}
            type="file"
            multiple
          />
        </label>
      </div>
      <div className="sidebar-section media-list">
        {assets.length === 0 ? (
          <div className="empty-state">No media assets.</div>
        ) : (
          assets.map((asset) => (
            <button
              className="search-result"
              key={asset.relativePath}
              onClick={async () => {
                await navigator.clipboard.writeText(`@media/${asset.fileName}`);
              }}
              type="button"
            >
              <img alt={asset.fileName} src={asset.urlPath} />
              <strong>{asset.fileName}</strong>
              <span>{asset.mimeType} | {formatBytes(asset.size)}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
