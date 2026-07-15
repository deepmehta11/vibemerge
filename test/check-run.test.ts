import assert from "node:assert/strict";
import test from "node:test";

import { GitHubCheckRunFailureCloser, GitHubCheckRunGateway } from "../src/check-run.js";
import { demoRevision, demoVerificationPolicy, safeFixture } from "../src/fixtures.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import { VerificationEngine } from "../src/verifier.js";

test("Check Run publisher reports a sealed merge result against the supplied SHA", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const gateway = new GitHubCheckRunGateway(
    "checks-token",
    async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify(calls.length === 1 ? { id: 77 } : {}),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    },
  );
  const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
    demoRevision,
    demoVerificationPolicy,
    new Date("2026-07-14T18:00:00.000Z"),
  );

  const created = await gateway.createInProgress({
    repository: "acme/checkout-service",
    headSha: "queue-sha-123",
    name: "MergeProof / evidence",
  });
  await gateway.complete({
    repository: "acme/checkout-service",
    checkRunId: created.id,
    receipt,
  });

  assert.equal(calls[0]?.url, "https://api.github.com/repos/acme/checkout-service/check-runs");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    name: "MergeProof / evidence",
    head_sha: "queue-sha-123",
    status: "in_progress",
    started_at: (JSON.parse(String(calls[0]?.init?.body)) as { started_at: string }).started_at,
    output: {
      title: "MergeProof is verifying this merge-group revision",
      summary: "Evidence collection is running in an isolated sandbox.",
    },
  });
  assert.equal(calls[1]?.url, "https://api.github.com/repos/acme/checkout-service/check-runs/77");
  const completed = JSON.parse(String(calls[1]?.init?.body)) as {
    conclusion: string;
    output: { text: string };
  };
  assert.equal(completed.conclusion, "success");
  assert.match(completed.output.text, new RegExp(receipt.integrityHash));

  await gateway.complete({
    repository: "acme/checkout-service",
    checkRunId: 78,
    receipt: {
      ...receipt,
      verdict: "BLOCK",
      reasons: [
        {
          code: "CHECK_FAILED",
          subject: "ci",
          detail: "Trusted CI gate. Command outcome: pass @untrusted-user [injected](https://bad.example)",
        },
      ],
    },
  });
  const blocked = JSON.parse(String(calls[2]?.init?.body)) as {
    conclusion: string;
    output: { summary: string };
  };
  assert.equal(blocked.conclusion, "failure");
  assert.match(blocked.output.summary, /Trusted CI gate/);
  assert.doesNotMatch(blocked.output.summary, /untrusted-user|bad\.example/);
});

test("interrupted Check Run recovery can only complete one known Check Run as failure", async () => {
  const tokenRequests: Array<{ permissions: Record<string, string> }> = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const closer = new GitHubCheckRunFailureCloser(
    {
      mint: async (request) => {
        tokenRequests.push({ permissions: request.permissions });
        return { token: "checks-recovery-token", expiresAt: "2026-07-14T19:00:00Z" };
      },
    },
    async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    },
  );

  await closer.completeAsFailure({
    operation: {
      operationId: "check_run_publish:run-42",
      runKey: "run-42",
      kind: "check_run_publish",
      installationId: 99,
      target: {
        repository: "acme/checkout-service",
        pullRequest: 42,
        expectedHeadSha: "queue-sha-123",
        checkName: "MergeProof / evidence",
      },
      expectation: {
        checkRunId: 77,
        checkRunExternalId: "check_run_publish:run-42",
        expectedCheckConclusion: "success",
      },
      state: "ambiguous",
      intentFenceToken: 1,
      reconciliationFenceToken: 1,
      createdAt: 1,
      updatedAt: 2,
      resolvedAt: null,
      evidence: null,
    },
    checkRunId: 77,
  });

  assert.deepEqual(tokenRequests, [{ permissions: { checks: "write" } }]);
  assert.equal(calls[0]?.url, "https://api.github.com/repos/acme/checkout-service/check-runs/77");
  assert.equal(calls[0]?.init?.method, "PATCH");
  const body = JSON.parse(String(calls[0]?.init?.body)) as {
    status: string;
    conclusion: string;
    output: { title: string; summary: string; text: string };
  };
  assert.deepEqual(
    { status: body.status, conclusion: body.conclusion },
    { status: "completed", conclusion: "failure" },
  );
  assert.match(body.output.summary, /fresh proof is required/i);
  assert.match(body.output.text, /check_run_publish:run-42/);
});
