import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  annotate, fail, getBooleanInput, getInput, maskSecret, readEventPayload, repositoryOf, runUrl, setOutput,
  withoutWorkflowCommands, writeStepSummary
} from "../src/action.ts";
import { captureStdout, temporaryDirectory } from "./helpers/action.ts";

describe("getInput", () => {
  it("reads the INPUT_ variable GitHub sets for a name, trimmed", () => {
    assert.equal(getInput({ "INPUT_GITHUB-TOKEN": "  token \n" }, "github-token"), "token");
    assert.equal(getInput({ INPUT_MY_INPUT: "value" }, "my input"), "value");
    assert.equal(getInput({}, "absent"), "");
  });
});

describe("getBooleanInput", () => {
  it("accepts only true or false", () => {
    assert.equal(getBooleanInput({ INPUT_PUBLISH: "true" }, "publish"), true);
    assert.equal(getBooleanInput({ INPUT_PUBLISH: "false" }, "publish"), false);
    for (const raw of ["", "True", "yes", "1"]) {
      assert.throws(() => getBooleanInput({ INPUT_PUBLISH: raw }, "publish"), /^Error: publish must be true or false$/);
    }
  });
});

describe("setOutput", () => {
  it("appends one line to GITHUB_OUTPUT", async t => {
    const file = path.join(await temporaryDirectory(t), "output");
    setOutput({ GITHUB_OUTPUT: file }, "status", "success");
    setOutput({ GITHUB_OUTPUT: file }, "conflict-count", 2);
    assert.equal(readFileSync(file, "utf8"), "status=success\nconflict-count=2\n");
  });

  it("refuses names and values that could inject another output", async t => {
    const file = path.join(await temporaryDirectory(t), "output");
    for (const [name, value] of [["status", "a\nother=b"], ["status", "a\rb"], ["bad name", "x"], ["a=b", "x"]] as const) {
      assert.throws(() => setOutput({ GITHUB_OUTPUT: file }, name, value), /refusing an unsafe action output/);
    }
  });

  it("writes nothing without GITHUB_OUTPUT", () => {
    assert.doesNotThrow(() => setOutput({}, "status", "success"));
  });
});

describe("writeStepSummary", () => {
  it("appends the summary and never fails the run when it cannot", async t => {
    const directory = await temporaryDirectory(t);
    const file = path.join(directory, "summary");
    writeStepSummary({ GITHUB_STEP_SUMMARY: file }, "### Report");
    assert.equal(readFileSync(file, "utf8"), "### Report\n");
    assert.doesNotThrow(() => writeStepSummary({ GITHUB_STEP_SUMMARY: directory }, "unwritable"));
  });
});

describe("maskSecret and annotate", () => {
  it("escape command data so a value cannot end the command or start another", t => {
    const written = captureStdout(t);
    maskSecret("se%cr\net");
    maskSecret("");
    annotate("warning", "ai-registry Action: a, b", "line one\nline two 100%");
    assert.deepEqual(written, [
      "::add-mask::se%25cr%0Aet\n",
      "::warning title=ai-registry Action%3A a%2C b::line one%0Aline two 100%25\n"
    ]);
  });
});

describe("withoutWorkflowCommands", () => {
  it("suspends workflow commands around untrusted output and resumes them even on failure", async t => {
    const written = captureStdout(t);
    await assert.rejects(withoutWorkflowCommands(async () => {
      process.stdout.write("::error::spoofed\n");
      throw new Error("aireg failed");
    }), /aireg failed/);
    const [start, , end] = written;
    const token = /^::stop-commands::([0-9a-f-]{36})\n$/.exec(start ?? "")?.[1];
    assert.ok(token);
    assert.equal(end, `::${token}::\n`);
    assert.equal(await withoutWorkflowCommands(async () => "result"), "result");
  });
});

describe("fail", () => {
  it("fails the step with one error annotation", t => {
    const written = captureStdout(t);
    const previous = process.exitCode;
    t.after(() => { process.exitCode = previous; });
    fail(new Error("could not publish\nsecond line"));
    fail("not an error");
    assert.equal(process.exitCode, 1);
    assert.deepEqual(written, [
      "::error title=ai-registry Action::could not publish%0Asecond line\n",
      "::error title=ai-registry Action::ai-registry Action failed\n"
    ]);
  });
});

describe("readEventPayload", () => {
  it("parses the event file", async t => {
    const file = path.join(await temporaryDirectory(t), "event.json");
    writeFileSync(file, JSON.stringify({ repository: { default_branch: "main" } }));
    assert.deepEqual(readEventPayload({ GITHUB_EVENT_PATH: file }), { repository: { default_branch: "main" } });
  });

  it("refuses a missing, oversized, non-file or malformed payload", async t => {
    const directory = await temporaryDirectory(t);
    const large = path.join(directory, "large.json");
    writeFileSync(large, `"${"x".repeat(1024 * 1024)}"`);
    const malformed = path.join(directory, "malformed.json");
    writeFileSync(malformed, "{");
    const folder = path.join(directory, "folder");
    mkdirSync(folder);
    assert.throws(() => readEventPayload({}), /GITHUB_EVENT_PATH is required/);
    for (const eventPath of [path.join(directory, "absent.json"), large, folder]) {
      assert.throws(() => readEventPayload({ GITHUB_EVENT_PATH: eventPath }), /missing or exceeds the size limit/);
    }
    assert.throws(() => readEventPayload({ GITHUB_EVENT_PATH: malformed }), /not valid JSON/);
  });
});

describe("repositoryOf", () => {
  it("splits a well-formed owner and name, including dot-prefixed names", () => {
    for (const [repository, owner, repo] of [["acme/skills", "acme", "skills"], ["acme/.github", "acme", ".github"], ["a-b/a.b_c-d", "a-b", "a.b_c-d"]]) {
      assert.deepEqual(repositoryOf({ GITHUB_REPOSITORY: repository }), { owner, repo });
    }
  });

  it("refuses a missing or malformed repository, and the names . and ..", () => {
    for (const repository of [undefined, "", "acme", "acme/.", "acme/..", "-acme/x", "acme/", "a/b/c", "../x", `${"a".repeat(40)}/x`]) {
      assert.equal(repositoryOf({ GITHUB_REPOSITORY: repository }), undefined);
    }
  });
});

describe("runUrl", () => {
  it("links the run only when the runner's identifiers are well formed", () => {
    assert.equal(runUrl({ GITHUB_REPOSITORY: "acme/skills", GITHUB_RUN_ID: "42" }), "https://github.com/acme/skills/actions/runs/42");
    for (const environment of [{ GITHUB_REPOSITORY: "acme/skills", GITHUB_RUN_ID: "4a" }, { GITHUB_REPOSITORY: "../x", GITHUB_RUN_ID: "42" }, {}]) {
      assert.equal(runUrl(environment), undefined);
    }
  });
});
