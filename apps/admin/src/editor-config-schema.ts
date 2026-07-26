import {
  aiCompletionConfigSchema,
  editorAssociationsSchema,
  keybindingSchema,
  markdownBlockConfigSchema,
  snippetSchema,
  themeGroupConfigSchema
} from "@blog-system/content-core";

const siteConfigSchema = {
  type: "object",
  additionalProperties: false,
  required: ["siteTitle", "enabledPlugins"],
  properties: {
    siteTitle: { type: "string", minLength: 1 },
    siteDescription: { type: "string" },
    backgroundImage: { type: "string" },
    enabledPlugins: {
      type: "array",
      items: { type: "string", minLength: 1 },
      uniqueItems: true
    }
  }
} as const;

export const jsonSchemas = {
  snippetSchema,
  keybindingSchema,
  editorAssociationsSchema,
  markdownBlockConfigSchema,
  siteConfigSchema,
  themeGroupConfigSchema,
  aiCompletionConfigSchema
};
