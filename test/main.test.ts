import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, it } from "node:test";

describe("main", () => {
  it("fails the step with an error annotation", () => {
    const entry = path.resolve(import.meta.dirname, "../src/main.ts");
    const ran = spawnSync(process.execPath, [entry], { env: { GITHUB_EVENT_NAME: "pull_request_target" }, encoding: "utf8" });
    assert.equal(ran.status, 1);
    assert.equal(ran.stdout, "::error title=ai-registry Action::ai-registry Action refuses pull_request_target, which would run pull-request code with base-repository secrets; run it on pull_request\n");
  });
});
