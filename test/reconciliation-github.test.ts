import assert from "node:assert/strict";
import test from "node:test";

import type { InstallationToken, InstallationTokenProvider, InstallationTokenRequest } from "../src/github-app.js";
import { GitHubReconciliationReader } from "../src/reconciliation-github.js";
import type { ReconciliationReadRequest } from "../src/reconciliation-resolver.js";

class RecordingTokens implements InstallationTokenProvider {
  readonly requests: InstallationTokenRequest[] = [];

  async mint(request: InstallationTokenRequest): Promise<InstallationToken> {
    this.requests.push(request);
    return { token: `read-token-${this.requests.length}`, expiresAt: "2026-07-14T19:00:00Z" };
  }
}

const queueRequest: ReconciliationReadRequest = {
  installationId: 41,
  target: {
    repository: "acme/checkout-service",
    pullRequest: 42,
    expectedHeadSha: "head-42",
  },
  expectation: { pullRequestNodeId: "PR_kwDOFixture42" },
};

test("reconciliation observes a queue entry through a GraphQL query with read-only scope", async () => {
  const tokens = new RecordingTokens();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const reader = new GitHubReconciliationReader(
    tokens,
    async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              id: "PR_kwDOFixture42",
              mergeQueueEntry: { id: "MQE_42", headCommit: { oid: "head-42" } },
            },
          },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  );

  const observed = await reader.observeMergeQueue(queueRequest);
  assert.equal(observed.state, "queued");
  assert.deepEqual(tokens.requests[0]?.permissions, { pull_requests: "read", merge_queues: "read" });
  assert.equal(calls[0]?.url, "https://api.github.com/graphql");
  assert.equal(calls[0]?.init?.method, "POST");
  const body = JSON.parse(String(calls[0]?.init?.body)) as { query: string; variables: unknown };
  assert.match(body.query, /^query /);
  assert.doesNotMatch(body.query, /mutation/i);
  assert.deepEqual(body.variables, { owner: "acme", name: "checkout-service", number: 42 });
});

test("reconciliation accepts only an exact completed Check Run and mints checks:read", async () => {
  const tokens = new RecordingTokens();
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const reader = new GitHubReconciliationReader(
    tokens,
    async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify({
        id: 9,
        name: "MergeProof / evidence",
        head_sha: "head-42",
        external_id: "check_run_publish:run-42",
        status: "completed",
        conclusion: "success",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  );
  const observed = await reader.observeCheckRun({
    installationId: 41,
    target: { ...queueRequest.target, checkName: "MergeProof / evidence" },
    expectation: {
      checkRunId: 9,
      checkRunExternalId: "check_run_publish:run-42",
      expectedCheckConclusion: "success",
    },
  });
  assert.equal(observed.state, "published");
  assert.deepEqual(tokens.requests[0]?.permissions, { checks: "read" });
  assert.equal(calls[0]?.init?.method, undefined);
  assert.match(calls[0]?.url ?? "", /\/check-runs\/9$/);
});

test("reconciliation requires an exact pinned merged PR before accepting a direct merge", async () => {
  const tokens = new RecordingTokens();
  const reader = new GitHubReconciliationReader(
    tokens,
    async () => new Response(JSON.stringify({
      number: 42,
      node_id: "PR_kwDOFixture42",
      head: { sha: "head-42" },
      merged_at: "2026-07-14T18:00:00Z",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  );
  const observed = await reader.observeDirectMerge({
    ...queueRequest,
    expectation: { pullRequestNodeId: "PR_kwDOFixture42" },
  });
  assert.equal(observed.state, "merged");
  assert.deepEqual(tokens.requests[0]?.permissions, { pull_requests: "read" });
});
