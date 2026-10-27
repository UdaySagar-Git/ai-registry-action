import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type Environment, getBooleanInput, getInput, maskSecret, messageOf, type Repository, setOutput, writeStepSummary
} from "./action.ts";
import {
  type AiregReason, AiregRefusal, type Changes, dryRunResult, type Execute, type PublishResult, type Registry, runAireg,
  runAiregPublish
} from "./aireg.ts";
import { BASE_CHECKOUT_PREFIX, COMMIT_SHA, GITHUB_SERVER, PREVIEW_MARKER } from "./constants.ts";
import {
  githubRequest, type GitHubRequest, parsePullRequestContext, type PullRequestContext, upsertMarkerComment
} from "./github.ts";
import { type Install, installCli } from "./install.ts";
import {
  conflictsOf, formatPreviewComment, formatPreviewSummary, overwritesOf, type Preview, setPublishOutputs
} from "./report.ts";
import { fetchEnvironment, suppliedTokens, unchangedRegistryTokens } from "./tokens.ts";
import {
  assertManifest, assertNoSymlinks, type Git, isWithin, resolveWorkingDirectory, runGit, tracksManifest
} from "./workspace.ts";

export interface PreviewOptions {
  environment: Environment;
  payload: unknown;
  request?: GitHubRequest;
  install?: Install;
  execute?: Execute;
  checkout?: Checkout;
}

type PreviewRun = Partial<Pick<Preview,
  "version" | "withheld" | "nonDefaultBase" | "baseError" | "baseManifest" | "registryChanges" | "result" | "baseResult" | "baseFailure"
>> & { credentialed?: boolean; failure?: unknown };

export function registryChanges(head: readonly Registry[], base: readonly Registry[]): Changes {
  const declarations = (list: readonly Registry[]) => new Map(list.map(entry => [entry.registry, entry.declaration]));
  const after = declarations(head);
  const before = declarations(base);
  return {
    added: [...after.keys()].filter(name => !before.has(name)),
    removed: [...before.keys()].filter(name => !after.has(name)),
    changed: [...after.keys()].filter(name => before.has(name) && before.get(name) !== after.get(name))
  };
}

// Only a default-branch base vouches for tokens: anyone who can push could otherwise target a branch they repointed.
// An aireg refusal is a preview result, not an error.
async function previewDryRun(
  { environment, install, execute, checkout }: Required<Pick<PreviewOptions, "environment" | "install" | "execute" | "checkout">>,
  { owner, repo, baseSha, baseRef, defaultBranch, intoDefaultBranch }: PullRequestContext, token: string
): Promise<PreviewRun> {
  const supplied = suppliedTokens(environment);
  const cwd = resolveWorkingDirectory(environment);
  assertManifest(cwd);
  let base: BaseCheckout | { error: string };
  try {
    base = await checkout({ cwd, sha: baseSha, repository: { owner, repo }, environment, token });
  } catch (error) {
    base = { error: messageOf(error, "the base commit could not be read") };
  }
  try {
    const baseCheckout = "error" in base ? undefined : base;
    const installed = await install({ environment, cwd, ...(baseCheckout?.tracksManifest ? { baseCwd: baseCheckout.cwd } : {}) });
    try {
      const { version, registries } = installed;
      const baseError = "error" in base ? base.error : installed.base && "error" in installed.base ? installed.base.error : undefined;
      const baseRegistries = baseError ? undefined : installed.base && "registries" in installed.base ? installed.base.registries : [];
      const { tokens, withheld } = unchangedRegistryTokens(supplied, registries, intoDefaultBranch ? baseRegistries : undefined);
      const run: PreviewRun = {
        version,
        credentialed: Object.keys(tokens).length > 0,
        withheld,
        ...(intoDefaultBranch ? {} : { nonDefaultBase: { ...(baseRef ? { ref: baseRef } : {}), ...(defaultBranch ? { defaultBranch } : {}) } }),
        ...(baseRegistries ? { baseManifest: baseCheckout?.tracksManifest ?? false, registryChanges: registryChanges(registries, baseRegistries) } : { baseError })
      };
      const dryRun = async (at: string) => dryRunResult(await runAiregPublish({
        binary: installed.binary, runtimeDirectory: installed.directory, cwd: at, environment, tokens, dryRun: true, execute
      }));
      let result: PublishResult;
      try {
        result = await dryRun(cwd);
      } catch (error) {
        if (!(error instanceof AiregRefusal)) throw error;
        return { ...run, failure: error };
      }
      if (!baseCheckout?.tracksManifest || baseError) return { ...run, result };
      try {
        return { ...run, result, baseResult: await dryRun(baseCheckout.cwd) };
      } catch (error) {
        return { ...run, result, baseFailure: error instanceof AiregRefusal ? error.reason.message : messageOf(error, "the base commit's dry run failed") };
      }
    } finally {
      await fsp.rm(installed.directory, { recursive: true, force: true });
    }
  } finally {
    if (!("error" in base)) await base.remove();
  }
}

export async function runPreview({
  environment, payload, request = githubRequest, install = installCli, execute = runAireg, checkout = checkoutBase
}: PreviewOptions): Promise<void> {
  const token = getInput(environment, "github-token");
  const commenting = getBooleanInput(environment, "comment-on-pr");
  const failOnConflict = getBooleanInput(environment, "fail-on-conflict");
  const context = parsePullRequestContext(environment, payload);
  const shouldComment = commenting && !context.crossRepository;
  if (shouldComment && (!token || /[\r\n]/.test(token))) throw new Error("github-token is required to comment on the pull request");
  if (token) maskSecret(token);
  let run: PreviewRun;
  try {
    run = await previewDryRun({ environment, install, execute, checkout }, context, token);
  } catch (error) {
    run = { failure: error };
  }
  const { credentialed, failure, ...fields } = run;
  const reason: AiregReason | undefined = failure === undefined ? undefined
    : failure instanceof AiregRefusal ? failure.reason : { message: messageOf(failure, "the preview failed") };
  const compared = run.result && run.baseResult ? { head: run.result, base: run.baseResult } : undefined;
  const conflicts = compared ? conflictsOf(compared.head, compared.base) : [];
  const overwrites = compared ? overwritesOf(compared.head, compared.base) : [];
  const withheld = run.withheld ?? [];
  const unauthorized = reason?.code === "unauthorized" && (credentialed === false || withheld.length > 0);
  const handoff = context.crossRepository || !context.headRef ? undefined
    : { repository: `${context.owner}/${context.repo}`, pullNumber: context.pullNumber, branch: context.headRef };
  const preview: Preview = { ...fields, withheld, unauthorized, ...(reason ? { reason } : {}), conflicts, overwrites, failOnConflict, ...(handoff ? { handoff } : {}) };
  writeStepSummary(environment, formatPreviewSummary(preview, environment));
  if (shouldComment) {
    const written = await upsertMarkerComment({
      token, request, owner: context.owner, repo: context.repo, issueNumber: context.pullNumber, marker: PREVIEW_MARKER,
      body: formatPreviewComment(preview, environment)
    });
    setOutput(environment, "comment-id", written.id);
  }
  setPublishOutputs(environment, run.result);
  setOutput(environment, "conflict-count", conflicts.length);
  const failed = failure !== undefined && !unauthorized;
  setOutput(environment, "status", failed ? "failed" : conflicts.length > 0 ? "conflict" : "success");
  if (run.version) setOutput(environment, "aireg-version", run.version);
  if (failed) throw failure;
  if (conflicts.length > 0 && failOnConflict) {
    const changes = conflicts.length === 1 ? "1 artifact this pull request changes was" : `${conflicts.length} artifacts this pull request changes were`;
    throw new Error(`${changes} changed in the registry since its base; see the preview, or set fail-on-conflict to false`);
  }
}

export interface BaseCheckout {
  cwd: string;
  tracksManifest: boolean;
  remove: () => Promise<void>;
}

interface CheckoutOptions {
  cwd: string;
  sha: string | undefined;
  repository: Repository;
  environment: Environment;
  token: string;
  git?: Git;
}

export type Checkout = (options: CheckoutOptions) => Promise<BaseCheckout>;

// Authentication goes in git's environment, scoped to the GitHub origin, because arguments are visible to other processes.
function fetchCommit({ cwd, sha, repository, environment, token, git }: CheckoutOptions & { sha: string; git: Git }): void {
  let auth: Record<string, string> = {};
  if (token) {
    const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    maskSecret(header);
    auth = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `http.${GITHUB_SERVER}/.extraheader`, GIT_CONFIG_VALUE_0: header };
  }
  const shallow = git(["rev-parse", "--is-shallow-repository"], { cwd }).stdout.trim() === "true";
  const fetched = git([
    "-c", "protocol.version=2", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "--no-write-fetch-head",
    ...(shallow ? ["--depth=1"] : []), `${GITHUB_SERVER}/${repository.owner}/${repository.repo}`, sha
  ], { cwd, env: { ...fetchEnvironment(environment), ...auth } });
  if (fetched.status !== 0) throw new Error("could not fetch the pull request's base commit");
}

export const checkoutBase: Checkout = async ({ cwd, sha, repository, environment, token, git = runGit }) => {
  if (typeof sha !== "string" || !COMMIT_SHA.test(sha)) throw new Error("the pull request names no base commit");
  const top = git(["rev-parse", "--show-toplevel"], { cwd });
  if (top.status !== 0) throw new Error("could not find the repository of the working directory");
  const root = fs.realpathSync(top.stdout.trim());
  if (!isWithin(root, cwd)) throw new Error("the working directory is outside its repository");
  const hasCommit = () => git(["cat-file", "-e", `${sha}^{commit}`], { cwd }).status === 0;
  if (!hasCommit()) {
    fetchCommit({ cwd, sha, repository, environment, token, git });
    if (!hasCommit()) throw new Error("could not fetch the pull request's base commit");
  }
  const directory = await fsp.realpath(await fsp.mkdtemp(path.join(os.tmpdir(), BASE_CHECKOUT_PREFIX)));
  const worktree = path.join(directory, "base");
  const remove = async () => {
    git(["worktree", "remove", "--force", worktree], { cwd });
    await fsp.rm(directory, { recursive: true, force: true });
    git(["worktree", "prune"], { cwd });
  };
  try {
    const added = git(["-c", "advice.detachedHead=false", "worktree", "add", "--detach", "--quiet", worktree, sha], { cwd });
    if (added.status !== 0) throw new Error("could not check out the pull request's base commit");
    const baseCwd = path.join(worktree, path.relative(root, cwd));
    const folder = fs.lstatSync(baseCwd, { throwIfNoEntry: false });
    if (!folder) return { cwd: baseCwd, tracksManifest: false, remove };
    assertNoSymlinks(worktree, baseCwd);
    return { cwd: baseCwd, tracksManifest: folder.isDirectory() && tracksManifest(baseCwd, git), remove };
  } catch (error) {
    await remove();
    throw error;
  }
};
