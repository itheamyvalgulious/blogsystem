/**
 * Shared HTML-escaping helper for the site generator/publisher. Escapes the
 * five significant HTML characters so admin-authored strings (titles, excerpts,
 * paths) can be interpolated into generated markup safely.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
