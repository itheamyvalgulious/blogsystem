import { cpSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * quiver 静态应用的唯一权威副本在 packages/commutative/vendor/quiver/。
 * admin 需要以 /quiver/* 的 URL 提供它（iframe 编辑器），vite 只会原样拷贝
 * publicDir，所以在 dev/build 前把权威副本同步到 apps/admin/public/quiver/。
 * 目标目录是生成物，已在 .gitignore 中忽略。
 */
const projectRoot = path.resolve(import.meta.dirname, "..");
const source = path.join(projectRoot, "packages", "commutative", "vendor", "quiver");
const target = path.join(projectRoot, "apps", "admin", "public", "quiver");

rmSync(target, { recursive: true, force: true });
cpSync(source, target, { recursive: true });
console.log(`Synced quiver assets → ${path.relative(projectRoot, target)}/`);
