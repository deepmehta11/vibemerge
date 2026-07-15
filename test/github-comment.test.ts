import assert from "node:assert/strict";
import test from "node:test";

import { GitHubPullRequestCommentGateway, renderEvidenceComment } from "../src/github-comment.js";
import { demoRevision, demoVerificationPolicy, safeFixture } from "../src/fixtures.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import { VerificationEngine } from "../src/verifier.js";

async function receipt() {
  return new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
    demoRevision,
    demoVerificationPolicy,
    new Date("2026-07-14T18:00:00.000Z"),
  );
}

test("evidence comment preserves the audit trail without rendering candidate command output", async () => {
  const value = await receipt();
  value.reasons = [
    {
      code: "CHECK_FAILED",
      subject: "ci",
      detail: "Trusted CI gate. Command outcome: @untrusted [click](https://bad.example)",
    },
  ];
  const rendered = renderEvidenceComment(value);
  assert.match(rendered, /<!-- mergeproof:managed -->/);
  assert.match(rendered, /Trusted CI gate/);
  assert.doesNotMatch(rendered, /untrusted|bad\.example|@/);
  assert.match(rendered, /Advisory agent review/);
});

test("evidence comment renders sealed Issue-to-Proof observations without publishing issue or model text", async () => {
  const value = await receipt();
  value.issueToProof = {
    source: "pull_request",
    pullRequestTitle: "Fix duplicate settlement",
    linkedIssue: {
      number: 42,
      source: "pull_request_description",
      contentDigest: "sealed-digest",
      titleBytes: 32,
      bodyBytes: 120,
    },
    scenarioBindings: [{
      scenarioId: "must-not-render",
      obligationId: "issue-reproduction",
      kind: "base_fails_candidate_passes",
      pairedCheckId: "issue-reproduction",
      checkKind: "bug_reproduction",
      base: "fail",
      candidate: "pass",
      status: "satisfied",
      detail: "Model assertion and candidate command output must stay sealed.",
    }],
  };

  const rendered = renderEvidenceComment(value);

  assert.match(rendered, /Issue-to-Proof bindings/);
  assert.match(rendered, /#42/);
  assert.match(rendered, /issue-reproduction/);
  assert.match(rendered, /base fails; candidate passes/);
  assert.match(rendered, /fail → pass/);
  assert.doesNotMatch(rendered, /Fix duplicate settlement|must-not-render|Model assertion|candidate command output|sealed-digest/);
});

test("comment upsert edits only the current installation's managed comment", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    { id: 7 },
    [
      { id: 11, body: "<!-- mergeproof:managed --> old", user: { id: 8 } },
      { id: 12, body: "<!-- mergeproof:managed --> ours", user: { id: 7 } },
    ],
    { id: 12 },
  ];
  const gateway = new GitHubPullRequestCommentGateway(
    "comments-token",
    async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );
  await gateway.upsert({
    repository: "acme/checkout-service",
    pullRequest: 42,
    receipt: await receipt(),
  });
  assert.equal(calls[0]?.url, "https://api.github.com/user");
  assert.match(calls[1]?.url ?? "", /issues\/42\/comments/);
  assert.equal(calls[2]?.url, "https://api.github.com/repos/acme/checkout-service/issues/comments/12");
  assert.equal(calls[2]?.init?.method, "PATCH");
});

test("comment upsert creates a new comment instead of mutating a copied marker", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [{ id: 7 }, [{ id: 11, body: "<!-- mergeproof:managed --> copied", user: { id: 8 } }], { id: 13 }];
  const gateway = new GitHubPullRequestCommentGateway(
    "comments-token",
    async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(responses.shift()), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  );
  await gateway.upsert({
    repository: "acme/checkout-service",
    pullRequest: 42,
    receipt: await receipt(),
  });
  assert.equal(calls[2]?.url, "https://api.github.com/repos/acme/checkout-service/issues/42/comments");
  assert.equal(calls[2]?.init?.method, "POST");
});

test("comment upsert finds its managed comment after a full first page", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    body: "unmanaged",
    user: { id: 8 },
  }));
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses = [
    { id: 7 },
    firstPage,
    [{ id: 201, body: "<!-- mergeproof:managed --> ours", user: { id: 7 } }],
    { id: 201 },
  ];
  const gateway = new GitHubPullRequestCommentGateway(
    "comments-token",
    async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  );

  await gateway.upsert({ repository: "acme/checkout-service", pullRequest: 42, receipt: await receipt() });

  assert.match(calls[1]?.url ?? "", /page=1/);
  assert.match(calls[2]?.url ?? "", /page=2/);
  assert.equal(calls[3]?.url, "https://api.github.com/repos/acme/checkout-service/issues/comments/201");
  assert.equal(calls[3]?.init?.method, "PATCH");
});
