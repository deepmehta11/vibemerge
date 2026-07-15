import type { InstallationTokenProvider } from "./github-app.js";
import type {
  CheckRunObservation,
  DirectMergeObservation,
  MergeQueueObservation,
  ReconciliationReadRequest,
  ReadOnlyReconciliationReader,
} from "./reconciliation-resolver.js";

type PullResponse = {
  number?: unknown;
  node_id?: unknown;
  head?: { sha?: unknown } | null;
  merged_at?: unknown;
};

type CheckRunResponse = {
  id?: unknown;
  name?: unknown;
  head_sha?: unknown;
  external_id?: unknown;
  status?: unknown;
  conclusion?: unknown;
};

type CheckRunListResponse = { check_runs?: unknown };

type QueueGraphqlResponse = {
  data?: {
    repository?: {
      pullRequest?: {
        id?: unknown;
        mergeQueueEntry?: { id?: unknown; headCommit?: { oid?: unknown } | null } | null;
      } | null;
    } | null;
  };
  errors?: Array<{ message?: unknown }>;
};

function splitRepository(repository: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repository.split("/");
  if (!owner || !name || rest.length > 0) {
    throw new Error("Reconciliation requires an owner/repository target.");
  }
  return { owner, name };
}

/**
 * GitHub read adapter used only after an external operation was durably
 * journaled. Every method mints a fresh, least-privilege *read* token and
 * issues either GET requests or a GraphQL query—never a mutation.
 */
export class GitHubReconciliationReader implements ReadOnlyReconciliationReader {
  constructor(
    private readonly tokens: InstallationTokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
  ) {}

  async observeMergeQueue(input: ReconciliationReadRequest): Promise<MergeQueueObservation> {
    const token = await this.tokens.mint({
      installationId: input.installationId,
      repository: input.target.repository,
      permissions: { pull_requests: "read", merge_queues: "read" },
    });
    const { owner, name } = splitRepository(input.target.repository);
    const response = await this.request<QueueGraphqlResponse>(token.token, "/graphql", {
      method: "POST",
      body: JSON.stringify({
        query: `query MergeProofQueuedPullRequest($owner: String!, $name: String!, $number: Int!) {
          repository(owner: $owner, name: $name) {
            pullRequest(number: $number) { id mergeQueueEntry { id headCommit { oid } } }
          }
        }`,
        variables: { owner, name, number: input.target.pullRequest },
      }),
    });
    const errors = response.errors?.map((error) => error.message).filter((message): message is string => typeof message === "string");
    if (errors?.length) {
      throw new Error("GitHub merge-queue reconciliation query failed.");
    }
    const pullRequest = response.data?.repository?.pullRequest;
    const entry = pullRequest?.mergeQueueEntry;
    const matches =
      typeof pullRequest?.id === "string" &&
      pullRequest.id === input.expectation.pullRequestNodeId &&
      typeof entry?.id === "string" &&
      entry.headCommit?.oid === input.target.expectedHeadSha &&
      (input.expectation.queueEntryId === undefined || entry.id === input.expectation.queueEntryId);
    return this.queueObservation(input, matches ? "queued" : "unknown");
  }

  async observeDirectMerge(input: ReconciliationReadRequest): Promise<DirectMergeObservation> {
    const token = await this.tokens.mint({
      installationId: input.installationId,
      repository: input.target.repository,
      permissions: { pull_requests: "read" },
    });
    const pull = await this.request<PullResponse>(
      token.token,
      `/repos/${input.target.repository}/pulls/${input.target.pullRequest}`,
    );
    const matchesPinnedRevision =
      pull.number === input.target.pullRequest &&
      pull.node_id === input.expectation.pullRequestNodeId &&
      pull.head?.sha === input.target.expectedHeadSha;
    const state =
      matchesPinnedRevision && typeof pull.merged_at === "string"
        ? "merged"
        : matchesPinnedRevision && pull.merged_at === null
          ? "not_merged"
          : "unknown";
    return {
      kind: "direct_merge",
      target: { ...input.target },
      expectation: { ...input.expectation },
      state,
    };
  }

  async observeCheckRun(input: ReconciliationReadRequest): Promise<CheckRunObservation> {
    const token = await this.tokens.mint({
      installationId: input.installationId,
      repository: input.target.repository,
      permissions: { checks: "read" },
    });
    const checks = input.expectation.checkRunId
      ? [await this.request<CheckRunResponse>(
          token.token,
          `/repos/${input.target.repository}/check-runs/${input.expectation.checkRunId}`,
        )]
      : await this.listCheckRuns(token.token, input.target.repository, input.target.expectedHeadSha);
    const exact = checks.find((check) => this.matchesCheckRun(input, check));
    const state =
      exact?.status === "completed" &&
      exact.conclusion === input.expectation.expectedCheckConclusion
        ? "published"
        : exact?.status === "completed"
          ? "completed_other"
          : exact?.status === "in_progress"
            ? "in_progress"
            : "unknown";
    return {
      kind: "check_run_publish",
      target: { ...input.target },
      expectation: { ...input.expectation },
      state,
      ...(typeof exact?.id === "number" && Number.isSafeInteger(exact.id)
        ? { checkRunId: exact.id }
        : {}),
    };
  }

  private queueObservation(
    input: ReconciliationReadRequest,
    state: MergeQueueObservation["state"],
  ): MergeQueueObservation {
    return {
      kind: "merge_queue_enqueue",
      target: { ...input.target },
      expectation: { ...input.expectation },
      state,
    };
  }

  private async listCheckRuns(token: string, repository: string, headSha: string): Promise<CheckRunResponse[]> {
    const results: CheckRunResponse[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.request<CheckRunListResponse>(
        token,
        `/repos/${repository}/commits/${headSha}/check-runs?per_page=100&page=${page}`,
      );
      if (!Array.isArray(response.check_runs)) {
        throw new Error("GitHub Check Run reconciliation response was malformed.");
      }
      const pageRuns = response.check_runs.filter(
        (check): check is CheckRunResponse => typeof check === "object" && check !== null,
      );
      results.push(...pageRuns);
      if (pageRuns.length < 100) {
        return results;
      }
    }
    throw new Error("GitHub Check Run reconciliation pagination exceeded its safe limit.");
  }

  private matchesCheckRun(input: ReconciliationReadRequest, check: CheckRunResponse): boolean {
    return (
      typeof check.id === "number" &&
      (!input.expectation.checkRunId || check.id === input.expectation.checkRunId) &&
      typeof check.name === "string" &&
      check.name === input.target.checkName &&
      check.head_sha === input.target.expectedHeadSha &&
      (input.expectation.checkRunExternalId === undefined ||
        check.external_id === input.expectation.checkRunExternalId)
    );
  }

  private async request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub reconciliation read returned HTTP ${response.status}.`);
    }
    return (await response.json()) as T;
  }
}
