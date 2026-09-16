// Vite-specific module declarations for this package.
// tsconfig.json does not pull in `vite/client`, so the handful of
// `?raw` / `?worker` imports and vendored ESM entry points are
// declared here locally instead.

declare module "*?raw" {
  const content: string;
  export default content;
}

declare module "*?worker" {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}

// Vendored monaco internal module without bundled types. Consumers cast
// to the concrete shape they need at the import site.
declare module "monaco-editor/esm/vs/editor/common/languages.js" {
  export const TokenizationRegistry: unknown;
}
