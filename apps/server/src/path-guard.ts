import path from "node:path";

/**
 * Separator-aware containment check: true when `child` resolves to `root`
 * itself or to a location beneath it. Unlike a raw `startsWith` on the
 * resolved strings, this cannot be bypassed by a sibling directory whose name
 * shares the root's prefix (e.g. `content-evil` next to `content`).
 */
export function isPathInside(root: string, child: string): boolean {
  const absoluteRoot = path.resolve(root);
  const resolvedChild = path.resolve(child);

  if (resolvedChild === absoluteRoot) {
    return true;
  }

  return resolvedChild.startsWith(absoluteRoot + path.sep);
}
