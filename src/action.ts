import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { ACTION_NAME, GITHUB_SERVER, MAX_EVENT_BYTES } from "./constants.ts";

export type Environment = Readonly<Record<string, string | undefined>>;

export interface Repository {
  owner: string;
  repo: string;
}

// Owners are alphanumeric with inner hyphens; repository names may start with a dot (".github") but are never . or ..
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/(?!\.\.?$)[A-Za-z0-9_.-]{1,100}$/;

export function getInput(environment: Environment, name: string): string {
  return (environment[`INPUT_${name.replaceAll(" ", "_").toUpperCase()}`] ?? "").trim();
}

export function getBooleanInput(environment: Environment, name: string): boolean {
  const raw = getInput(environment, name);
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new Error(`${name} must be true or false`);
}

export function setOutput(environment: Environment, name: string, value: string | number): void {
  const text = String(value);
  if (!/^[a-z0-9-]+$/i.test(name) || /[\r\n]/.test(text)) throw new Error("refusing an unsafe action output");
  if (environment.GITHUB_OUTPUT) fs.appendFileSync(environment.GITHUB_OUTPUT, `${name}=${text}\n`);
}

export function writeStepSummary(environment: Environment, text: string): void {
  if (!environment.GITHUB_STEP_SUMMARY) return;
  try {
    fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, `${text}\n`);
  } catch {
    // A step summary that cannot be written never fails the run.
  }
}

function escapeData(text: string): string {
  return text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}

function escapeProperty(text: string): string {
  return escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");
}

export function maskSecret(value: string): void {
  if (value) process.stdout.write(`::add-mask::${escapeData(value)}\n`);
}

export function annotate(level: "notice" | "warning" | "error", title: string, message: string): void {
  process.stdout.write(`::${level} title=${escapeProperty(title)}::${escapeData(message)}\n`);
}

function flushedWrite(text: string): Promise<void> {
  return new Promise(resolve => process.stdout.write(text, () => resolve()));
}

/** Suspends workflow commands so untrusted text `run` prints cannot issue them. `run` must print to stdout, and each
 *  marker is flushed first, because the runner does not order stdout and stderr. */
export async function withoutWorkflowCommands<T>(run: () => Promise<T>): Promise<T> {
  const resume = randomUUID();
  await flushedWrite(`::stop-commands::${resume}\n`);
  try {
    return await run();
  } finally {
    await flushedWrite(`::${resume}::\n`);
  }
}

export function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function fail(error: unknown): void {
  process.exitCode = 1;
  annotate("error", ACTION_NAME, messageOf(error, `${ACTION_NAME} failed`));
}

export function readEventPayload(environment: Environment): unknown {
  const eventPath = environment.GITHUB_EVENT_PATH;
  if (!eventPath) throw new Error("GITHUB_EVENT_PATH is required");
  let raw: string;
  try {
    const stat = fs.statSync(eventPath);
    if (!stat.isFile() || stat.size > MAX_EVENT_BYTES) throw new Error();
    raw = fs.readFileSync(eventPath, "utf8");
  } catch {
    throw new Error("GitHub event payload is missing or exceeds the size limit");
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GitHub event payload is not valid JSON");
  }
}

export function repositoryOf(environment: Environment): Repository | undefined {
  const repository = environment.GITHUB_REPOSITORY ?? "";
  if (!REPOSITORY.test(repository)) return undefined;
  const [owner = "", repo = ""] = repository.split("/");
  return { owner, repo };
}

export function runUrl(environment: Environment): string | undefined {
  const runId = environment.GITHUB_RUN_ID ?? "";
  const repository = repositoryOf(environment);
  if (!/^\d{1,20}$/.test(runId) || !repository) return undefined;
  return `${GITHUB_SERVER}/${repository.owner}/${repository.repo}/actions/runs/${runId}`;
}
