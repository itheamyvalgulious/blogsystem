import {
  createThemeAsset as coreCreateThemeAsset,
  createThemeGroup as coreCreateThemeGroup,
  deleteThemeAsset as coreDeleteThemeAsset,
  deleteThemeGroup as coreDeleteThemeGroup,
  getThemeGroupsRoot,
  listEnabledThemeAssets as coreListEnabledThemeAssets,
  listThemeGroups as coreListThemeGroups,
  readThemeAsset as coreReadThemeAsset,
  readThemeGroupConfig as coreReadThemeGroupConfig,
  renameThemeAsset as coreRenameThemeAsset,
  renameThemeGroup as coreRenameThemeGroup,
  saveThemeAsset as coreSaveThemeAsset,
  saveThemeGroupConfig as coreSaveThemeGroupConfig,
  ThemeGroupConfigValidationError
} from "@blog-system/content-core/node";

import { ConfigValidationError } from "./errors.js";

/**
 * The theme group service lives in @blog-system/content-core (shared with the
 * static site generator); this module is the server-side boundary. content-core
 * throws ThemeGroupConfigValidationError for theme.json schema failures, while
 * the admin API historically surfaces these as ConfigValidationError (500 with
 * the validation detail visible to the admin UI), so translate at the boundary.
 */
function withConfigErrorMapping<Args extends unknown[], Result>(
  fn: (...args: Args) => Promise<Result>
): (...args: Args) => Promise<Result> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof ThemeGroupConfigValidationError) {
        throw new ConfigValidationError(error.message);
      }

      throw error;
    }
  };
}

export const createThemeAsset = withConfigErrorMapping(coreCreateThemeAsset);
export const createThemeGroup = withConfigErrorMapping(coreCreateThemeGroup);
export const deleteThemeAsset = withConfigErrorMapping(coreDeleteThemeAsset);
export const deleteThemeGroup = withConfigErrorMapping(coreDeleteThemeGroup);
export const listEnabledThemeAssets = withConfigErrorMapping(coreListEnabledThemeAssets);
export const listThemeGroups = withConfigErrorMapping(coreListThemeGroups);
export const readThemeAsset = withConfigErrorMapping(coreReadThemeAsset);
export const readThemeGroupConfig = withConfigErrorMapping(coreReadThemeGroupConfig);
export const renameThemeAsset = withConfigErrorMapping(coreRenameThemeAsset);
export const renameThemeGroup = withConfigErrorMapping(coreRenameThemeGroup);
export const saveThemeAsset = withConfigErrorMapping(coreSaveThemeAsset);
export const saveThemeGroupConfig = withConfigErrorMapping(coreSaveThemeGroupConfig);

export { getThemeGroupsRoot };
