import assert from "node:assert/strict";
import test from "node:test";

import type { CheckRunGateway } from "../src/check-run.js";
import { policyDigest, trustedArtifactDigestForPolicy } from "../src/controller.js";
import type { LivePullRequest, PinnedRevision } from "../src/domain.js";
import { demoMergePolicy, demoVerificationPolicy, safeFixture } from "../src/fixtures.js";
import { FixtureEvidenceHarness, type EvidenceHarnessFactory } from "../src/harness.js";
import type {
  InstallationToken,
  InstallationTokenProvider,
  InstallationTokenRequest,
} from "../src/github-app.js";
import { MergeGroupController } from "../src/merge-group-controller.js";
import { RunLedger } from "../src/ledger.js";
import { VerificationEngine } from "../src/verifier.js";

class RecordingTokens implements InstallationTokenProvider {
  readonly requests: InstallationTokenRequest[] = [];

  async mint(request: InstallationTokenRequest): Promise<InstallationToken> {
    this.requests.push(request);
    return { token: `token-${this.requests.length}`, expiresAt: "2026-07-14T19:00:00Z" };
  }
}

test("a durable operator pause prevents a new merge-group success signal", async () => {
  const ledger = new RunLedger();
  const tokens = new RecordingTokens();
  try {
    ledger.setAutomationPaused(true, 10);
    const result = await new MergeGroupController(
      {
        allowedRepositories: ["acme/checkout-service"],
        autoMergeEnabled: true,
        mergeStrategy: "merge_queue",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      { create: () => new FixtureEvidenceHarness(safeFixture()) },
      { create: () => { throw new Error("Check Run writes must not be reached while paused."); } },
      { create: () => { throw new Error("GitHub reads must not be reached while paused."); } },
      ledger,
    ).process({
      deliveryId: "merge-group-paused",
      installationId: 99,
      repository: "acme/checkout-service",
      repositoryId: 101,
      baseSha: "abcdef1",
      headSha: "1234567",
    });

    assert.deepEqual(result, {
      state: "ignored",
      reason: "MergeProof automatic merge is paused by an operator.",
    });
    assert.equal(tokens.requests.length, 0);
  } finally {
    ledger.close();
  }
});

test("merge-group controller publishes success only for the queue-generated exact revision", async () => {
  const policy = {
    allowedRepositories: ["acme/checkout-service"],
    autoMergeEnabled: true,
    mergeStrategy: "merge_queue" as const,
    verification: demoVerificationPolicy,
    merge: {
      ...demoMergePolicy,
      requiredCheckAppIds: { "ci / test": 41, "ci / security": 42 },
    },
  };
  const tokens = new RecordingTokens();
  const harnessInputs: Array<{ revision: PinnedRevision; githubReadToken: string }> = [];
  const harnesses: EvidenceHarnessFactory = {
    create: (input) => {
      harnessInputs.push(input);
      return new FixtureEvidenceHarness(safeFixture());
    },
  };
  const checkCalls: Array<{ kind: "start" | "complete"; value: unknown }> = [];
  const checks = {
    create: (): CheckRunGateway => ({
      createInProgress: async (input) => {
        checkCalls.push({ kind: "start", value: input });
        return { id: 7 };
      },
      complete: async (input) => {
        checkCalls.push({ kind: "complete", value: input });
      },
    }),
  };
  const ledger = new RunLedger();
  const trigger = {
    deliveryId: "merge-group-delivery",
    installationId: 99,
    repository: "acme/checkout-service",
    repositoryId: 101,
    baseSha: "abcdef1",
    headSha: "1234567",
  };
  try {
    const queuedRevision: PinnedRevision = {
      repository: trigger.repository,
      pullRequest: 42,
      baseSha: "abcdef1",
      headSha: "pr-head-42",
      mergeSha: "test-merge-42",
      policyHash: policyDigest(policy),
      trustedArtifactDigest: trustedArtifactDigestForPolicy(policy),
    };
    const queuedReceipt = await new VerificationEngine(
      new FixtureEvidenceHarness(safeFixture()),
    ).verify(queuedRevision, policy.verification, new Date("2026-07-14T18:00:00.000Z"));
    const queuedClaim = ledger.claim(
      queuedRevision,
      "seed-queued-pr",
      60_000,
      new Date("2026-07-14T18:00:00.000Z").getTime(),
    );
    assert.equal(queuedClaim.state, "claimed");
    if (queuedClaim.state !== "claimed") return;
    ledger.recordReceipt(queuedClaim.lease, queuedReceipt, new Date("2026-07-14T18:00:00.000Z").getTime());
    ledger.beginPublication(queuedClaim.lease, new Date("2026-07-14T18:00:00.000Z").getTime());
    ledger.markQueued(queuedClaim.lease, new Date("2026-07-14T18:00:00.000Z").getTime());
    const live: LivePullRequest = {
      nodeId: "PR_kwDOFixture42",
      repository: trigger.repository,
      pullRequest: 42,
      state: "open",
      draft: false,
      baseSha: queuedRevision.baseSha,
      headSha: queuedRevision.headSha,
      mergeSha: queuedRevision.mergeSha,
      title: "Safe queued pull request",
      description: "",
      diff: "",
      labels: ["mergeproof:auto"],
      approvals: 1,
      checks: [
        { name: "ci / test", status: "pass" },
        { name: "ci / security", status: "pass" },
      ],
    };
    const result = await new MergeGroupController(
      policy,
      tokens,
      harnesses,
      checks,
      {
        create: () => ({
          getPullRequestsForCommit: async () => [42],
          getPullRequest: async () => live,
        }),
      },
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    ).process(trigger);

    assert.equal(result.state, "reported");
    assert.equal(result.receipt.verdict, "LOW_OBSERVED_RISK");
    assert.deepEqual(tokens.requests.map((request) => request.permissions), [
      { contents: "read", pull_requests: "read", checks: "read" },
      { contents: "read" },
      { checks: "write" },
    ]);
    assert.deepEqual(harnessInputs.map((input) => ({
      baseSha: input.revision.baseSha,
      headSha: input.revision.headSha,
      mergeSha: input.revision.mergeSha,
      pullRequest: input.revision.pullRequest,
      token: input.githubReadToken,
    })), [{
      baseSha: "abcdef1",
      headSha: "1234567",
      mergeSha: "1234567",
      pullRequest: 0,
      token: "token-2",
    }]);
    assert.equal((checkCalls[0]?.value as { headSha: string }).headSha, "1234567");
    assert.match((checkCalls[0]?.value as { externalId?: string }).externalId ?? "", /^check_run_publish:/);
    assert.equal(
      (checkCalls[1]?.value as { receipt: { verdict: string } }).receipt.verdict,
      "LOW_OBSERVED_RISK",
    );
    const revision: PinnedRevision = {
      repository: trigger.repository,
      pullRequest: 0,
      baseSha: trigger.baseSha,
      headSha: trigger.headSha,
      mergeSha: trigger.headSha,
      policyHash: policyDigest(policy),
      trustedArtifactDigest: trustedArtifactDigestForPolicy(policy),
    };
    assert.equal(ledger.get(revision)?.status, "reported");
    const runKey = ledger.get(revision)?.runKey;
    assert.equal(
      ledger.getExternalOperation(`check_run_publish:${runKey}`)?.state,
      "observed_applied",
    );
  } finally {
    ledger.close();
  }
});

test("merge-group verification fails closed when GitHub associates an unverified PR", async () => {
  const policy = {
    allowedRepositories: ["acme/checkout-service"],
    autoMergeEnabled: true,
    mergeStrategy: "merge_queue" as const,
    verification: demoVerificationPolicy,
    merge: {
      ...demoMergePolicy,
      requiredCheckAppIds: { "ci / test": 41, "ci / security": 42 },
    },
  };
  const tokens = new RecordingTokens();
  const conclusions: Array<{ conclusion: string | undefined; summaryNote: string | undefined }> = [];
  const ledger = new RunLedger();
  try {
    const result = await new MergeGroupController(
      policy,
      tokens,
      { create: () => new FixtureEvidenceHarness(safeFixture()) },
      {
        create: (): CheckRunGateway => ({
          createInProgress: async () => ({ id: 7 }),
          complete: async (input) => {
            conclusions.push({ conclusion: input.conclusion, summaryNote: input.summaryNote });
          },
        }),
      },
      {
        create: () => ({
          getPullRequestsForCommit: async () => [42],
          getPullRequest: async () => {
            throw new Error("live PR must not be read without a queued receipt");
          },
        }),
      },
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    ).process({
      deliveryId: "merge-group-unverified-pr",
      installationId: 99,
      repository: "acme/checkout-service",
      repositoryId: 101,
      baseSha: "abcdef1",
      headSha: "1234567",
    });

    assert.equal(result.state, "reported");
    if (result.state !== "reported") return;
    assert.equal(result.receipt.verdict, "LOW_OBSERVED_RISK");
    assert.deepEqual(conclusions, [{
      conclusion: "failure",
      summaryNote: "Merge-group pull request #42 lacks a currently queued MergeProof receipt.",
    }]);
    assert.equal(
      ledger.get(result.receipt.revision)?.outcome,
      "NOT_ELIGIBLE",
    );
  } finally {
    ledger.close();
  }
});

test("merge-group verification fails closed when source-pinned branch protection drifts after queueing", async () => {
  const policy = {
    allowedRepositories: ["acme/checkout-service"],
    autoMergeEnabled: true,
    mergeStrategy: "merge_queue" as const,
    verification: demoVerificationPolicy,
    merge: {
      ...demoMergePolicy,
      requiredCheckAppIds: { "ci / test": 41, "ci / security": 42 },
    },
    requiredEvidenceCheck: { name: "MergeProof / evidence", appId: 777 },
  };
  const tokens = new RecordingTokens();
  const conclusions: Array<{ conclusion: string | undefined; summaryNote: string | undefined }> = [];
  const ledger = new RunLedger();
  const trigger = {
    deliveryId: "merge-group-protection-drift",
    installationId: 99,
    repository: "acme/checkout-service",
    repositoryId: 101,
    baseSha: "abcdef1",
    headSha: "1234567",
  };
  const queuedRevision: PinnedRevision = {
    repository: trigger.repository,
    pullRequest: 42,
    baseSha: trigger.baseSha,
    headSha: "pr-head-42",
    mergeSha: "test-merge-42",
    policyHash: policyDigest(policy),
    trustedArtifactDigest: trustedArtifactDigestForPolicy(policy),
  };
  const live: LivePullRequest = {
    nodeId: "PR_kwDOFixture42",
    repository: trigger.repository,
    pullRequest: 42,
    state: "open",
    draft: false,
    baseSha: queuedRevision.baseSha,
    baseRef: "main",
    headSha: queuedRevision.headSha,
    mergeSha: queuedRevision.mergeSha,
    title: "Safe queued pull request",
    description: "",
    diff: "",
    labels: ["mergeproof:auto"],
    approvals: 1,
    checks: [
      { name: "ci / test", status: "pass", appId: 41 },
      { name: "ci / security", status: "pass", appId: 42 },
    ],
  };
  try {
    const queuedReceipt = await new VerificationEngine(
      new FixtureEvidenceHarness(safeFixture()),
    ).verify(queuedRevision, policy.verification, new Date("2026-07-14T18:00:00.000Z"));
    const queuedClaim = ledger.claim(
      queuedRevision,
      "seed-queued-pr-protection-drift",
      60_000,
      new Date("2026-07-14T18:00:00.000Z").getTime(),
    );
    assert.equal(queuedClaim.state, "claimed");
    if (queuedClaim.state !== "claimed") return;
    ledger.recordReceipt(queuedClaim.lease, queuedReceipt, new Date("2026-07-14T18:00:00.000Z").getTime());
    ledger.beginPublication(queuedClaim.lease, new Date("2026-07-14T18:00:00.000Z").getTime());
    ledger.markQueued(queuedClaim.lease, new Date("2026-07-14T18:00:00.000Z").getTime());

    let protectionReads = 0;
    const result = await new MergeGroupController(
      policy,
      tokens,
      { create: () => new FixtureEvidenceHarness(safeFixture()) },
      {
        create: (): CheckRunGateway => ({
          createInProgress: async () => ({ id: 7 }),
          complete: async (input) => {
            conclusions.push({ conclusion: input.conclusion, summaryNote: input.summaryNote });
          },
        }),
      },
      {
        create: () => ({
          getPullRequestsForCommit: async () => [42],
          getPullRequest: async () => live,
          getRequiredStatusChecks: async () => {
            protectionReads += 1;
            return protectionReads === 1
              ? [
                  { name: "ci / test", appId: 41 },
                  { name: "ci / security", appId: 42 },
                  { name: "MergeProof / evidence", appId: 777 },
                ]
              : [
                  { name: "ci / test", appId: 41 },
                  { name: "ci / security", appId: 42 },
                ];
          },
        }),
      },
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    ).process(trigger);

    assert.equal(result.state, "reported");
    assert.equal(protectionReads, 2);
    assert.deepEqual(tokens.requests.map((request) => request.permissions), [
      { contents: "read", pull_requests: "read", checks: "read", administration: "read" },
      { contents: "read" },
      { checks: "write" },
    ]);
    assert.deepEqual(conclusions, [{
      conclusion: "failure",
      summaryNote: "GitHub branch protection does not require the source-pinned Check Run MergeProof / evidence from App 777.",
    }]);
    if (result.state !== "reported") return;
    assert.equal(ledger.get(result.receipt.revision)?.outcome, "NOT_ELIGIBLE");
  } finally {
    ledger.close();
  }
});
