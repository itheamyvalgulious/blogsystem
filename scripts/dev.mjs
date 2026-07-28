import { spawn } from "node:child_process";
import process from "node:process";

// Load machine-local .env (gitignored) so BLOG_SYSTEM_WORKSPACE and other
// settings are available without exporting env vars manually.
try { process.loadEnvFile(); } catch { /* no .env — use env/defaults */ }

// Dev-only defaults: bind all interfaces so the workbench is reachable from
// other machines on the LAN (remote development). Explicit env always wins;
// production defaults (loopback) in apps/server/src/config.ts are untouched.
process.env.HOST ??= "0.0.0.0";
process.env.BLOG_SYSTEM_ADMIN_HOST ??= "0.0.0.0";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const projectRoot = process.cwd();
const colorMap = {
  server: "\u001b[36m",
  admin: "\u001b[32m",
  site: "\u001b[35m",
  reset: "\u001b[0m"
};

const services = [
  {
    name: "server",
    args: ["--prefix", "apps/server", "run", "dev"]
  },
  {
    name: "admin",
    args: ["--prefix", "apps/admin", "run", "dev"]  
  },
  {
    name: "site",
    args: ["--prefix", "apps/site", "run", "dev"]
  }
];

const children = services.map((service) => {
  const child = spawn([npmCommand, ...service.args].join(" "), {
    cwd: projectRoot,
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
    shell: true
  });

  const prefix = `${colorMap[service.name]}[${service.name}]${colorMap.reset}`;
  const pipeOutput = (stream, target) => {
    let buffer = "";
    stream.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        target.write(`${prefix} ${line}\n`);
      }
    });
    stream.on("end", () => {
      if (buffer) {
        target.write(`${prefix} ${buffer}\n`);
      }
    });
  };

  pipeOutput(child.stdout, process.stdout);
  pipeOutput(child.stderr, process.stderr);

  return {
    ...service,
    child
  };
});

let shuttingDown = false;

function shutdown(exitCode = 0) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  for (const service of children) {
    if (!service.child.killed) {
      service.child.kill("SIGTERM");
    }
  }

  setTimeout(() => {
    for (const service of children) {
      if (!service.child.killed) {
        service.child.kill("SIGKILL");
      }
    }
    process.exit(exitCode);
  }, 800).unref();
}

for (const service of children) {
  service.child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }

    if (code && code !== 0) {
      console.error(`[${service.name}] exited with code ${code}`);
      shutdown(code);
      return;
    }

    if (signal) {
      console.error(`[${service.name}] exited with signal ${signal}`);
      shutdown(1);
    }
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
