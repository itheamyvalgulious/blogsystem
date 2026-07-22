import type { PaneContributionDefinition, PaneGroupId } from "./types";

export interface SidebarPaneItem {
  kind: "core" | "plugin";
  paneId: string;
  tabLabel: string;
  title: string;
  component?: PaneContributionDefinition["component"];
}

export interface SidebarModuleItem {
  icon: string;
  id: PaneGroupId;
  order?: number;
  title: string;
}

export const CORE_MODULES = [
  {
    id: "explorer",
    icon: "explorer",
    order: 0,
    title: "Explorer"
  },
  {
    id: "outline",
    icon: "outline",
    order: 10,
    title: "Outline"
  },
  {
    id: "edit",
    icon: "edit",
    order: 20,
    title: "Edit"
  },
  {
    id: "plugins",
    icon: "plugins",
    order: 30,
    title: "Plugins"
  }
] as const satisfies SidebarModuleItem[];
