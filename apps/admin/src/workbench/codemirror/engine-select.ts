/**
 * Editor engine selection for the workbench.
 *
 * `live` is the CodeMirror 6 based engine (see `./cm-editor`), `monaco` the
 * classic Monaco engine. Preference resolution order:
 *
 * 1. `?engine=monaco|live` URL query parameter (per page load override).
 * 2. `localStorage["workbench.editorEngine"]` (set by `setPreferredEditorEngine`,
 *    e.g. via the `workbench.action.toggleEditorEngine` command palette entry).
 * 3. Default `"live"`.
 *
 * The resolved engine is cached at module level: switching engines requires a
 * reload, so the value is stable for the page lifecycle.
 */

export type WorkbenchEditorEngine = "live" | "monaco";

const ENGINE_STORAGE_KEY = "workbench.editorEngine";
const ENGINE_QUERY_PARAM = "engine";

function resolvePreferredEditorEngine(): WorkbenchEditorEngine {
  try {
    const fromQuery = new URLSearchParams(window.location.search).get(ENGINE_QUERY_PARAM);
    if (fromQuery === "monaco" || fromQuery === "live") {
      return fromQuery;
    }

    const stored = window.localStorage.getItem(ENGINE_STORAGE_KEY);
    if (stored === "monaco" || stored === "live") {
      return stored;
    }
  } catch {
    // window/localStorage unavailable (e.g. non-browser test run): fall through
    // to the default.
  }

  return "live";
}

let cachedEngine: WorkbenchEditorEngine | null = null;

export function getPreferredEditorEngine(): WorkbenchEditorEngine {
  cachedEngine ??= resolvePreferredEditorEngine();
  return cachedEngine;
}

export function setPreferredEditorEngine(engine: WorkbenchEditorEngine): void {
  cachedEngine = engine;
  try {
    window.localStorage.setItem(ENGINE_STORAGE_KEY, engine);
  } catch {
    // Ignore persistence failures; the in-memory value still applies.
  }
}
