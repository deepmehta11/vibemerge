export interface MergeQueueGateway {
  enqueue(input: {
    repository: string;
    pullRequestNodeId: string;
    expectedHeadSha: string;
  }): Promise<{ message: string }>;
  /** A safety-only action: removes a no-longer-eligible PR from GitHub's queue. */
  dequeue?(input: {
    repository: string;
    pullRequestNodeId: string;
  }): Promise<{ message: string }>;
  /**
   * Read-only membership check for a previously accepted exact PR head. This
   * is deliberately separate from enqueue: a missing entry must never cause
   * a controller to replay or silently assume an enqueue succeeded.
   */
  observeQueuedPullRequest?(input: {
    repository: string;
    pullRequestNodeId: string;
    expectedHeadSha: string;
  }): Promise<{ state: "queued" | "not_queued" }>;
}

type GraphqlResponse = {
  data?: { enqueuePullRequest?: { mergeQueueEntry?: { id?: unknown } | null } | null };
  errors?: Array<{ message?: unknown }>;
};

type DequeueGraphqlResponse = {
  data?: { dequeuePullRequest?: { mergeQueueEntry?: { id?: unknown } | null } | null };
  errors?: Array<{ message?: unknown }>;
};

type QueueObservationGraphqlResponse = {
  data?: {
    node?: {
      id?: unknown;
      mergeQueueEntry?: { id?: unknown; headCommit?: { oid?: unknown } | null } | null;
    } | null;
  };
  errors?: Array<{ message?: unknown }>;
};

/**
 * GitHub merge queue is the production merge authority. The mutation binds
 * enqueueing to the observed PR head; a later merge_group check verifies the
 * queue-generated SHA before GitHub performs the merge.
 */
export class GitHubMergeQueueGateway implements MergeQueueGateway {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
  ) {}

  async enqueue(input: {
    repository: string;
    pullRequestNodeId: string;
    expectedHeadSha: string;
  }): Promise<{ message: string }> {
    const response = await this.fetchImpl(`${this.apiBase}/graphql`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: JSON.stringify({
        query: `mutation EnqueueMergeProofPullRequest($input: EnqueuePullRequestInput!) {
          enqueuePullRequest(input: $input) { mergeQueueEntry { id } }
        }`,
        variables: {
          input: {
            pullRequestId: input.pullRequestNodeId,
            expectedHeadOid: input.expectedHeadSha,
          },
        },
      }),
    });
    const body = (await response.json().catch(() => ({}))) as GraphqlResponse;
    const errorMessage = body.errors
      ?.map((error) => (typeof error.message === "string" ? error.message : "GraphQL error"))
      .join("; ");
    if (!response.ok || errorMessage || !body.data?.enqueuePullRequest?.mergeQueueEntry?.id) {
      throw new Error(`GitHub merge-queue enqueue failed: ${errorMessage ?? `HTTP ${response.status}`}`);
    }
    return { message: "GitHub accepted the exact-head PR into its merge queue." };
  }

  async dequeue(input: {
    repository: string;
    pullRequestNodeId: string;
  }): Promise<{ message: string }> {
    const response = await this.fetchImpl(`${this.apiBase}/graphql`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: JSON.stringify({
        query: `mutation DequeueMergeProofPullRequest($input: DequeuePullRequestInput!) {
          dequeuePullRequest(input: $input) { mergeQueueEntry { id } }
        }`,
        variables: { input: { pullRequestId: input.pullRequestNodeId } },
      }),
    });
    const body = (await response.json().catch(() => ({}))) as DequeueGraphqlResponse;
    const errorMessage = body.errors
      ?.map((error) => (typeof error.message === "string" ? error.message : "GraphQL error"))
      .join("; ");
    if (!response.ok || errorMessage || !body.data?.dequeuePullRequest?.mergeQueueEntry?.id) {
      throw new Error(`GitHub merge-queue dequeue failed: ${errorMessage ?? `HTTP ${response.status}`}`);
    }
    return { message: "GitHub removed the pull request from its merge queue." };
  }

  async observeQueuedPullRequest(input: {
    repository: string;
    pullRequestNodeId: string;
    expectedHeadSha: string;
  }): Promise<{ state: "queued" | "not_queued" }> {
    const response = await this.fetchImpl(`${this.apiBase}/graphql`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
      body: JSON.stringify({
        query: `query MergeProofQueuedPullRequest($id: ID!) {
          node(id: $id) {
            ... on PullRequest { id mergeQueueEntry { id headCommit { oid } } }
          }
        }`,
        variables: { id: input.pullRequestNodeId },
      }),
    });
    const body = (await response.json().catch(() => ({}))) as QueueObservationGraphqlResponse;
    const errorMessage = body.errors
      ?.map((error) => (typeof error.message === "string" ? error.message : "GraphQL error"))
      .join("; ");
    if (!response.ok || errorMessage) {
      throw new Error(`GitHub merge-queue observation failed: ${errorMessage ?? `HTTP ${response.status}`}`);
    }
    const pullRequest = body.data?.node;
    const entry = pullRequest?.mergeQueueEntry;
    const exactEntry =
      pullRequest?.id === input.pullRequestNodeId &&
      typeof entry?.id === "string" &&
      entry.headCommit?.oid === input.expectedHeadSha;
    return { state: exactEntry ? "queued" : "not_queued" };
  }
}
