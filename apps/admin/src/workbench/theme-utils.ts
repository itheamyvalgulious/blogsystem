/**
 * Normalise a theme-group id from free-form input (rename dialog, command
 * palette, etc.) into a canonical slash-joined, lower-case, `[a-z0-9_-]` form.
 * Returns null for empty input so callers can distinguish "no id" from a
 * valid one.
 */
export function normalizeThemeGroupId(value: string) {
  const trimmed = value.trim().replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/{2,}/g, "/");

  if (!trimmed) {
    return null;
  }

  return trimmed
    .split("/")
    .map((segment) =>
      segment
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
    )
    .filter(Boolean)
    .join("/");
}
