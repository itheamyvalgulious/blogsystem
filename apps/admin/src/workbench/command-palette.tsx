import { useDeferredValue, useEffect, useMemo, type Dispatch, type RefObject, type SetStateAction } from "react";

import type { ThemeGroupsPayload } from "../api";
import { CommandPalette } from "../components/CommandPalette";
import type { PluginRuntime } from "./plugin-runtime";
import { normalizeThemeGroupId } from "./theme-utils";
import type {
  CommandDefinition,
  EditorContributionDefinition,
  ThemeDefinition,
  WorkbenchApi,
  WorkbenchDocument,
  WorkbenchEditorId
} from "./types";

export type CommandPaletteMode = "commands" | "editors" | "themeGroupCreate" | "themes";

interface WorkbenchCommandPaletteProps {
  activeDocument: WorkbenchDocument | null;
  availableCommands: CommandDefinition[];
  availableEditors: EditorContributionDefinition[];
  availableThemes: ThemeDefinition[];
  createThemeGroupDocument: (groupId: string) => Promise<void>;
  mode: CommandPaletteMode;
  onClose: () => void;
  onQueryChange: (query: string) => void;
  onSelectIndex: (index: number) => void;
  open: boolean;
  openThemeGroupConfigDocument: (groupId: string, preferredEditorId?: WorkbenchEditorId) => Promise<void>;
  pluginRuntime: PluginRuntime;
  query: string;
  selectedIndex: number;
  setThemeId: Dispatch<SetStateAction<string>>;
  themeGroupsPayload: ThemeGroupsPayload | null;
  workbenchApiRef: RefObject<WorkbenchApi | null>;
}

export function WorkbenchCommandPalette({
  activeDocument,
  availableCommands,
  availableEditors,
  availableThemes,
  createThemeGroupDocument,
  mode,
  onClose,
  onQueryChange,
  onSelectIndex,
  open,
  openThemeGroupConfigDocument,
  pluginRuntime,
  query,
  selectedIndex,
  setThemeId,
  themeGroupsPayload,
  workbenchApiRef
}: WorkbenchCommandPaletteProps) {
  const deferredCommandQuery = useDeferredValue(query);
  const commandItems = useMemo(() => {
    const normalizedQuery = deferredCommandQuery.trim().toLowerCase();
    const base = availableCommands.map((command) => ({
      id: command.id,
      title: command.title,
      description: command.keywords?.join(", "),
      haystack: `${command.title} ${command.id} ${(command.keywords ?? []).join(" ")}`.toLowerCase()
    }));
    return normalizedQuery ? base.filter((command) => command.haystack.includes(normalizedQuery)) : base;
  }, [availableCommands, deferredCommandQuery]);
  const themeItems = useMemo(() => {
    const normalizedQuery = deferredCommandQuery.trim().toLowerCase();
    const base = availableThemes.map((theme) => ({
      id: theme.id,
      title: theme.label,
      description: theme.appearance === "dark" ? "Dark theme" : "Light theme",
      haystack: `${theme.label} ${theme.id} ${theme.appearance}`.toLowerCase()
    }));
    return normalizedQuery ? base.filter((theme) => theme.haystack.includes(normalizedQuery)) : base;
  }, [availableThemes, deferredCommandQuery]);
  const editorItems = useMemo(() => {
    if (!activeDocument) {
      return [];
    }

    const normalizedQuery = deferredCommandQuery.trim().toLowerCase();
    const base = availableEditors
      .filter((editor) => editor.canHandle(activeDocument))
      .map((editor) => ({
        id: editor.editorId,
        title: editor.label,
        description: editor.editorId === activeDocument.editorId ? "Current editor" : editor.editorId,
        haystack: `${editor.label} ${editor.editorId}`.toLowerCase()
      }));

    return normalizedQuery ? base.filter((item) => item.haystack.includes(normalizedQuery)) : base;
  }, [activeDocument, availableEditors, deferredCommandQuery]);
  const themeGroupCreateItems = useMemo(() => {
    if (mode !== "themeGroupCreate") {
      return [];
    }

    const normalizedGroupId = normalizeThemeGroupId(deferredCommandQuery);
    if (!normalizedGroupId) {
      return [];
    }

    const existing = (themeGroupsPayload?.groups ?? []).some(
      (group) => group.groupId.toLowerCase() === normalizedGroupId.toLowerCase()
    );

    return [
      {
        id: "theme-group:create-input",
        title: `${existing ? "Open" : "Create"} ${normalizedGroupId}`,
        description: `config/theme/${normalizedGroupId}/theme.json`
      }
    ];
  }, [mode, deferredCommandQuery, themeGroupsPayload]);
  const paletteItems =
    mode === "commands"
      ? commandItems
      : mode === "themes"
        ? themeItems
        : mode === "editors"
          ? editorItems
        : themeGroupCreateItems;

  useEffect(() => {
    if (selectedIndex >= paletteItems.length) {
      onSelectIndex(Math.max(0, paletteItems.length - 1));
    }
  }, [paletteItems.length, selectedIndex]);

  return (
    <CommandPalette
      emptyMessage={
        mode === "themeGroupCreate"
          ? "Type a theme group id such as atlas-notes or sketch/blueprint."
          : undefined
      }
      open={open}
      onSubmitQuery={() => {
        if (mode !== "themeGroupCreate") {
          return;
        }

        const normalizedGroupId = normalizeThemeGroupId(query);
        if (!normalizedGroupId) {
          return;
        }

        onClose();
        if ((themeGroupsPayload?.groups ?? []).some((group) => group.groupId === normalizedGroupId)) {
          void openThemeGroupConfigDocument(normalizedGroupId);
          return;
        }

        void createThemeGroupDocument(normalizedGroupId);
      }}
      title={
        mode === "commands"
          ? "Command Palette"
          : mode === "themes"
            ? "Choose Theme"
            : mode === "editors"
              ? "Reopen With Editor"
              : "Create Theme Group"
      }
      placeholder={
        mode === "commands"
          ? "Type a command"
          : mode === "themes"
            ? "Type a theme"
            : mode === "editors"
              ? "Type an editor"
              : "Type a theme group id"
      }
      query={query}
      selectedIndex={selectedIndex}
      items={paletteItems}
      onQueryChange={onQueryChange}
      onClose={onClose}
      onSelectIndex={onSelectIndex}
      onExecute={(id) => {
        if (mode === "themes") {
          setThemeId(id);
          onClose();
          return;
        }
        if (mode === "themeGroupCreate") {
          onClose();
          const normalizedGroupId = normalizeThemeGroupId(query);
          if (!normalizedGroupId) {
            return;
          }

          if ((themeGroupsPayload?.groups ?? []).some((group) => group.groupId === normalizedGroupId)) {
            void openThemeGroupConfigDocument(normalizedGroupId);
            return;
          }

          void createThemeGroupDocument(normalizedGroupId);
          return;
        }
        if (mode === "editors") {
          onClose();
          workbenchApiRef.current?.reopenActiveDocumentWithEditor(id);
          return;
        }
        const command = pluginRuntime.getCommand(id);
        if (!command || !workbenchApiRef.current) {
          return;
        }
        onClose();
        void command.handler(workbenchApiRef.current);
      }}
    />
  );
}
