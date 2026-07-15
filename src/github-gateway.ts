import type { CanonicalGitHubIssue, LivePullRequest, MergePolicy } from "./domain.js";
import type { MergeGateway } from "./merge-broker.js";

type GitHubPull = {
  node_id: string;
  state: string;
  draft: boolean;
  base: { sha: string; ref?: string };
  head: { sha: string };
  merge_commit_sha: string | null;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
};

type GitHubCheckRuns = {
  check_runs: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    app?: { id?: number; slug?: string } | null;
  }>;
};

type GitHubReview = {
  id: number;
  state: string;
  submitted_at: string | null;
  commit_id: string | null;
  user: { id: number } | null;
};

type GitHubIssue = {
  number: number;
  title: string;
  body: string | null;
  /** Present when the issue API object is actually a pull request. */
  pull_request?: unknown;
};

type GitHubAssociatedPull = {
  number: unknown;
};

type GitHubRequiredStatusChecks = {
  /** Newer GitHub API shape that pins a Check Run to its owning App. */
  checks?: Array<{ context?: unknown; app_id?: unknown }>;
  /** Legacy context-only shape; never source-pinned, so it cannot satisfy MergeProof. */
  contexts?: unknown;
};

export interface RequiredStatusCheck {
  name: string;
  appId?: number;
}

// The diff is advisory context for the no-tool planner, not merge authority.
// Bound it nevertheless: a giant PR must not let one webhook allocate
// unbounded controller memory before E2B receives the exact source archive.
const maxPullRequestDiffBytes = 2 * 1024 * 1024;

function latestApprovals(reviews: GitHubReview[], headSha: string): number {
  const latest = new Map<number, GitHubReview>();
  for (const review of reviews) {
    if (!review.user) {
      continue;
    }
    const existing = latest.get(review.user.id);
    if (
      !existing ||
      (review.submitted_at ?? "") > (existing.submitted_at ?? "")
    ) {
      latest.set(review.user.id, review);
    }
  }
  return [...latest.values()].filter(
    (review) => review.state === "APPROVED" && review.commit_id === headSha,
  ).length;
}

/**
 * Minimal REST gateway intended for a GitHub App installation token scoped to
 * pull-request reads plus merging. Token minting stays outside this class.
 */
export class GitHubRestGateway implements MergeGateway {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
  ) {}

  async getPullRequest(repository: string, pullRequest: number): Promise<LivePullRequest> {
    const pull = await this.request<GitHubPull>(
      `/repos/${repository}/pulls/${pullRequest}`,
    );
    const [checkRuns, reviews, diff] = await Promise.all([
      this.listCheckRuns(repository, pull.head.sha),
      this.listReviews(repository, pullRequest),
      this.requestText(
        `/repos/${repository}/pulls/${pullRequest}`,
        "application/vnd.github.diff",
        maxPullRequestDiffBytes,
      ),
    ]);

    return {
      nodeId: pull.node_id,
      repository,
      pullRequest,
      state: pull.state === "open" ? "open" : "closed",
      draft: pull.draft,
      baseSha: pull.base.sha,
      ...(typeof pull.base.ref === "string" && pull.base.ref.length > 0 ? { baseRef: pull.base.ref } : {}),
      headSha: pull.head.sha,
      mergeSha: pull.merge_commit_sha,
      title: pull.title,
      description: pull.body ?? "",
      diff,
      labels: pull.labels.map((label) => label.name),
      approvals: latestApprovals(reviews, pull.head.sha),
      checks: checkRuns.map((check) => ({
        name: check.name,
        status:
          check.status !== "completed"
            ? "pending"
            : check.conclusion === "success"
              ? "pass"
              : "fail",
        ...(typeof check.app?.id === "number" ? { appId: check.app.id } : {}),
        ...(typeof check.app?.slug === "string" ? { appSlug: check.app.slug } : {}),
      })),
    };
  }

  /**
   * Retrieves the canonical issue through the same installation-scoped,
   * read-only gateway used for PR state. The transient title/body are bounded
   * before any model receives them and are never written to a receipt.
   */
  async getIssue(repository: string, issueNumber: number): Promise<CanonicalGitHubIssue> {
    if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
      throw new Error("GitHub issue number must be a positive safe integer.");
    }
    const issue = await this.request<GitHubIssue>(`/repos/${repository}/issues/${issueNumber}`);
    if (!Number.isSafeInteger(issue.number) || issue.number !== issueNumber) {
      throw new Error("GitHub issue response did not match the requested issue number.");
    }
    if (typeof issue.title !== "string" || (issue.body !== null && typeof issue.body !== "string")) {
      throw new Error("GitHub issue response has an invalid title or body.");
    }
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? "",
      isPullRequest: issue.pull_request !== undefined,
    };
  }

  /**
   * GitHub associates a queue-generated merge-group commit with each open PR
   * in that group. The final verifier uses this only to recover coordinates;
   * it reloads every PR before allowing the merge-group Check Run to pass.
   */
  async getPullRequestsForCommit(repository: string, commitSha: string): Promise<number[]> {
    if (!/^[0-9a-f]{7,64}$/i.test(commitSha)) {
      throw new Error("GitHub commit SHA is invalid for associated-pull-request lookup.");
    }
    const pullRequests: number[] = [];
    const seen = new Set<number>();
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.request<GitHubAssociatedPull[]>(
        `/repos/${repository}/commits/${commitSha}/pulls?per_page=100&page=${page}`,
      );
      for (const pull of result) {
        const pullRequest = pull.number;
        if (
          typeof pullRequest !== "number" ||
          !Number.isSafeInteger(pullRequest) ||
          pullRequest <= 0
        ) {
          throw new Error("GitHub associated-pull-request response has an invalid pull request number.");
        }
        if (!seen.has(pullRequest)) {
          seen.add(pullRequest);
          pullRequests.push(pullRequest);
        }
      }
      if (result.length < 100) {
        return pullRequests;
      }
    }
    throw new Error("GitHub associated-pull-request pagination exceeded the safe page limit.");
  }

  /**
   * Reads the base branch's required checks immediately before queueing. A
   * source-pinned MergeProof merge-group Check Run is a production safety
   * prerequisite, not an advisory configuration hint.
   */
  async getRequiredStatusChecks(repository: string, branch: string): Promise<RequiredStatusCheck[]> {
    if (!/^[A-Za-z0-9._/-]{1,255}$/.test(branch) || branch.includes("..")) {
      throw new Error("GitHub base branch name is invalid for protection lookup.");
    }
    const required = await this.request<GitHubRequiredStatusChecks>(
      `/repos/${repository}/branches/${encodeURIComponent(branch)}/protection/required_status_checks`,
    );
    if (Array.isArray(required.checks)) {
      return required.checks.flatMap((check) =>
        typeof check.context === "string" && check.context.length > 0
          ? [{
              name: check.context,
              ...(typeof check.app_id === "number" && Number.isSafeInteger(check.app_id)
                ? { appId: check.app_id }
                : {}),
            }]
          : [],
      );
    }
    if (Array.isArray(required.contexts)) {
      return required.contexts.flatMap((context) =>
        typeof context === "string" && context.length > 0 ? [{ name: context }] : [],
      );
    }
    throw new Error("GitHub branch protection response lacks required status checks.");
  }

  private async listCheckRuns(repository: string, sha: string): Promise<GitHubCheckRuns["check_runs"]> {
    const all: GitHubCheckRuns["check_runs"] = [];
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.request<GitHubCheckRuns>(
        `/repos/${repository}/commits/${sha}/check-runs?per_page=100&page=${page}`,
      );
      all.push(...result.check_runs);
      if (result.check_runs.length < 100) {
        return all;
      }
    }
    throw new Error("GitHub check-run pagination exceeded the safe page limit.");
  }

  private async listReviews(repository: string, pullRequest: number): Promise<GitHubReview[]> {
    const all: GitHubReview[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const result = await this.request<GitHubReview[]>(
        `/repos/${repository}/pulls/${pullRequest}/reviews?per_page=100&page=${page}`,
      );
      all.push(...result);
      if (result.length < 100) {
        return all;
      }
    }
    throw new Error("GitHub review pagination exceeded the safe page limit.");
  }

  async merge(input: {
    repository: string;
    pullRequest: number;
    expectedHeadSha: string;
    method: MergePolicy["mergeMethod"];
  }): Promise<{ merged: boolean; message: string }> {
    const result = await this.request<{ merged: boolean; message: string }>(
      `/repos/${input.repository}/pulls/${input.pullRequest}/merge`,
      {
        method: "PUT",
        body: JSON.stringify({ sha: input.expectedHeadSha, merge_method: input.method }),
      },
    );
    return result;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    return (await response.json()) as T;
  }

  private async requestText(path: string, accept: string, maxBytes: number): Promise<string> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      headers: {
        Accept: accept,
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2026-03-10",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      throw new Error(`GitHub pull-request diff exceeds the ${maxBytes}-byte safety limit.`);
    }
    if (!response.body) {
      return "";
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
        size += next.value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          throw new Error(`GitHub pull-request diff exceeds the ${maxBytes}-byte safety limit.`);
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    return Buffer.concat(chunks).toString("utf8");
  }
}
