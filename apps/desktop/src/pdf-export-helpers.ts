/**
 * Pure helper functions for Electron PDF export.
 *
 * These functions have zero Electron / DOM dependencies and can be
 * tested with plain Node.js.
 *
 * @module pdf-export-helpers
 */

import path from "node:path";

/**
 * Derive a safe filename from user-provided text.
 *
 * - Normalises `/` and `\\` to the platform separator so `path.basename`
 *   catches everything.
 * - Falls back to `"article"` for empty / falsy input.
 * - Appends `".pdf"` if the basename does not already end with `.pdf`
 *   (case-insensitive).
 *
 * @param input - Raw user-provided string (may contain full paths).
 * @returns A plain filename (no directory component) with `.pdf` suffix.
 */
export function sanitizePdfFilename(input: string): string {
  const effective = (input || "").trim() || "article";
  const normalized = effective.replace(/[/\\]/g, path.sep);
  const name = path.basename(normalized);
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}

/**
 * Ensure `filePath` ends with `.pdf` (case-insensitive check).
 *
 * - If the path already has a `.pdf` suffix (any casing), it is returned
 *   unchanged so the user's casing is preserved.
 * - Otherwise `".pdf"` (lowercase) is appended.
 * - Never strips the user's directory or filename.
 *
 * @param filePath - Absolute or relative path returned from the save dialog.
 * @returns The same path guaranteed to end with `.pdf`.
 */
export function ensurePdfExtension(filePath: string): string {
  return /\.pdf$/i.test(filePath) ? filePath : `${filePath}.pdf`;
}

/**
 * Clamp a number between `min` and `max` (inclusive).
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Race a promise against a timeout.
 *
 * If the timeout fires before `promise` settles, the returned promise rejects
 * with an `Error` whose message includes `context`.  The original promise is
 * **not** cancelled (JavaScript has no built-in cancellation), but the caller
 * can move on without waiting for it.
 *
 * @param promise - The operation to bound.
 * @param ms - Timeout in milliseconds.
 * @param context - Short label for the error message (e.g. `"font/image load"`).
 * @returns The resolved value of `promise`, or rejects on timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  context: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const race = Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${context} timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]);

  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  race.then(clear, clear);
  return race;
}

/**
 * Format a byte count into a human-readable string (e.g. `"12.34 kB"`).
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Determine whether an extra overwrite confirmation dialog is needed.
 *
 * The native save dialog already asks for confirmation on `originalPath`.
 * If we appended `.pdf` (i.e. `targetPath !== originalPath`), that
 * confirmation did **not** cover the target path. In that case, if the
 * target already exists, the caller must show a secondary confirmation
 * before overwriting it.
 *
 * @returns `true` when a secondary confirmation should be shown.
 */
export function shouldConfirmPdfOverwrite(originalPath: string, targetPath: string, targetExists: boolean): boolean {
  return originalPath !== targetPath && targetExists;
}