import { execSync } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const STANDARD_DIRS = [
  "assets",
  "config",
  "config/editor",
  "content",
  "projects"
];

function parseArgs(argv) {
  const args = { url: null, path: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--url" && argv[i + 1]) {
      args.url = argv[++i];
    } else if (argv[i] === "--path" && argv[i + 1]) {
      args.path = argv[++i];
    }
  }
  return args;
}

const projectRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));

// Default: a sibling "blog-workspace" next to the code repo — keeps all
// machine-local data out of the code repository.
const workspacePath = args.path ?? "../blog-workspace";
const workspaceRoot = path.resolve(projectRoot, workspacePath);

if (args.url) {
  if (existsSync(workspaceRoot)) {
    console.error(`Workspace directory already exists: ${workspaceRoot}`);
    process.exit(1);
  }
  console.log(`Cloning ${args.url} into ${workspaceRoot}...`);
  execSync(`git clone ${JSON.stringify(args.url)} ${JSON.stringify(workspaceRoot)}`, {
    stdio: "inherit"
  });
} else {
  mkdirSync(workspaceRoot, { recursive: true });
}

for (const dir of STANDARD_DIRS) {
  const full = path.join(workspaceRoot, dir);
  if (!existsSync(full)) {
    mkdirSync(full, { recursive: true });
    console.log(`  created ${dir}/`);
  } else {
    console.log(`  exists  ${dir}/`);
  }
}

console.log(`\nWorkspace ready at ${workspaceRoot}`);
console.log(`The code repo resolves it automatically (sibling "blog-workspace" convention).`);
console.log(`To override: set BLOG_SYSTEM_WORKSPACE env or use --path.`);
