import { spawn } from "node:child_process";

import { ApiError } from "./errors.js";

export interface GitChangedFile {
  path: string;
  status: string;
}

export interface GitCommitSummary {
  hash: string;
  message: string;
  timestamp: string;
}

function hasNoCommitsMessage(message: string) {
  return /does not have any commits yet|your current branch .* does not have any commits yet/i.test(message);
}

function hasNoUpstreamMessage(message: string) {
  return /no upstream branch|has no upstream branch|set upstream/i.test(message);
}

function runGit(args: string[], cwd: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      shell: false,
      env: { ...process.env, LC_ALL: "C" }
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }

      reject(new Error(stderr || stdout || `git ${args.join(" ")} failed with code ${code}`));
    });
  });
}

async function isGitRepository(repositoryRoot: string) {
  try {
    await runGit(["rev-parse", "--show-toplevel"], repositoryRoot);
    return true;
  } catch {
    return false;
  }
}

export async function getGitStatus(repositoryRoot: string): Promise<GitChangedFile[]> {
  const stdout = await runGit(["status", "--porcelain"], repositoryRoot);

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => ({
      status: line.slice(0, 2).trim(),
      path: line.slice(3)
    }));
}

export async function getGitHistory(repositoryRoot: string): Promise<GitCommitSummary[]> {
  let stdout = "";

  try {
    stdout = await runGit(
      ["log", "--date=iso-strict", "--pretty=format:%H%x09%ad%x09%s"],
      repositoryRoot
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (hasNoCommitsMessage(message)) {
      return [];
    }

    throw error;
  }

  return stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [hash, timestamp, message] = line.split("\t");
      return {
        hash,
        message,
        timestamp
      };
    });
}

export async function createGitCommit(repositoryRoot: string, message: string) {
  await runGit(["add", "-A"], repositoryRoot);
  const status = await getGitStatus(repositoryRoot);

  if (status.length === 0) {
    return { message: "No changes to commit." };
  }

  await runGit(["config", "user.name", "blog-system"], repositoryRoot);
  await runGit(["config", "user.email", "blog-system@example.com"], repositoryRoot);
  await runGit(["commit", "-m", message], repositoryRoot);
  return { message: "Committed changes successfully." };
}

async function getCurrentBranchName(repositoryRoot: string) {
  return (await runGit(["branch", "--show-current"], repositoryRoot)).trim();
}

async function getRemoteNames(repositoryRoot: string) {
  return (await runGit(["remote"], repositoryRoot))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function pushGitChanges(repositoryRoot: string) {
  const commits = await getGitHistory(repositoryRoot);

  if (commits.length === 0) {
    return { message: "No commits to push." };
  }

  try {
    await runGit(["push"], repositoryRoot);
    return { message: "Pushed changes successfully." };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (!hasNoUpstreamMessage(message)) {
      throw error;
    }
  }

  const branchName = await getCurrentBranchName(repositoryRoot);
  if (!branchName) {
    throw new ApiError(400, "Unable to determine the current branch for push.");
  }

  const remoteNames = await getRemoteNames(repositoryRoot);
  if (!remoteNames.includes("origin")) {
    throw new ApiError(400, "No upstream is configured and no origin remote was found.");
  }

  await runGit(["push", "-u", "origin", branchName], repositoryRoot);
  return { message: "Pushed changes successfully." };
}

export async function ensureGitRepository(repositoryRoot: string) {
  if (await isGitRepository(repositoryRoot)) {
    return { initialized: true, message: "Git repository already initialized." };
  }

  await runGit(["init"], repositoryRoot);
  await runGit(["branch", "-M", "main"], repositoryRoot);
  return { initialized: true, message: "Initialized git repository." };
}

export async function getGitOverview(repositoryRoot: string) {
  const initialized = await isGitRepository(repositoryRoot);

  if (!initialized) {
    return {
      commits: [],
      files: [],
      initialized
    };
  }

  return {
    commits: await getGitHistory(repositoryRoot),
    files: await getGitStatus(repositoryRoot),
    initialized
  };
}
