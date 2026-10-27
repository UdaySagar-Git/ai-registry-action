import { type Environment, type Repository, repositoryOf } from "./action.ts";
import {
  COMMENT_PAGE_SIZE, COMMIT_SHA, GITHUB_API, GITHUB_API_VERSION, MAX_COMMENT_PAGES, MAX_GITHUB_RESPONSE_BYTES,
  REQUEST_TIMEOUT_MS, USER_AGENT
} from "./constants.ts";

export class GitHubRequestError extends Error {
  readonly status: number | undefined;

  constructor(status?: number) {
    super(status ? `GitHub API request failed with HTTP ${status}` : "GitHub API request failed");
    this.name = "GitHubRequestError";
    this.status = status;
  }
}

export interface GitHubRequestOptions {
  token: string;
  method: "GET" | "POST" | "PATCH";
  requestPath: string;
  body?: Record<string, unknown>;
  expectedStatus: number;
}

export type GitHubRequest = (options: GitHubRequestOptions) => Promise<unknown>;

export const githubRequest: GitHubRequest = async ({ token, method, requestPath, body, expectedStatus }) => {
  if (!requestPath.startsWith("/") || requestPath.startsWith("//")) throw new Error("GitHub API request path is invalid");
  let status = 0;
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    const response = await fetch(new URL(requestPath, GITHUB_API), {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    status = response.status;
    // Leaving the loop cancels the body, so an oversized response stops downloading.
    for await (const chunk of response.body ?? []) {
      size += chunk.byteLength;
      if (size > MAX_GITHUB_RESPONSE_BYTES) break;
      chunks.push(chunk);
    }
  } catch {
    throw new GitHubRequestError();
  }
  if (size > MAX_GITHUB_RESPONSE_BYTES) throw new Error("GitHub API response exceeds the size limit");
  if (status !== expectedStatus) throw new GitHubRequestError(status);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : undefined;
  } catch {
    throw new GitHubRequestError(status);
  }
};

export interface PullRequestContext extends Repository {
  pullNumber: number;
  baseSha: string | undefined;
  /** Dropped when it holds control characters, which git ref names never contain. */
  baseRef?: string;
  defaultBranch?: string;
  intoDefaultBranch: boolean;
  /** A fork, or a head repository GitHub does not name (a deleted fork), is someone else's code. */
  crossRepository: boolean;
  headRef?: string;
}

interface EventPayload {
  repository?: { default_branch?: unknown };
  pull_request?: {
    number?: unknown;
    base?: { sha?: unknown; ref?: unknown };
    head?: { ref?: unknown; repo?: { full_name?: unknown } | null };
  };
}

const sha = (value: unknown): string | undefined => typeof value === "string" && COMMIT_SHA.test(value) ? value : undefined;
const ref = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= 255 && !/\p{Cc}/u.test(value) ? value : undefined;

export function defaultBranchOf(payload: unknown): string | undefined {
  return ref((payload as EventPayload | null | undefined)?.repository?.default_branch);
}

export function parsePullRequestContext(environment: Environment, payload: unknown): PullRequestContext {
  const repository = repositoryOf(environment);
  if (!repository) throw new Error("GITHUB_REPOSITORY must contain a valid owner and repository");
  const pull = (payload as EventPayload | undefined)?.pull_request;
  const pullNumber = pull?.number;
  if (typeof pullNumber !== "number" || !Number.isSafeInteger(pullNumber) || pullNumber < 1) {
    throw new Error("GitHub event payload is missing a valid pull request number");
  }
  const baseRef = ref(pull?.base?.ref);
  const headRef = ref(pull?.head?.ref);
  const defaultBranch = defaultBranchOf(payload);
  const headRepository = pull?.head?.repo?.full_name;
  return {
    ...repository,
    pullNumber,
    baseSha: sha(pull?.base?.sha),
    ...(baseRef ? { baseRef } : {}),
    ...(headRef ? { headRef } : {}),
    ...(defaultBranch ? { defaultBranch } : {}),
    intoDefaultBranch: baseRef !== undefined && baseRef === defaultBranch,
    crossRepository: typeof headRepository !== "string" || headRepository.toLowerCase() !== `${repository.owner}/${repository.repo}`.toLowerCase()
  };
}

interface Comment {
  id: number;
  body: string;
  user?: { login?: unknown; type?: unknown } | null;
}

interface MarkerCommentTarget extends Repository {
  token: string;
  request: GitHubRequest;
  issueNumber: number;
  marker: string;
}

export function repositoryPath({ owner, repo }: Repository): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

function commentsPath(target: MarkerCommentTarget): string {
  return `${repositoryPath(target)}/issues/${target.issueNumber}/comments`;
}

function isMarked(comment: unknown, marker: string): comment is Comment {
  const candidate = comment as Partial<Comment> | null;
  return Number.isSafeInteger(candidate?.id) && (candidate?.id ?? 0) > 0 && typeof candidate?.body === "string" && candidate.body.includes(marker);
}

// A job's GITHUB_TOKEN cannot read /user, so without that identity only a lone bot-owned marked comment is trusted,
// and a comment list that cannot be scanned completely is refused.
async function findMarkerComment(target: MarkerCommentTarget): Promise<Comment | undefined> {
  const { token, request, marker } = target;
  let author: { login: string; type: string } | undefined;
  try {
    const viewer = await request({ token, method: "GET", requestPath: "/user", expectedStatus: 200 }) as { login?: unknown; type?: unknown } | undefined;
    if (typeof viewer?.login === "string" && (viewer.type === "User" || viewer.type === "Bot")) author = { login: viewer.login, type: viewer.type };
  } catch (error) {
    if (!(error instanceof GitHubRequestError) || error.status !== 403) throw error;
  }
  const bots: Comment[] = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
    const comments = await request({
      token, method: "GET", requestPath: `${commentsPath(target)}?per_page=${COMMENT_PAGE_SIZE}&page=${page}`, expectedStatus: 200
    });
    if (!Array.isArray(comments)) throw new Error("GitHub API returned an invalid comment list");
    const marked = comments.filter(comment => isMarked(comment, marker));
    if (author) {
      const own = marked.find(comment => comment.user?.login === author.login && comment.user.type === author.type);
      if (own) return own;
    } else {
      bots.push(...marked.filter(comment => comment.user?.type === "Bot" && typeof comment.user.login === "string" && comment.user.login.endsWith("[bot]")));
    }
    if (comments.length < COMMENT_PAGE_SIZE) {
      if (bots.length > 1) {
        throw new Error(`multiple bot-owned marked comments make token ownership ambiguous; delete all but one (comment IDs: ${bots.map(comment => comment.id).join(", ")})`);
      }
      return bots[0];
    }
  }
  throw new Error("too many pull request comments to safely update the comment");
}

async function writeMarkerComment(target: MarkerCommentTarget & { existing: Comment | undefined; body: string }): Promise<Comment> {
  const { token, request, existing, body } = target;
  const comment = await request({
    token,
    method: existing ? "PATCH" : "POST",
    requestPath: existing ? `${repositoryPath(target)}/issues/comments/${existing.id}` : commentsPath(target),
    body: { body },
    expectedStatus: existing ? 200 : 201
  }) as Partial<Comment> | undefined;
  if (typeof comment?.id !== "number" || !Number.isSafeInteger(comment.id) || comment.id < 1) {
    throw new Error("GitHub API returned a comment without a valid ID");
  }
  return { id: comment.id, body };
}

export async function upsertMarkerComment(target: MarkerCommentTarget & { body: string }): Promise<Comment> {
  return writeMarkerComment({ ...target, existing: await findMarkerComment(target) });
}
