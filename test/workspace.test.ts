import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it, type TestContext } from "node:test";
import { MAX_CONFIG_BYTES } from "../src/constants.ts";
import { assertManifest, isWithin, resolveWorkingDirectory, runGit, tracksManifest } from "../src/workspace.ts";
import { temporaryDirectory } from "./helpers/action.ts";
import { MANIFEST, manifestCheckout } from "./helpers/fixtures.ts";
import { git, writeFiles } from "./helpers/git.ts";

const OUTSIDE = /^Error: working-directory must be an existing directory inside GITHUB_WORKSPACE$/;

describe("isWithin", () => {
  for (const [candidate, expected] of [
    ["/workspace", true],
    ["/workspace/skills", true],
    ["/workspace/..skills", true],
    ["/workspace-other/skills", false],
    ["/workspace/../tmp", false],
    ["/tmp/skills", false]
  ] as const) {
    it(`${expected ? "accepts" : "rejects"} ${candidate}`, () => assert.equal(isWithin("/workspace", candidate), expected));
  }
});

describe("resolveWorkingDirectory", () => {
  async function workspace(t: TestContext) {
    const root = await temporaryDirectory(t);
    const checkout = path.join(root, "workspace");
    await mkdir(path.join(checkout, "skills", "nested"), { recursive: true });
    await writeFile(path.join(checkout, "README.md"), "synthetic\n");
    await mkdir(path.join(root, "outside"));
    return { root, checkout };
  }
  const resolve = (checkout: string, input: string) => resolveWorkingDirectory({ GITHUB_WORKSPACE: checkout, "INPUT_WORKING-DIRECTORY": input });

  it("resolves the default and nested directories inside the workspace to their real paths", async t => {
    const { checkout } = await workspace(t);
    assert.equal(resolve(checkout, "."), checkout);
    assert.equal(resolve(checkout, "skills/nested"), path.join(checkout, "skills", "nested"));
    assert.equal(resolve(checkout, path.join(checkout, "skills")), path.join(checkout, "skills"));
  });

  for (const [name, input] of [
    ["a parent escape", "../outside"],
    ["an escape through a subdirectory", "skills/../../outside"],
    ["an absolute path outside", "/"],
    ["a missing directory", "missing"],
    ["a file", "README.md"]
  ] as const) {
    it(`refuses ${name}`, async t => {
      const { checkout } = await workspace(t);
      assert.throws(() => resolve(checkout, input), OUTSIDE);
    });
  }

  it("refuses a symbolic link inside the workspace, even to a directory inside it", async t => {
    const { root, checkout } = await workspace(t);
    await symlink("skills", path.join(checkout, "inside"));
    await symlink(path.join(root, "outside"), path.join(checkout, "escape"));
    for (const input of ["inside", "escape", "inside/nested"]) {
      assert.throws(() => resolve(checkout, input), /cannot contain symbolic links/);
    }
  });

  it("accepts a workspace that is itself reached through a symbolic link", async t => {
    const { root, checkout } = await workspace(t);
    const linked = path.join(root, "linked-workspace");
    await symlink(checkout, linked);
    assert.equal(resolve(linked, "skills"), path.join(checkout, "skills"));
    assert.equal(resolve(linked, path.join(checkout, "skills")), path.join(checkout, "skills"));
  });

  it("requires the input and the workspace", async t => {
    const { checkout } = await workspace(t);
    assert.throws(() => resolve(checkout, ""), /^Error: working-directory is required$/);
    assert.throws(() => resolveWorkingDirectory({ "INPUT_WORKING-DIRECTORY": "." }), /^Error: GITHUB_WORKSPACE is required$/);
  });
});

describe("tracksManifest", () => {
  const MANIFEST_PATH = [".registry", "manifest.yml"];

  it("accepts a tracked regular manifest", async t => {
    assert.equal(tracksManifest(await manifestCheckout(t)), true);
  });

  it("treats a manifest git does not track as absent", async t => {
    const workspace = await manifestCheckout(t, null);
    assert.equal(tracksManifest(workspace), false);
    await writeFile(path.join(workspace, ...MANIFEST_PATH), MANIFEST);
    assert.equal(tracksManifest(workspace), false);
  });

  it("refuses a tracked symbolic link", async t => {
    const workspace = await manifestCheckout(t, null);
    await writeFile(path.join(workspace, "elsewhere.yml"), MANIFEST);
    await symlink("../elsewhere.yml", path.join(workspace, ...MANIFEST_PATH));
    git(workspace, "add", "-A");
    assert.throws(() => tracksManifest(workspace), new RegExp(`must be a tracked regular file of at most ${MAX_CONFIG_BYTES} bytes`));
  });

  it("refuses a tracked manifest over the size limit", async t => {
    const workspace = await manifestCheckout(t);
    await truncate(path.join(workspace, ...MANIFEST_PATH), MAX_CONFIG_BYTES + 1);
    assert.throws(() => tracksManifest(workspace), /must be a tracked regular file/);
  });

  it("refuses a tracked manifest whose folder was replaced by a symbolic link", async t => {
    const workspace = await manifestCheckout(t);
    await rm(path.join(workspace, ".registry"), { recursive: true });
    await mkdir(path.join(workspace, "real", ".registry"), { recursive: true });
    await writeFile(path.join(workspace, "real", ...MANIFEST_PATH), MANIFEST);
    await symlink(path.join("real", ".registry"), path.join(workspace, ".registry"));
    assert.throws(() => tracksManifest(workspace), /must be a tracked regular file/);
  });

  it("fails outside a repository", async t => {
    const directory = await temporaryDirectory(t);
    assert.throws(() => tracksManifest(directory), /could not list the repository's files; check it out before this step/);
  });

  it("names the usage guide when the manifest is missing", async t => {
    const workspace = await manifestCheckout(t, null);
    assert.throws(() => assertManifest(workspace),
      /^Error: add \.registry\/manifest\.yml with exports and publish\.to to the repository; see https:\/\/github\.com\/atlanai\/ai-registry-action#quick-start$/);
  });
});

async function repositoryWithHook(t: TestContext) {
  const root = await temporaryDirectory(t, "aireg-publish-git-");
  await writeFiles(root, { "README.md": "x\n" });
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
  const marker = path.join(root, "hook-ran");
  const hook = path.join(root, ".git", "hooks", "post-checkout");
  await writeFile(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  await chmod(hook, 0o755);
  return { root, marker };
}

describe("runGit", () => {
  it("does not run the repository's hooks", async t => {
    const { root, marker } = await repositoryWithHook(t);
    const worktree = path.join(await temporaryDirectory(t), "wt");
    assert.equal(runGit(["worktree", "add", "--detach", "--quiet", worktree, "HEAD"], { cwd: root }).status, 0);
    assert.equal(existsSync(path.join(worktree, "README.md")), true);
    assert.equal(existsSync(marker), false);
    // The same checkout through plain git runs the hook, so the assertion above is meaningful.
    execFileSync("git", ["worktree", "add", "--detach", "--quiet", path.join(path.dirname(worktree), "control"), "HEAD"], {
      cwd: root, env: { PATH: "/usr/bin:/bin", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" }, stdio: "ignore"
    });
    assert.equal(existsSync(marker), true);
  });

  it("reads no global configuration, even when the runner's environment names one", async t => {
    const root = await temporaryDirectory(t);
    const global = path.join(root, "gitconfig");
    await writeFile(global, "[user]\n\tname = Caller\n");
    git(root, "init", "-q");
    const previous = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = global;
    t.after(() => {
      if (previous === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previous;
    });
    const result = runGit(["config", "--get", "user.name"], { cwd: root });
    assert.deepEqual(result, { status: 1, stdout: "" });
  });

  it("returns git's exit status and standard output", async t => {
    const root = await temporaryDirectory(t);
    git(root, "init", "-q");
    assert.deepEqual(runGit(["rev-parse", "--is-inside-work-tree"], { cwd: root }), { status: 0, stdout: "true\n" });
    assert.equal(runGit(["rev-parse", "--is-inside-work-tree"], { cwd: path.dirname(root) }).status, 128);
  });

  it("passes the caller's extra environment to git", async t => {
    const root = await temporaryDirectory(t);
    git(root, "init", "-q");
    const configured = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Synthetic" };
    assert.deepEqual(runGit(["config", "--get", "user.name"], { cwd: root, env: configured }), { status: 0, stdout: "Synthetic\n" });
  });
});
