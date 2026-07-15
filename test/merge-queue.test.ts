import assert from "node:assert/strict";
import test from "node:test";

import { GitHubMergeQueueGateway } from "../src/merge-queue.js";

test("merge-queue enqueue binds the GraphQL request to the exact observed head", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const gateway = new GitHubMergeQueueGateway(
    "queue-token",
    async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({ data: { enqueuePullRequest: { mergeQueueEntry: { id: "MQE_fixture" } } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  const result = await gateway.enqueue({
    repository: "acme/checkout-service",
    pullRequestNodeId: "PR_kwDOFixture42",
    expectedHeadSha: "f00dbabe",
  });
  assert.match(result.message, /accepted/i);
  assert.equal(calls[0]?.url, "https://api.github.com/graphql");
  const request = JSON.parse(String(calls[0]?.init?.body)) as { variables: { input: unknown } };
  assert.deepEqual(request.variables.input, {
    pullRequestId: "PR_kwDOFixture42",
    expectedHeadOid: "f00dbabe",
  });
  assert.equal(new Headers(calls[0]?.init?.headers).get("authorization"), "Bearer queue-token");
});

test("merge-queue enqueue fails closed when GitHub rejects the exact head", async () => {
  const gateway = new GitHubMergeQueueGateway(
    "queue-token",
    async () =>
      new Response(JSON.stringify({ errors: [{ message: "Head OID does not match" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  await assert.rejects(
    gateway.enqueue({
      repository: "acme/checkout-service",
      pullRequestNodeId: "PR_kwDOFixture42",
      expectedHeadSha: "stale",
    }),
    /Head OID does not match/,
  );
});

test("merge-queue dequeue targets only the authenticated pull-request node", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const gateway = new GitHubMergeQueueGateway(
    "queue-token",
    async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({ data: { dequeuePullRequest: { mergeQueueEntry: { id: "MQE_fixture" } } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );
  const result = await gateway.dequeue({
    repository: "acme/checkout-service",
    pullRequestNodeId: "PR_kwDOFixture42",
  });
  assert.match(result.message, /removed/i);
  const request = JSON.parse(String(calls[0]?.init?.body)) as { query: string; variables: { input: unknown } };
  assert.match(request.query, /^mutation DequeueMergeProofPullRequest/);
  assert.deepEqual(request.variables.input, { pullRequestId: "PR_kwDOFixture42" });
});

test("merge-queue observation accepts only the exact queued pull-request head", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const gateway = new GitHubMergeQueueGateway(
    "queue-token",
    async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({
          data: {
            node: {
              id: "PR_kwDOFixture42",
              mergeQueueEntry: { id: "MQE_fixture", headCommit: { oid: "f00dbabe" } },
            },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  );

  const result = await gateway.observeQueuedPullRequest({
    repository: "acme/checkout-service",
    pullRequestNodeId: "PR_kwDOFixture42",
    expectedHeadSha: "f00dbabe",
  });

  assert.deepEqual(result, { state: "queued" });
  const request = JSON.parse(String(calls[0]?.init?.body)) as { query: string; variables: { id: string } };
  assert.match(request.query, /^query MergeProofQueuedPullRequest/);
  assert.deepEqual(request.variables, { id: "PR_kwDOFixture42" });
});

test("merge-queue observation reports a removed queue entry without mutating GitHub", async () => {
  const gateway = new GitHubMergeQueueGateway(
    "queue-token",
    async () =>
      new Response(JSON.stringify({ data: { node: { id: "PR_kwDOFixture42", mergeQueueEntry: null } } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );

  const result = await gateway.observeQueuedPullRequest({
    repository: "acme/checkout-service",
    pullRequestNodeId: "PR_kwDOFixture42",
    expectedHeadSha: "f00dbabe",
  });

  assert.deepEqual(result, { state: "not_queued" });
});
