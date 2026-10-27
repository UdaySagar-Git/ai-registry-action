import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { TestContext } from "node:test";
import { AiregRefusal, type Artifact, type PublishResult, type Skip, type Target } from "../../src/aireg.ts";
import { actionDefaults, temporaryDirectory } from "./action.ts";
import { git, writeFiles } from "./git.ts";

export const MANIFEST = "registries:\n  acme: { source: https://registry.example.com, adapter: acme }\nexports:\n  - skills/*\npublish:\n  to: acme/engineering\n";
export const TARGET: Target = { registry: "acme", namespace: "engineering" };
const SKILL = { "skills/review/SKILL.md": "---\nname: review\ndescription: Reviews a change.\n---\nBody.\n" };

export function exported(name: string, from: string | null, version: string, extra: Partial<Artifact> = {}): Artifact {
  return { name, kind: "skill", registry: "acme", namespace: "engineering", from, version, published: from !== version, dependsOn: [], ...extra };
}

export function publishAnswer(
  artifacts: unknown[], { dryRun = false, skipped = [], target = TARGET }: { dryRun?: boolean; skipped?: Skip[]; target?: unknown } = {}
): string {
  return JSON.stringify({ ok: true, data: { dryRun, target, artifacts, skipped } });
}

export function registryList(registries: unknown[]): string {
  return JSON.stringify({ ok: true, data: { scope: "project", registries } });
}

export function refusal(code: string, message: string, hint: string): AiregRefusal {
  return new AiregRefusal(`aireg publish exited with status 1: ${message} Hint: ${hint}`, { code, message, hint });
}

export const PLANNER: Skip = { name: "planner", kind: "agent", path: "agents/planner", reason: "the acme adapter does not publish agents" };
export const EXPORTS: Artifact[] = [
  exported("review", "0.3.1", "0.3.2", { dependsOn: [{ to: "engineering/skill/sql-style@1.2.0" }] }),
  exported("sql-style", "1.2.0", "1.2.0"),
  exported("triage", null, "0.1.0", { kind: "agent", dependsOn: [{ to: "engineering/skill/review@0.3.2" }, { to: "engineering/skill/sql-style@1.2.0" }] })
];

interface PullRequestFields {
  baseSha?: string;
  baseRef?: string;
  defaultBranch?: string;
  /** null stands for a deleted fork. */
  headRepository?: string | null;
  headRef?: string;
}

/** A field set to undefined is left out of the payload. */
export function pullRequestPayload(fields: PullRequestFields = {}) {
  const { baseSha, baseRef, defaultBranch, headRepository, headRef } = { baseRef: "main", defaultBranch: "main", headRepository: "acme/skills", ...fields };
  return {
    ...(defaultBranch === undefined ? {} : { repository: { default_branch: defaultBranch } }),
    pull_request: {
      number: 8,
      base: { ...(baseSha === undefined ? {} : { sha: baseSha }), ...(baseRef === undefined ? {} : { ref: baseRef }) },
      head: {
        ...(headRef === undefined ? {} : { ref: headRef }),
        repo: headRepository === null ? null : headRepository === undefined ? {} : { full_name: headRepository }
      }
    }
  };
}

// Registry tokens with JSON, Markdown and code-span syntax, which reports must redact before they escape anything.
export const ECHOED_TOKEN = 'synthetic_registry_"token\\with`format';
export const ECHOED_SECOND_TOKEN = "synthetic_second_token";
export const ECHOED_ENVIRONMENT = { AIREG_TOKEN_ACME: ECHOED_TOKEN, AIREG_TOKEN_TEAM: ECHOED_SECOND_TOKEN };

/** A result that echoes both tokens in every field a report renders, with one export that publishes and one that does not. */
export function echoedResult(dryRun: boolean): PublishResult {
  return {
    dryRun,
    target: { registry: "acme", namespace: `engineering-${ECHOED_TOKEN}` },
    artifacts: [
      exported(`review-${ECHOED_TOKEN}`, "0.3.1", "0.3.2", {
        namespace: `engineering-${ECHOED_SECOND_TOKEN}`,
        dependsOn: [{ to: `engineering/skill/${ECHOED_TOKEN}@0.1.0` }],
        filesChanged: { added: [], changed: [`rules/${ECHOED_TOKEN}.md`, "config.json"], removed: [`old/${ECHOED_SECOND_TOKEN}.md`] },
        dependsOnChanged: { added: [`engineering/skill/${ECHOED_SECOND_TOKEN}@0.1.1`], removed: [] }
      }),
      exported("plain", "1.0.0", "1.0.0")
    ],
    skipped: [{ name: `agent-${ECHOED_SECOND_TOKEN}`, kind: "agent", path: `agents/${ECHOED_TOKEN}`, reason: `unsupported ${ECHOED_TOKEN}` }]
  };
}

export async function stepEnvironment(t: TestContext, extra: Record<string, string> = {}) {
  const directory = await temporaryDirectory(t, "aireg-publish-step-");
  const output = path.join(directory, "output.txt");
  const summary = path.join(directory, "summary.md");
  return { output, summary, environment: { ...actionDefaults(), GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...extra } };
}

export async function manifestCheckout(t: TestContext, manifest: string | null = MANIFEST): Promise<string> {
  const workspace = await temporaryDirectory(t, "aireg-publish-workspace-");
  await writeFiles(workspace, { ...SKILL, ...(manifest === null ? {} : { ".registry/manifest.yml": manifest }) });
  await mkdir(path.join(workspace, ".registry"), { recursive: true });
  git(workspace, "init", "-q");
  git(workspace, "add", "-A");
  return workspace;
}

export async function pullRequestCheckout(t: TestContext, { base, manifest }: { base: string | null; manifest: string | null }) {
  const workspace = await temporaryDirectory(t, "aireg-publish-pull-");
  await writeFiles(workspace, SKILL);
  await mkdir(path.join(workspace, ".registry"), { recursive: true });
  git(workspace, "init", "-q");
  if (base !== null) await writeFile(path.join(workspace, ".registry", "manifest.yml"), base);
  git(workspace, "add", "-A");
  git(workspace, "commit", "-q", "-m", "base");
  const baseSha = git(workspace, "rev-parse", "HEAD").trim();
  await rm(path.join(workspace, ".registry", "manifest.yml"), { force: true });
  if (manifest !== null) await writeFile(path.join(workspace, ".registry", "manifest.yml"), manifest);
  git(workspace, "add", "-A");
  git(workspace, "commit", "-q", "--allow-empty", "-m", "head");
  return { workspace, baseSha };
}
