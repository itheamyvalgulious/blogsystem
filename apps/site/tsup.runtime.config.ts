import { defineConfig } from "tsup";

export default defineConfig({
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
  noExternal: ["@blog-system/content-core", "@blog-system/commutative", "@noble/hashes"],
  // src/assets/protected-content-runtime.js is read at runtime via
  // new URL("./assets/protected-content-runtime.js", import.meta.url), so it must
  // exist under runtime-dist/assets/. tsup's publicDir would flatten the files
  // into runtime-dist/, so copy the directory after the build instead.
  onSuccess:
    "node -e \"require('node:fs').cpSync('src/assets', 'runtime-dist/assets', { recursive: true })\"",
  outDir: "runtime-dist",
  platform: "node",
  target: "node22"
});
