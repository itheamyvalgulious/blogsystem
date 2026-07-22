import { Router } from "express";

import {
  previewMarkdownSearch,
  replaceAllMarkdownSearch,
  replaceNextMarkdownSearch
} from "../markdown-search-service.js";

export interface SearchRouterDeps {
  contentRoot: string;
}

interface SearchBody {
  flags?: string;
  pattern?: string;
  replace?: string;
  scope?: "body" | "wholeFile";
}

function toSearchOptions(body: SearchBody) {
  return {
    flags: body.flags,
    pattern: body.pattern ?? "",
    replace: body.replace ?? "",
    scope: body.scope ?? "body"
  };
}

export function createSearchRouter(deps: SearchRouterDeps) {
  const router = Router();

  router.post("/api/search/markdown/preview", async (req, res, next) => {
    try {
      res.json(
        await previewMarkdownSearch(deps.contentRoot, toSearchOptions(req.body as SearchBody))
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/search/markdown/replace-next", async (req, res, next) => {
    try {
      const { matchKey, ...search } = req.body as SearchBody & { matchKey?: string };

      res.json(
        await replaceNextMarkdownSearch(
          deps.contentRoot,
          toSearchOptions(search),
          matchKey ?? ""
        )
      );
    } catch (error) {
      next(error);
    }
  });

  router.post("/api/search/markdown/replace-all", async (req, res, next) => {
    try {
      res.json(
        await replaceAllMarkdownSearch(deps.contentRoot, toSearchOptions(req.body as SearchBody))
      );
    } catch (error) {
      next(error);
    }
  });

  return router;
}
