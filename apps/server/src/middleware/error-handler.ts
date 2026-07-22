import type express from "express";

import { DuplicateArticleTitleError } from "../content-service.js";
import { ApiError } from "../errors.js";
import { MarkdownSearchError } from "../markdown-search-service.js";

const GENERIC_SERVER_ERROR = "Internal server error.";

/**
 * Central error mapping:
 * - typed business errors keep their existing response shapes
 *   (DuplicateArticleTitleError -> 409, MarkdownSearchError -> its status/code,
 *   ApiError -> its status with a client-safe message)
 * - filesystem "not found" (ENOENT) -> 404
 * - filesystem "path used as the wrong kind" (EISDIR/ENOTDIR) -> 400
 * - everything else -> 500 with a generic message; the real error (which may
 *   contain absolute server paths) is only logged server-side.
 */
export function errorHandler(
  error: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction
) {
  if (error instanceof DuplicateArticleTitleError) {
    res.status(409).json({
      code: error.code,
      conflicts: error.conflicts,
      error: error.message
    });
    return;
  }

  if (error instanceof MarkdownSearchError) {
    res.status(error.status).json({
      code: error.code,
      error: error.message
    });
    return;
  }

  if (error instanceof ApiError) {
    res.status(error.status).json({ error: error.message });
    return;
  }

  const fsError = error as NodeJS.ErrnoException | undefined;
  if (fsError?.code === "ENOENT") {
    res.status(404).json({ error: "Resource not found." });
    return;
  }

  if (fsError?.code === "EISDIR" || fsError?.code === "ENOTDIR") {
    res.status(400).json({ error: "Invalid path." });
    return;
  }

  console.error(error);
  res.status(500).json({ error: GENERIC_SERVER_ERROR });
}
