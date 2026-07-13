import { promises as fs } from "node:fs";

/**
 * True iff the target exists. ENOENT resolves to false; any other fs error
 * (permissions, I/O) re-throws so a broken path is not silently treated as
 * "absent".
 */
export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

/** Throw a descriptive error if the target does not exist. */
export async function assertPathExists(absolutePath: string): Promise<void> {
  try {
    await fs.access(absolutePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Target path does not exist.");
    }

    throw error;
  }
}

/** Throw a descriptive error if the target already exists. */
export async function assertTargetAvailable(absolutePath: string): Promise<void> {
  try {
    await fs.access(absolutePath);
    throw new Error("Target path already exists.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }
}
