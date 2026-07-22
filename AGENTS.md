# blog-system

npm workspaces monorepo（TypeScript, ESM）。包管理器只用 npm（pnpm 已移除）。

## 结构

- `packages/commutative` — tikzcd/quiver 交换图解析与渲染库（叶子包，不依赖其他 workspace 包）。
- `packages/content-core` — 共享内核：markdown 管线、内容模型、主题组服务、通用工具（`escapeHtmlAttribute`/`hashText`/`getErrorMessage`/`isPathInside`）。双入口：`index`（浏览器安全）与 `node`（含 fs 的服务端能力）。跨应用共享逻辑一律放这里，禁止跨应用 import 另一应用的 `src`。
- `apps/server` — Express 5 API。`src/app.ts` 只做装配；路由在 `src/routes/`（按资源一文件，显式依赖注入）；业务在 `src/*-service.ts`；错误体系在 `src/errors.ts`（`ApiError` 带 status，未知错误一律 500 通用文案，详情只进服务端日志）；路径包含判断用 `src/path-guard.ts` 的 `isPathInside`（分隔符感知）。
- `apps/admin` — React + Vite 编辑器。`src/App.tsx` 只是组合壳；状态逻辑在 `src/workbench/hooks/`（一簇一 hook）；UI 区块在 `src/workbench/*.tsx`、`panes/`、`editors/`；编辑器插件在 `src/workbench/plugins/`（经 `WorkbenchApi` facade 通信，插件不得反向 import App 内部）；纯函数在 `workbench/document-builders.ts`、`tree-utils.ts` 等模块。
- `apps/site` — 静态站生成器。三层：`generator.ts`（主体管线）、`src/plugins/`（静态站插件，一插件一文件，`plugins/index.ts` 注册表）、`src/themes/`（主题）。插件不 import 主题内部，主题不 import 插件内部。生成给浏览器的脚本必须用 DOM API/textContent 构造内容，禁止未转义拼 `innerHTML`。
- `apps/desktop` — Electron 壳（main + preload）。启动时随机生成凭据注入内嵌 server，经 `window.desktopAuth` 暴露给登录页。

## 常用命令

- `npm run build` — 全量构建（site 的 cli-build 依赖 `config.json` 指向的 workspace；新机器先 `npm run init-workspace`）。
- `npm test` — 先构建两个共享包再跑全部测试（node:test + tsx）。
- `npm run typecheck` — 全仓 `tsc --noEmit`（提交前必须通过）。
- `npm run lint` — eslint flat config（0 error 为门槛，warning 容忍）。

## 约定

- 测试脚本 glob 必须加引号：`tsx --test "src/**/*.test.ts"`（POSIX sh 会错误展开 `**`）。
- 禁止 `@ts-ignore`/`@ts-nocheck`；vendored/第三方模块用 ambient d.ts 声明。
- catch 变量取文案用 `getErrorMessage(error)`（content-core），不要 `(error as Error).message`。
- 凭据无默认值：`ADMIN_PASSWORD`/`SESSION_SECRET` 未设置时启动期随机生成并打印一次；`HOST` 非 loopback 且未显式设凭据会打印安全警告。
- git 子进程固定 `LC_ALL=C`（输出按英文匹配）。
- quiver 静态应用的权威副本只有一份：`packages/commutative/vendor/quiver/`；`apps/admin/public/quiver/` 是由 `scripts/sync-quiver.mjs`（admin 的 predev/prebuild 钩子）生成的拷贝，已 gitignore，升级 quiver 只改 vendor 那份。
