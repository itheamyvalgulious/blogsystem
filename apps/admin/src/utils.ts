export { hashText } from "@blog-system/content-core";

export function formatBytes(value: number) {
  if (value < 1024) {
    return `${value} B`;
  }

  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KB`;
  }

  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function deriveArticleFileName(title: string) {
  const normalized = title.trim().replace(/\s+/g, "-");
  return normalized.toLowerCase().endsWith(".md") ? normalized : `${normalized}.md`;
}
