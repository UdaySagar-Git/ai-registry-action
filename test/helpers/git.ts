import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const GIT_ENVIRONMENT = { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };

/** Runs git with no user, system or hook configuration, so tests behave the same on every machine. */
export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", [
    "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "init.defaultBranch=main",
    "-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.com", ...args
  ], { cwd, env: GIT_ENVIRONMENT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
}
