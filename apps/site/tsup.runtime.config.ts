import { cp } from "node:fs/promises";

import { defineConfig } from "tsup";

export default defineConfig({
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
  },
  clean: true,
  entry: [
    "src/generator.ts",
    "src/publisher.ts",
    "src/publish-config.ts",
    "src/publish-targets/index.ts",
    "src/publish-targets/github.ts",
    "src/publish-targets/cloudflare.ts",
    "src/publish-targets/types.ts"
  ],
  format: ["esm"],
  noExternal: ["@blog-system/content-core", "@blog-system/commutative", "@noble/hashes", "undici"],
  // src/assets/protected-content-runtime.js is read at runtime via
  // new URL("./assets/protected-content-runtime.js", import.meta.url), so it must
  // exist under runtime-dist/assets/. tsup's publicDir would flatten the files
  // into runtime-dist/, so copy the directory after the build instead.
  onSuccess: async () => {
    await cp("src/assets", "runtime-dist/assets", { recursive: true });
  },
  outDir: "runtime-dist",
  platform: "node",
  target: "node22"
});
