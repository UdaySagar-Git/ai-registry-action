import { readFileSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

const ACTION_YML = path.resolve(import.meta.dirname, "../../action.yml");

/** The `INPUT_*` values action.yml gives inputs whose default is a literal; expression defaults are left to each test. */
export function actionDefaults(): Record<string, string> {
  const defaults: Record<string, string> = {};
  let inputs = false;
  let input: string | undefined;
  for (const line of readFileSync(ACTION_YML, "utf8").split("\n")) {
    if (/^\S/.test(line)) inputs = line === "inputs:";
    if (!inputs) continue;
    const name = /^ {2}([\w-]+):\s*$/.exec(line)?.[1];
    if (name) input = name;
    const value = /^ {4}default:\s*(.*?)\s*$/.exec(line)?.[1];
    if (input && value !== undefined && !value.includes("${{")) {
      defaults[`INPUT_${input.toUpperCase()}`] = value.replace(/^"(.*)"$/, "$1");
    }
  }
  return defaults;
}

export async function temporaryDirectory(t: TestContext, prefix = "aireg-publish-test-"): Promise<string> {
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const captures = new WeakMap<TestContext, string[]>();

/** Captures stdout writes matching `pattern` (workflow commands by default) and passes the rest through, because the
 *  test runner reports over the same stream. */
export function captureStdout(t: TestContext, pattern = /^::/): string[] {
  // A second mock in the same test would restore the first mock, not the real stream.
  const existing = captures.get(t);
  if (existing) return existing;
  const written: string[] = [];
  captures.set(t, written);
  const write = process.stdout.write.bind(process.stdout) as (...args: unknown[]) => boolean;
  t.mock.method(process.stdout, "write", (chunk: unknown, ...rest: unknown[]) => {
    const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : undefined;
    if (text !== undefined && pattern.test(text)) {
      written.push(text);
      const done = rest.at(-1);
      if (typeof done === "function") done();
      return true;
    }
    return write(chunk, ...rest);
  });
  return written;
}

export function silenceStderr(t: TestContext): string[] {
  const written: string[] = [];
  t.mock.method(process.stderr, "write", (chunk: unknown) => {
    written.push(String(chunk));
    return true;
  });
  return written;
}

export async function outputsOf(file: string): Promise<string> {
  return readFile(file, "utf8").catch(() => "");
}

export function outputValue(outputs: string, name: string): unknown {
  const line = outputs.split("\n").find(item => item.startsWith(`${name}=`));
  return line === undefined ? undefined : JSON.parse(line.slice(name.length + 1));
}

/** Snapshots rendered Markdown as written, so the snapshot file reads like the comment or summary itself. */
export function assertMarkdownSnapshot(t: TestContext, markdown: string): void {
  t.assert.snapshot(markdown, { serializers: [(value: unknown) => value] });
}
