import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  githubRequest, type GitHubRequest, GitHubRequestError, type GitHubRequestOptions, parsePullRequestContext,
  upsertMarkerComment
} from "../src/github.ts";

const SHA = "a".repeat(40);
const GET_USER: GitHubRequestOptions = { token: "synthetic", method: "GET", requestPath: "/user", expectedStatus: 200 };

function mockFetch(t: TestContext, respond: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  return t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => respond(url, init));
}

describe("githubRequest", () => {
  it("calls the fixed GitHub API with the token, pinned version and JSON body, refusing redirects and bounding time", async t => {
    const fetch = mockFetch(t, () => Response.json({ id: 7 }, { status: 201 }));
    const answer = await githubRequest({ token: "synthetic", method: "POST", requestPath: "/repos/acme/skills/issues/1/comments", body: { body: "hi" }, expectedStatus: 201 });
    assert.deepEqual(answer, { id: 7 });
    const [url, init] = fetch.mock.calls[0]?.arguments ?? [];
    assert.equal(String(url), "https://api.github.com/repos/acme/skills/issues/1/comments");
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal instanceof AbortSignal);
    assert.equal(init?.body, JSON.stringify({ body: "hi" }));
    assert.deepEqual(init?.headers, {
      "User-Agent": "ai-registry-action",
      Accept: "application/vnd.github+json",
      Authorization: "Bearer synthetic",
      "X-GitHub-Api-Version": "2026-03-10",
      "Content-Type": "application/json"
    });
  });

  it("refuses a path that could leave the API origin", async t => {
    const fetch = mockFetch(t, () => assert.fail("no request"));
    for (const requestPath of ["//evil.example/x", "https://evil.example/x", "user"]) {
      await assert.rejects(githubRequest({ ...GET_USER, requestPath }), /request path is invalid/);
    }
    assert.equal(fetch.mock.callCount(), 0);
  });

  const failures: [string, () => Response, number | undefined][] = [
    ["an unexpected status", () => new Response("{}", { status: 404 }), 404],
    ["a network failure", () => { throw new TypeError("fetch failed"); }, undefined],
    ["a body that fails while it is read", () => new Response(new ReadableStream({ pull(controller) { controller.error(new TypeError("terminated")); } })), undefined],
    ["a malformed body", () => new Response("{", { status: 200 }), 200]
  ];
  for (const [name, respond, status] of failures) {
    it(`reports ${name} as GitHubRequestError`, async t => {
      mockFetch(t, respond);
      await assert.rejects(githubRequest(GET_USER), (error: unknown) => error instanceof GitHubRequestError && error.status === status);
    });
  }

  it("cancels a response once it passes the size limit", async t => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); },
      cancel() { cancelled = true; }
    });
    mockFetch(t, () => new Response(body));
    await assert.rejects(githubRequest(GET_USER), { message: "GitHub API response exceeds the size limit" });
    assert.equal(cancelled, true);
  });

  it("returns undefined for an empty body", async t => {
    mockFetch(t, () => new Response(null, { status: 204 }));
    assert.equal(await githubRequest({ ...GET_USER, expectedStatus: 204 }), undefined);
  });
});

describe("parsePullRequestContext", () => {
  const environment = { GITHUB_REPOSITORY: "acme/skills" };
  const payload = (head: Record<string, unknown>, base: Record<string, unknown> = {}) => ({
    repository: { default_branch: "main" },
    pull_request: { number: 7, base: { sha: SHA, ref: "main", ...base }, head }
  });

  it("reads a same-repository pull request", () => {
    assert.deepEqual(parsePullRequestContext(environment, payload({ repo: { full_name: "Acme/Skills" } })), {
      owner: "acme", repo: "skills", pullNumber: 7, baseSha: SHA, baseRef: "main", defaultBranch: "main", intoDefaultBranch: true, crossRepository: false
    });
  });

  it("says the pull request merges into the default branch only when GitHub names both and they match", () => {
    assert.equal(parsePullRequestContext(environment, payload({}, { ref: "release/next" })).intoDefaultBranch, false);
    assert.equal(parsePullRequestContext(environment, payload({}, { ref: undefined })).intoDefaultBranch, false);
    assert.equal(parsePullRequestContext(environment, { pull_request: payload({}).pull_request }).intoDefaultBranch, false);
  });

  it("keeps the default branch only when the event names one git could have named", () => {
    assert.equal(parsePullRequestContext(environment, { ...payload({}), repository: { default_branch: "trunk" } }).defaultBranch, "trunk");
    for (const repository of [undefined, {}, { default_branch: "main\n" }, { default_branch: 7 }]) {
      const context = parsePullRequestContext(environment, { ...payload({}), repository });
      assert.equal("defaultBranch" in context, false);
      assert.equal(context.intoDefaultBranch, false);
    }
  });

  it("keeps the base branch verbatim, dropping only one git could never have named", () => {
    assert.equal(parsePullRequestContext(environment, payload({}, { ref: "fix+x@topic/é" })).baseRef, "fix+x@topic/é");
    for (const ref of ["main\n", "", "x".repeat(256), 7]) {
      const context = parsePullRequestContext(environment, payload({}, { ref }));
      assert.equal("baseRef" in context, false);
      assert.equal(context.intoDefaultBranch, false);
    }
  });

  it("keeps the head branch verbatim, dropping only one git could never have named", () => {
    assert.equal(parsePullRequestContext(environment, payload({ ref: "fix/x@é", repo: { full_name: "acme/skills" } })).headRef, "fix/x@é");
    for (const ref of ["fix\n", "fix\u0000x", "", "x".repeat(256), 7, undefined]) {
      assert.equal("headRef" in parsePullRequestContext(environment, payload({ ref, repo: { full_name: "acme/skills" } })), false);
    }
  });

  it("treats a fork or a deleted head repository as cross-repository", () => {
    assert.equal(parsePullRequestContext(environment, payload({ repo: { full_name: "fork/skills" } })).crossRepository, true);
    assert.equal(parsePullRequestContext(environment, payload({ repo: null })).crossRepository, true);
  });

  it("drops a malformed base SHA instead of trusting it", () => {
    assert.equal(parsePullRequestContext(environment, payload({}, { sha: "nope" })).baseSha, undefined);
  });

  it("refuses an invalid repository or pull request number", () => {
    assert.throws(() => parsePullRequestContext({ GITHUB_REPOSITORY: "acme" }, payload({})), /GITHUB_REPOSITORY must contain/);
    for (const number of [0, -1, 1.5, "7", undefined]) {
      assert.throws(() => parsePullRequestContext(environment, { pull_request: { number } }), /valid pull request number/);
    }
  });
});

describe("upsertMarkerComment", () => {
  const MARKER = "<!-- marker -->";
  const target = { token: "t", owner: "acme", repo: "skills", issueNumber: 7, marker: MARKER, body: "updated" };
  const comment = (id: number, login: string, type: string, body = `${MARKER}\nreport`) => ({ id, body, user: { login, type } });
  const page = (n: number) => `GET /repos/acme/skills/issues/7/comments?per_page=50&page=${n}`;
  const patch = (id: number) => `PATCH /repos/acme/skills/issues/comments/${id}`;
  const forbidden = () => { throw new GitHubRequestError(403); };

  function github(routes: Record<string, unknown>): GitHubRequest & { calls: GitHubRequestOptions[] } {
    const calls: GitHubRequestOptions[] = [];
    const request = async (options: GitHubRequestOptions) => {
      calls.push(options);
      const route = routes[`${options.method} ${options.requestPath}`];
      if (route === undefined) throw new Error(`unexpected ${options.method} ${options.requestPath}`);
      return typeof route === "function" ? route(options) : route;
    };
    return Object.assign(request, { calls });
  }

  it("updates the comment written by the token's own identity", async () => {
    const request = github({
      "GET /user": { login: "ci-user", type: "User" },
      [page(1)]: [comment(1, "someone", "User"), comment(2, "ci-user", "User"), comment(3, "ci-user", "User", "no marker")],
      [patch(2)]: { id: 2 }
    });
    assert.deepEqual(await upsertMarkerComment({ ...target, request }), { id: 2, body: "updated" });
    assert.deepEqual(request.calls.at(-1), { token: "t", method: "PATCH", requestPath: "/repos/acme/skills/issues/comments/2", body: { body: "updated" }, expectedStatus: 200 });
  });

  it("reads later pages until it finds the comment", async () => {
    const others = Array.from({ length: 50 }, (_, index) => comment(100 + index, "someone", "User"));
    const request = github({ "GET /user": { login: "ci-user", type: "User" }, [page(1)]: others, [page(2)]: [comment(2, "ci-user", "User")], [patch(2)]: { id: 2 } });
    assert.equal((await upsertMarkerComment({ ...target, request })).id, 2);
  });

  it("creates a comment when the token owns none", async () => {
    const request = github({ "GET /user": { login: "ci-user", type: "User" }, [page(1)]: [comment(1, "someone", "User")], "POST /repos/acme/skills/issues/7/comments": { id: 10 } });
    assert.deepEqual(await upsertMarkerComment({ ...target, request }), { id: 10, body: "updated" });
    assert.deepEqual(request.calls.at(-1)?.expectedStatus, 201);
  });

  it("updates the single bot-owned marked comment when the token cannot read its identity", async () => {
    const request = github({ "GET /user": forbidden, [page(1)]: [comment(4, "someone", "User"), comment(5, "github-actions[bot]", "Bot")], [patch(5)]: { id: 5 } });
    assert.equal((await upsertMarkerComment({ ...target, request })).id, 5);
  });

  it("refuses several bot-owned marked comments when the token cannot read its identity", async () => {
    const request = github({ "GET /user": forbidden, [page(1)]: [comment(5, "a[bot]", "Bot"), comment(6, "b[bot]", "Bot")] });
    await assert.rejects(upsertMarkerComment({ ...target, request }), /ambiguous; delete all but one \(comment IDs: 5, 6\)/);
  });

  it("propagates identity failures other than 403", async () => {
    const request = github({ "GET /user": () => { throw new GitHubRequestError(500); } });
    await assert.rejects(upsertMarkerComment({ ...target, request }), (error: unknown) => error instanceof GitHubRequestError && error.status === 500);
  });

  it("refuses when the comment list cannot be read completely", async () => {
    const full = Array.from({ length: 50 }, (_, index) => comment(100 + index, "someone", "User", "other"));
    const routes: Record<string, unknown> = { "GET /user": { login: "ci-user", type: "User" } };
    for (let n = 1; n <= 20; n += 1) routes[page(n)] = full;
    await assert.rejects(upsertMarkerComment({ ...target, request: github(routes) }), /^Error: too many pull request comments to safely update the comment$/);
    await assert.rejects(upsertMarkerComment({ ...target, request: github({ "GET /user": {}, [page(1)]: { not: "a list" } }) }), /invalid comment list/);
  });

  it("requires a valid comment ID back", async () => {
    const request = github({ "GET /user": {}, [page(1)]: [], "POST /repos/acme/skills/issues/7/comments": { id: 0 } });
    await assert.rejects(upsertMarkerComment({ ...target, request }), /without a valid ID/);
  });
});
