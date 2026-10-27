import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Environment, getInput } from "./action.ts";
import {
  GIT_ENVIRONMENT, GIT_TIMEOUT_MS, MANIFEST_FILE, MAX_CONFIG_BYTES, MAX_GIT_OUTPUT_BYTES, USAGE_URL
} from "./constants.ts";

export function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function assertNoSymlinks(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("working-directory cannot contain symbolic links");
  }
}

export function resolveWorkingDirectory(environment: Environment): string {
  const input = getInput(environment, "working-directory");
  if (!input) throw new Error("working-directory is required");
  if (!environment.GITHUB_WORKSPACE) throw new Error("GITHUB_WORKSPACE is required");
  const workspaceInput = path.resolve(environment.GITHUB_WORKSPACE);
  const workspace = fs.realpathSync(workspaceInput);
  const requested = path.resolve(workspaceInput, input);
  // The workspace may be named through its own symbolic links (macOS's /var) or by its real path; only the part below it is checked.
  const lexicalRoot = isWithin(workspaceInput, requested) ? workspaceInput : workspace;
  const outside = new Error("working-directory must be an existing directory inside GITHUB_WORKSPACE");
  if (!isWithin(lexicalRoot, requested) || !fs.existsSync(requested)) throw outside;
  assertNoSymlinks(lexicalRoot, requested);
  const resolved = fs.realpathSync(requested);
  if (!isWithin(workspace, resolved) || !fs.statSync(resolved).isDirectory()) throw outside;
  return resolved;
}

export function tracksManifest(cwd: string, git: Git = runGit): boolean {
  const listed = git(["ls-files", "-s", "-z", "--", MANIFEST_FILE], { cwd });
  if (listed.status !== 0) throw new Error("could not list the repository's files; check it out before this step");
  const entry = listed.stdout.split("\0").find(item => item.endsWith(`\t${MANIFEST_FILE}`));
  if (!entry) return false;
  const folder = fs.lstatSync(path.join(cwd, path.dirname(MANIFEST_FILE)), { throwIfNoEntry: false });
  const found = fs.lstatSync(path.join(cwd, MANIFEST_FILE), { throwIfNoEntry: false });
  const mode = entry.slice(0, entry.indexOf(" "));
  if (!["100644", "100755"].includes(mode) || !folder?.isDirectory() || !found?.isFile() || found.size > MAX_CONFIG_BYTES) {
    throw new Error(`${MANIFEST_FILE} must be a tracked regular file of at most ${MAX_CONFIG_BYTES} bytes`);
  }
  return true;
}

export function assertManifest(cwd: string): void {
  if (!tracksManifest(cwd)) throw new Error(`add ${MANIFEST_FILE} with exports and publish.to to the repository; see ${USAGE_URL}`);
}

export interface GitResult {
  status: number | null;
  stdout: string;
}

export type Git = (args: readonly string[], options: { cwd: string; env?: Readonly<Record<string, string>> }) => GitResult;

/** Runs git without runner configuration or hooks, so a checkout cannot execute repository-controlled helpers. */
export const runGit: Git = (args, { cwd, env = {} }) => {
  const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    encoding: "utf8",
    env: { ...GIT_ENVIRONMENT, GIT_LFS_SKIP_SMUDGE: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT_BYTES
  });
  return { status: result.status, stdout: result.stdout ?? "" };
};
