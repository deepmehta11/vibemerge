import assert from "node:assert/strict";
import test from "node:test";

import {
  MergeProofController,
  commentFailureDiagnostic,
  policyDigest,
  trustedArtifactDigestForPolicy,
  type GitHubGatewayFactory,
} from "../src/controller.js";
import type { AgentAnalysis, LivePullRequest, PinnedRevision } from "../src/domain.js";
import {
  demoMergePolicy,
  demoVerificationPolicy,
  incompleteFixture,
  safeFixture,
} from "../src/fixtures.js";
import type {
  InstallationToken,
  InstallationTokenProvider,
  InstallationTokenRequest,
} from "../src/github-app.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import type { EvidenceHarnessFactory } from "../src/harness.js";
import { RunLedger } from "../src/ledger.js";
import { MemoryMergeGateway } from "../src/merge-broker.js";
import type { PlannerInput } from "../src/agent-planner.js";
import { ReconciliationWorker } from "../src/reconciliation-worker.js";
import type { ReadOnlyReconciliationReader } from "../src/reconciliation-resolver.js";
import { VerificationEngine } from "../src/verifier.js";

const trigger = {
  deliveryId: "delivery-controller",
  action: "synchronize" as const,
  installationId: 99,
  repository: "acme/checkout-service",
  repositoryId: 101,
  pullRequest: 42,
};

function live(overrides: Partial<LivePullRequest> = {}): LivePullRequest {
  return {
    nodeId: "PR_kwDOFixture42",
    repository: trigger.repository,
    pullRequest: trigger.pullRequest,
    state: "open",
    draft: false,
    baseSha: "base-controller",
    headSha: "head-controller",
    mergeSha: "merge-controller",
    title: "Prevent duplicate checkout settlement",
    description: "Fixture PR for controller tests.",
    diff: "diff --git a/checkout.ts b/checkout.ts\n+// fixture diff",
    labels: ["mergeproof:auto"],
    approvals: 1,
    checks: [
      { name: "ci / test", status: "pass" },
      { name: "ci / security", status: "pass" },
    ],
    ...overrides,
  };
}

class RecordingTokens implements InstallationTokenProvider {
  readonly requests: InstallationTokenRequest[] = [];

  async mint(request: InstallationTokenRequest): Promise<InstallationToken> {
    this.requests.push(request);
    return { token: `token-${this.requests.length}`, expiresAt: "2026-07-14T19:00:00Z" };
  }
}

test("comment publication diagnostics expose only a fixed stage and status", () => {
  assert.deepEqual(
    commentFailureDiagnostic(new Error("GitHub installation token request 403: omitted")),
    { stage: "token_mint", status: "403" },
  );
  assert.deepEqual(
    commentFailureDiagnostic(new Error("GitHub PR comment API create 403: omitted")),
    { stage: "comment_create", status: "403" },
  );
  assert.deepEqual(
    commentFailureDiagnostic(new Error("candidate-controlled detail must not be logged")),
    { stage: "comment_gateway", status: "unknown" },
  );
});

test("a durable operator pause blocks a PR before token minting or sandbox work", async () => {
  const tokens = new RecordingTokens();
  const ledger = new RunLedger();
  try {
    ledger.setAutomationPaused(true, 10);
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "direct_fixture",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      {
        createReadGateway: () => ({ getPullRequest: async () => live() }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
      },
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
    ).process(trigger);

    assert.deepEqual(result, {
      state: "not_eligible",
      reason: "MergeProof automatic merge is paused by an operator.",
    });
    assert.equal(tokens.requests.length, 0);
  } finally {
    ledger.close();
  }
});

test("a pause that lands during evidence prevents all later PR write actions", async () => {
  const tokens = new RecordingTokens();
  const ledger = new RunLedger();
  const fixture = new FixtureEvidenceHarness(safeFixture());
  const mergeGateway = new MemoryMergeGateway(live());
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "direct_fixture",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      {
        createReadGateway: () => ({ getPullRequest: async () => live() }),
        createMergeGateway: () => mergeGateway,
      },
      {
        kind: "fixture",
        collect: async (input) => {
          const result = await fixture.collect(input);
          ledger.setAutomationPaused(true, 20);
          return result;
        },
      },
      ledger,
    ).process(trigger);

    assert.equal(result.state, "not_merged");
    assert.equal(mergeGateway.mergeCalls, 0);
    assert.deepEqual(tokens.requests.map((request) => request.permissions), [
      { contents: "read", pull_requests: "read", checks: "read" },
    ]);
  } finally {
    ledger.close();
  }
});

test("controller independently reloads state and mints write permission only for an eligible merge", async () => {
  const tokens = new RecordingTokens();
  const mergeGateway = new MemoryMergeGateway(live());
  const factory: GitHubGatewayFactory = {
    createReadGateway: () => ({ getPullRequest: async () => live() }),
    createMergeGateway: () => mergeGateway,
  };
  const ledger = new RunLedger();
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "direct_fixture",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      factory,
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    ).process(trigger);

    assert.equal(result.state, "merged");
    assert.equal(mergeGateway.mergeCalls, 1);
    assert.deepEqual(tokens.requests.map((request) => request.permissions), [
      { contents: "read", pull_requests: "read", checks: "read" },
      { contents: "write", pull_requests: "read" },
    ]);
  } finally {
    ledger.close();
  }
});

test("GitHub API strategy needs no branch protection while preserving exact live Check Run gates", async () => {
  const tokens = new RecordingTokens();
  const requiredEvidenceCheck = { name: "MergeProof / evidence", appId: 777 };
  const sourcePinnedChecks = [
    { name: "ci / test", status: "pass" as const, appId: 41 },
    { name: "ci / security", status: "pass" as const, appId: 42 },
  ];
  const mergeGateway = new MemoryMergeGateway(live({
    checks: [...sourcePinnedChecks, { ...requiredEvidenceCheck, status: "pass" as const }],
  }));
  const checkWrites: string[] = [];
  const commentReasons: Array<string | undefined> = [];
  const ledger = new RunLedger();
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "github_api",
        verification: demoVerificationPolicy,
        merge: {
          ...demoMergePolicy,
          requiredCheckAppIds: { "ci / test": 41, "ci / security": 42 },
        },
        requiredEvidenceCheck,
      },
      tokens,
      {
        createReadGateway: () => ({
          // Direct API mode validates the App IDs on live PR Check Runs and
          // must not depend on branch protection or the Administration API.
          getPullRequest: async () => live({ checks: sourcePinnedChecks }),
        }),
        createMergeGateway: () => mergeGateway,
        createCheckRunGateway: () => ({
          createInProgress: async () => {
            checkWrites.push("created");
            return { id: 5 };
          },
          complete: async () => {
            checkWrites.push("completed");
          },
        }),
        createCommentGateway: () => ({
          upsert: async (input) => {
            commentReasons.push(input.eligibilityReason);
          },
        }),
      },
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    ).process(trigger);

    assert.equal(result.state, "merged");
    assert.equal(mergeGateway.mergeCalls, 1);
    assert.deepEqual(checkWrites, ["created", "completed"]);
    assert.deepEqual(commentReasons, ["Merged by MergeProof fixture gateway."]);
    assert.deepEqual(tokens.requests.map((request) => request.permissions), [
      { contents: "read", pull_requests: "read", checks: "read" },
      { contents: "read", pull_requests: "read", checks: "read" },
      { checks: "write" },
      { contents: "write", pull_requests: "read", checks: "read" },
      { pull_requests: "write" },
    ]);
  } finally {
    ledger.close();
  }
});

test("incomplete proof never receives a write token", async () => {
  const tokens = new RecordingTokens();
  const factory: GitHubGatewayFactory = {
    createReadGateway: () => ({ getPullRequest: async () => live() }),
    createMergeGateway: () => new MemoryMergeGateway(live()),
  };
  const ledger = new RunLedger();
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "direct_fixture",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      factory,
      new FixtureEvidenceHarness(incompleteFixture()),
      ledger,
    ).process(trigger);

    assert.equal(result.state, "verified");
    assert.equal(result.receipt.verdict, "REVIEW");
    assert.equal(tokens.requests.length, 1);
  } finally {
    ledger.close();
  }
});

test("a configured Issue-to-Proof planner outage cannot receive a merge write token", async () => {
  const tokens = new RecordingTokens();
  const factory: GitHubGatewayFactory = {
    createReadGateway: () => ({
      getPullRequest: async () => live({ description: "Fixes #42. Fixture PR for controller tests." }),
    }),
    createMergeGateway: () => new MemoryMergeGateway(live()),
  };
  const ledger = new RunLedger();
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "direct_fixture",
        verification: {
          ...demoVerificationPolicy,
          issueToProof: {
            requireLinkedIssue: true,
            requiredObligationIds: ["issue-reproduction", "checkout-invariants"],
          },
        },
        merge: demoMergePolicy,
      },
      tokens,
      factory,
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
      undefined,
      {
        analyze: async () => {
          throw new Error("OpenAI planner service is unavailable.");
        },
      },
    ).process(trigger);

    assert.equal(result.state, "verified");
    if (result.state !== "verified") return;
    assert.equal(result.receipt.deterministicVerdict, "LOW_OBSERVED_RISK");
    assert.equal(result.receipt.verdict, "REVIEW");
    assert.equal(result.receipt.agentAnalysis.status, "unavailable");
    assert.equal(tokens.requests.length, 1);
  } finally {
    ledger.close();
  }
});

test("controller retrieves canonical linked issue data with read-only scope and seals only its digest", async () => {
  const tokens = new RecordingTokens();
  const issueTitle = "Duplicate settlement must be prevented";
  const issueBody = "Canonical issue body stays transient and must not enter the receipt.";
  let issueReads = 0;
  let plannerInput: PlannerInput | undefined;
  const planner = {
    analyze: async (input: PlannerInput): Promise<AgentAnalysis> => {
      plannerInput = input;
      return {
        status: "completed",
        hypotheses: [],
        challenges: [],
        issueToProofPlan: {
          schemaVersion: 1,
          issueNumber: 42,
          scenarios: [
            {
              id: "reproduce-duplicate",
              obligationId: "issue-reproduction",
              kind: "base_fails_candidate_passes",
              assertion: "Trusted reproduction changes from failing to passing.",
            },
            {
              id: "preserve-checkout",
              obligationId: "checkout-invariants",
              kind: "both_revisions_pass",
              assertion: "Protected checkout behavior passes on both revisions.",
            },
            {
              id: "race-case",
              obligationId: "duplicate-race",
              kind: "both_revisions_pass",
              assertion: "Concurrent duplicate requests pass on both revisions.",
            },
          ],
          limitation: "Trusted probes remain the only evidence authority.",
        },
      };
    },
  };
  const ledger = new RunLedger();
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: false,
        mergeStrategy: "direct_fixture",
        verification: {
          ...demoVerificationPolicy,
          issueToProof: {
            requireLinkedIssue: true,
            requiredObligationIds: ["issue-reproduction", "checkout-invariants", "duplicate-race"],
          },
        },
        merge: demoMergePolicy,
      },
      tokens,
      {
        createReadGateway: () => ({
          getPullRequest: async () => live({ description: "Fixes #42. Fixture PR for controller tests." }),
          getIssue: async () => {
            issueReads += 1;
            return { number: 42, title: issueTitle, body: issueBody, isPullRequest: false };
          },
        }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
      },
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
      undefined,
      planner,
    ).process(trigger);

    assert.equal(result.state, "verified");
    if (result.state !== "verified") return;
    assert.equal(result.receipt.verdict, "LOW_OBSERVED_RISK");
    assert.equal(issueReads, 1);
    assert.deepEqual(tokens.requests[0]?.permissions, {
      contents: "read",
      pull_requests: "read",
      checks: "read",
      issues: "read",
    });
    assert.equal(plannerInput?.linkedIssueContext?.title, issueTitle);
    assert.equal(plannerInput?.linkedIssueContext?.body, issueBody);
    assert.equal(
      result.receipt.revision.issueContextDigest,
      result.receipt.issueToProof.linkedIssue?.contentDigest,
    );
    const sealedReceipt = JSON.stringify(result.receipt);
    assert.equal(sealedReceipt.includes(issueTitle), false);
    assert.equal(sealedReceipt.includes(issueBody), false);
  } finally {
    ledger.close();
  }
});

test("merge-queue strategy enqueues only a sealed low-risk exact head", async () => {
  const tokens = new RecordingTokens();
  const enqueues: Array<{ pullRequestNodeId: string; expectedHeadSha: string }> = [];
  const checkRuns: Array<{ headSha: string; externalId?: string; verdict?: string }> = [];
  const comments: string[] = [];
  const ledger = new RunLedger();
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "merge_queue",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      {
        createReadGateway: () => ({ getPullRequest: async () => live() }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
        createQueueGateway: () => ({
          enqueue: async (input) => {
            enqueues.push({
              pullRequestNodeId: input.pullRequestNodeId,
              expectedHeadSha: input.expectedHeadSha,
            });
            return { message: "queued" };
          },
        }),
        createCheckRunGateway: () => ({
          createInProgress: async (input) => {
            checkRuns.push({
              headSha: input.headSha,
              ...(input.externalId ? { externalId: input.externalId } : {}),
            });
            return { id: 5 };
          },
          complete: async (input) => {
            checkRuns[0]!.verdict = input.receipt.verdict;
          },
        }),
        createCommentGateway: () => ({
          upsert: async (input) => {
            comments.push(input.receipt.verdict);
          },
        }),
      },
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    ).process(trigger);

    assert.equal(result.state, "queued");
    assert.deepEqual(enqueues, [{ pullRequestNodeId: "PR_kwDOFixture42", expectedHeadSha: "head-controller" }]);
    assert.deepEqual(checkRuns, [{
      headSha: "head-controller",
      externalId: `check_run_publish:${result.receipt.runKey}`,
      verdict: "LOW_OBSERVED_RISK",
    }]);
    assert.deepEqual(comments, ["LOW_OBSERVED_RISK"]);
    assert.equal(
      ledger.getExternalOperation(`check_run_publish:${result.receipt.runKey}`)?.state,
      "observed_applied",
    );
    assert.equal(
      ledger.getExternalOperation(`merge_queue_enqueue:${result.receipt.runKey}`)?.state,
      "intent_recorded",
    );
    assert.deepEqual(tokens.requests.map((request) => request.permissions), [
      { contents: "read", pull_requests: "read", checks: "read" },
      { contents: "read", pull_requests: "read", checks: "read" },
      { checks: "write" },
      { pull_requests: "write" },
      { pull_requests: "write" },
    ]);
  } finally {
    ledger.close();
  }
});

test("a recovered green PR-head Check Run reruns evidence before its first queue enqueue", async () => {
  const tokens = new RecordingTokens();
  const enqueues: Array<{ pullRequestNodeId: string; expectedHeadSha: string }> = [];
  const checkCreates: string[] = [];
  const ledger = new RunLedger();
  const policy = {
    allowedRepositories: [trigger.repository],
    autoMergeEnabled: true,
    mergeStrategy: "merge_queue" as const,
    verification: demoVerificationPolicy,
    merge: demoMergePolicy,
  };
  const initialLive = live();
  const revision: PinnedRevision = {
    repository: trigger.repository,
    pullRequest: trigger.pullRequest,
    baseSha: initialLive.baseSha,
    headSha: initialLive.headSha,
    mergeSha: initialLive.mergeSha ?? initialLive.headSha,
    policyHash: policyDigest(policy),
    trustedArtifactDigest: trustedArtifactDigestForPolicy(policy),
  };
  try {
    const interrupted = ledger.claim(revision, "interrupted-publisher", 1_000, 10);
    assert.equal(interrupted.state, "claimed");
    if (interrupted.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      revision,
      policy.verification,
      new Date(10),
      {
        title: initialLive.title,
        description: initialLive.description,
        diff: initialLive.diff,
      },
    );
    ledger.recordReceipt(interrupted.lease, receipt, 11);
    ledger.beginPublication(interrupted.lease, 12);
    const checkOperationId = `check_run_publish:${receipt.runKey}`;
    ledger.prepareExternalOperation(interrupted.lease, {
      operationId: checkOperationId,
      kind: "check_run_publish",
      installationId: trigger.installationId,
      target: {
        repository: trigger.repository,
        pullRequest: trigger.pullRequest,
        expectedHeadSha: revision.headSha,
        checkName: "MergeProof / evidence",
      },
      expectation: {
        pullRequestNodeId: initialLive.nodeId,
        checkRunExternalId: checkOperationId,
        expectedCheckConclusion: "success",
      },
    }, 13);
    const reader: ReadOnlyReconciliationReader = {
      async observeMergeQueue() {
        throw new Error("Unexpected queue read.");
      },
      async observeDirectMerge() {
        throw new Error("Unexpected merge read.");
      },
      async observeCheckRun(input) {
        return {
          kind: "check_run_publish",
          target: input.target,
          expectation: input.expectation,
          state: "published",
          checkRunId: 5,
        };
      },
    };
    const recovery = new ReconciliationWorker(ledger, reader, "recovery-worker", () => 2_000);
    assert.deepEqual(await recovery.processNext(), {
      state: "observed_applied",
      operationId: checkOperationId,
    });
    // Recovery has no queue write capability and therefore cannot enqueue.
    assert.equal(enqueues.length, 0);

    const result = await new MergeProofController(
      policy,
      tokens,
      {
        createReadGateway: () => ({ getPullRequest: async () => live() }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
        createQueueGateway: () => ({
          enqueue: async (input) => {
            enqueues.push({
              pullRequestNodeId: input.pullRequestNodeId,
              expectedHeadSha: input.expectedHeadSha,
            });
            return { message: "queued after fresh evidence" };
          },
        }),
        createCheckRunGateway: () => ({
          createInProgress: async () => {
            checkCreates.push("unexpected republish");
            return { id: 99 };
          },
          complete: async () => {
            throw new Error("Recovered successful Check Run must not be republished.");
          },
        }),
      },
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    ).process(trigger);

    assert.equal(result.state, "queued");
    assert.deepEqual(checkCreates, []);
    assert.deepEqual(enqueues, [{
      pullRequestNodeId: initialLive.nodeId,
      expectedHeadSha: initialLive.headSha,
    }]);
    assert.equal(ledger.getExternalOperation(checkOperationId)?.state, "observed_applied");
    assert.equal(
      ledger.getExternalOperation(`merge_queue_enqueue:${result.receipt.runKey}`)?.state,
      "intent_recorded",
    );
  } finally {
    ledger.close();
  }
});

test("a review PR-head result is published as a journaled failure Check Run", async () => {
  const tokens = new RecordingTokens();
  const ledger = new RunLedger();
  const checkCreates: Array<{ externalId?: string }> = [];
  const conclusions: Array<string | undefined> = [];
  const enqueues: string[] = [];
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "merge_queue",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      {
        createReadGateway: () => ({ getPullRequest: async () => live() }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
        createQueueGateway: () => ({
          enqueue: async () => {
            enqueues.push("unexpected");
            return { message: "unexpected" };
          },
        }),
        createCheckRunGateway: () => ({
          createInProgress: async (input) => {
            checkCreates.push({ ...(input.externalId ? { externalId: input.externalId } : {}) });
            return { id: 6 };
          },
          complete: async (input) => {
            conclusions.push(input.conclusion);
          },
        }),
      },
      new FixtureEvidenceHarness(incompleteFixture()),
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    ).process(trigger);

    assert.equal(result.state, "not_merged");
    if (result.state !== "not_merged") return;
    assert.equal(result.receipt.verdict, "REVIEW");
    assert.deepEqual(enqueues, []);
    const operationId = `check_run_publish:${result.receipt.runKey}`;
    assert.deepEqual(checkCreates, [{ externalId: operationId }]);
    assert.deepEqual(conclusions, ["failure"]);
    assert.deepEqual(
      {
        state: ledger.getExternalOperation(operationId)?.state,
        conclusion: ledger.getExternalOperation(operationId)?.expectation.expectedCheckConclusion,
        status: ledger.get(result.receipt.revision)?.status,
        outcome: ledger.get(result.receipt.revision)?.outcome,
      },
      { state: "observed_applied", conclusion: "failure", status: "verified", outcome: "NOT_ELIGIBLE" },
    );
  } finally {
    ledger.close();
  }
});

test("a failed explanatory comment cannot strand an already queued revision", async () => {
  const tokens = new RecordingTokens();
  const ledger = new RunLedger();
  const enqueues: string[] = [];
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "merge_queue",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      {
        createReadGateway: () => ({ getPullRequest: async () => live() }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
        createQueueGateway: () => ({
          enqueue: async () => {
            enqueues.push("queued");
            return { message: "queued" };
          },
        }),
        createCheckRunGateway: () => ({
          createInProgress: async () => ({ id: 5 }),
          complete: async () => undefined,
        }),
        createCommentGateway: () => ({
          upsert: async () => {
            throw new Error("GitHub comment endpoint unavailable");
          },
        }),
      },
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    ).process(trigger);

    assert.equal(result.state, "queued");
    if (result.state !== "queued") return;
    assert.deepEqual(enqueues, ["queued"]);
    assert.equal(ledger.get(result.receipt.revision)?.status, "queued");
    assert.equal(ledger.getExternalOperation(`merge_queue_enqueue:${result.receipt.runKey}`)?.state, "intent_recorded");
  } finally {
    ledger.close();
  }
});

test("merge-queue rechecks every configured live merge requirement before enqueueing", async () => {
  const scenarios: Array<{ name: string; overrides: Partial<LivePullRequest>; reason: RegExp }> = [
    { name: "approval", overrides: { approvals: 0 }, reason: /Required approvals/ },
    { name: "label", overrides: { labels: [] }, reason: /Required label/ },
  ];

  for (const scenario of scenarios) {
    const tokens = new RecordingTokens();
    const enqueues: string[] = [];
    const conclusions: Array<string | undefined> = [];
    const commentReasons: Array<string | undefined> = [];
    let reads = 0;
    const ledger = new RunLedger();
    try {
      const result = await new MergeProofController(
        {
          allowedRepositories: [trigger.repository],
          autoMergeEnabled: true,
          mergeStrategy: "merge_queue",
          verification: demoVerificationPolicy,
          merge: demoMergePolicy,
        },
        tokens,
        {
          createReadGateway: () => ({
            // The initial CI gate must be eligible before running E2B; this
            // test specifically exercises the later exact-head preflight.
            getPullRequest: async () => live(++reads === 1 && scenario.name === "check" ? {} : scenario.overrides),
          }),
          createMergeGateway: () => new MemoryMergeGateway(live()),
          createQueueGateway: () => ({
            enqueue: async () => {
              enqueues.push(scenario.name);
              return { message: "queued" };
            },
          }),
          createCheckRunGateway: () => ({
            createInProgress: async () => ({ id: 5 }),
            complete: async (input) => {
              conclusions.push(input.conclusion);
            },
          }),
          createCommentGateway: () => ({
            upsert: async (input) => {
              commentReasons.push(input.eligibilityReason);
            },
          }),
        },
        new FixtureEvidenceHarness(safeFixture()),
        ledger,
        () => new Date("2026-07-14T18:00:00.000Z"),
      ).process(trigger);

      assert.equal(result.state, "not_merged", scenario.name);
      if (result.state !== "not_merged") continue;
      assert.equal(result.decision.outcome, "NOT_ELIGIBLE");
      assert.match(result.decision.reason, scenario.reason);
      assert.deepEqual(enqueues, []);
      assert.deepEqual(conclusions, ["failure"]);
      assert.equal(commentReasons.length, 1);
      assert.match(commentReasons[0] ?? "", scenario.reason);
      assert.equal(ledger.listRuns().runs[0]?.decision?.state, "not_eligible");
    } finally {
      ledger.close();
    }
  }
});

test("a locally queued PR is revoked when GitHub no longer reports its exact queue entry", async () => {
  const tokens = new RecordingTokens();
  const ledger = new RunLedger();
  const enqueues: string[] = [];
  const dequeues: string[] = [];
  const comments: Array<string | undefined> = [];
  const controller = new MergeProofController(
    {
      allowedRepositories: [trigger.repository],
      autoMergeEnabled: true,
      mergeStrategy: "merge_queue",
      verification: demoVerificationPolicy,
      merge: demoMergePolicy,
    },
    tokens,
    {
      createReadGateway: () => ({ getPullRequest: async () => live() }),
      createMergeGateway: () => new MemoryMergeGateway(live()),
      createQueueGateway: () => ({
        enqueue: async () => {
          enqueues.push("enqueue");
          return { message: "queued" };
        },
        dequeue: async () => {
          dequeues.push("dequeue");
          return { message: "removed" };
        },
        observeQueuedPullRequest: async () => ({ state: "not_queued" as const }),
      }),
      createCheckRunGateway: () => ({
        createInProgress: async () => ({ id: 5 }),
        complete: async () => undefined,
      }),
      createCommentGateway: () => ({
        upsert: async (input) => {
          comments.push(input.eligibilityReason);
        },
      }),
    },
    new FixtureEvidenceHarness(safeFixture()),
    ledger,
    () => new Date("2026-07-14T18:00:00.000Z"),
  );
  try {
    const queued = await controller.process(trigger);
    assert.equal(queued.state, "queued");
    if (queued.state !== "queued") return;

    const result = await controller.process({
      ...trigger,
      deliveryId: "delivery-queue-entry-removed",
      action: "labeled",
    });

    assert.deepEqual(result, {
      state: "not_eligible",
      reason: "GitHub no longer reports the exact pinned PR revision in its merge queue.",
    });
    assert.deepEqual(enqueues, ["enqueue"]);
    assert.deepEqual(dequeues, []);
    assert.equal(ledger.get(queued.receipt.revision)?.status, "verified");
    assert.equal(ledger.get(queued.receipt.revision)?.outcome, "NOT_ELIGIBLE");
    assert.match(comments.at(-1) ?? "", /GitHub no longer reports the exact pinned PR revision/i);
    assert.ok(
      tokens.requests.some(
        (request) =>
          request.permissions.pull_requests === "read" && request.permissions.merge_queues === "read",
      ),
    );
  } finally {
    ledger.close();
  }
});

test("an unavailable queue-membership observation never treats a queued receipt as completed", async () => {
  const tokens = new RecordingTokens();
  const ledger = new RunLedger();
  const enqueues: string[] = [];
  const controller = new MergeProofController(
    {
      allowedRepositories: [trigger.repository],
      autoMergeEnabled: true,
      mergeStrategy: "merge_queue",
      verification: demoVerificationPolicy,
      merge: demoMergePolicy,
    },
    tokens,
    {
      createReadGateway: () => ({ getPullRequest: async () => live() }),
      createMergeGateway: () => new MemoryMergeGateway(live()),
      createQueueGateway: () => ({
        enqueue: async () => {
          enqueues.push("enqueue");
          return { message: "queued" };
        },
        observeQueuedPullRequest: async () => {
          throw new Error("GitHub merge-queue read unavailable");
        },
      }),
      createCheckRunGateway: () => ({
        createInProgress: async () => ({ id: 5 }),
        complete: async () => undefined,
      }),
    },
    new FixtureEvidenceHarness(safeFixture()),
    ledger,
    () => new Date("2026-07-14T18:00:00.000Z"),
  );
  try {
    const queued = await controller.process(trigger);
    assert.equal(queued.state, "queued");
    if (queued.state !== "queued") return;

    const result = await controller.process({
      ...trigger,
      deliveryId: "delivery-queue-observation-unavailable",
      action: "labeled",
    });

    assert.deepEqual(result, { state: "reconciliation_required" });
    assert.deepEqual(enqueues, ["enqueue"]);
    assert.equal(ledger.get(queued.receipt.revision)?.status, "queued");
  } finally {
    ledger.close();
  }
});

test("a queued exact revision is removed when a later review, label, or CI state invalidates live policy", async () => {
  const tokens = new RecordingTokens();
  const ledger = new RunLedger();
  let current = live();
  const enqueues: string[] = [];
  const dequeues: Array<{ pullRequestNodeId: string }> = [];
  const checkRuns: string[] = [];
  const commentReasons: Array<string | undefined> = [];
  const controller = new MergeProofController(
    {
      allowedRepositories: [trigger.repository],
      autoMergeEnabled: true,
      mergeStrategy: "merge_queue",
      verification: demoVerificationPolicy,
      merge: demoMergePolicy,
    },
    tokens,
    {
      createReadGateway: () => ({ getPullRequest: async () => current }),
      createMergeGateway: () => new MemoryMergeGateway(current),
      createQueueGateway: () => ({
        enqueue: async () => {
          enqueues.push("enqueue");
          return { message: "queued" };
        },
        dequeue: async (input) => {
          dequeues.push({ pullRequestNodeId: input.pullRequestNodeId });
          return { message: "removed" };
        },
      }),
      createCheckRunGateway: () => ({
        createInProgress: async () => ({ id: 5 }),
        complete: async () => {
          checkRuns.push("reported");
        },
      }),
      createCommentGateway: () => ({
        upsert: async (input) => {
          commentReasons.push(input.eligibilityReason);
        },
      }),
    },
    new FixtureEvidenceHarness(safeFixture()),
    ledger,
    () => new Date("2026-07-14T18:00:00.000Z"),
  );
  try {
    const queued = await controller.process(trigger);
    assert.equal(queued.state, "queued");
    if (queued.state !== "queued") return;
    assert.deepEqual(enqueues, ["enqueue"]);
    assert.deepEqual(checkRuns, ["reported"]);

    current = live({ approvals: 0 });
    const revoked = await controller.process({
      ...trigger,
      deliveryId: "delivery-review-dismissed-after-queue",
      action: "review_dismissed",
    });
    assert.deepEqual(revoked, {
      state: "not_eligible",
      reason: "Removed from GitHub merge queue: Required approvals are not present.",
    });
    assert.deepEqual(dequeues, [{ pullRequestNodeId: "PR_kwDOFixture42" }]);
    assert.equal(ledger.get(queued.receipt.revision)?.status, "verified");
    assert.equal(ledger.get(queued.receipt.revision)?.outcome, "NOT_ELIGIBLE");
    assert.deepEqual(enqueues, ["enqueue"]);
    assert.match(
      commentReasons.at(-1) ?? "",
      /Removed from GitHub merge queue: Required approvals are not present/i,
    );
  } finally {
    ledger.close();
  }
});

test("a queued revision is removed when GitHub reports it closed or converted to draft", async () => {
  for (const scenario of [
    { action: "closed" as const, liveState: live({ state: "closed" as const }) },
    { action: "converted_to_draft" as const, liveState: live({ draft: true }) },
  ]) {
    const tokens = new RecordingTokens();
    const ledger = new RunLedger();
    let current = live();
    const dequeues: string[] = [];
    const controller = new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "merge_queue",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      {
        createReadGateway: () => ({ getPullRequest: async () => current }),
        createMergeGateway: () => new MemoryMergeGateway(current),
        createQueueGateway: () => ({
          enqueue: async () => ({ message: "queued" }),
          dequeue: async (input) => {
            dequeues.push(input.pullRequestNodeId);
            return { message: "removed" };
          },
        }),
        createCheckRunGateway: () => ({
          createInProgress: async () => ({ id: 5 }),
          complete: async () => undefined,
        }),
        createCommentGateway: () => ({ upsert: async () => undefined }),
      },
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    );
    try {
      const queued = await controller.process(trigger);
      assert.equal(queued.state, "queued", scenario.action);
      current = scenario.liveState;
      const revoked = await controller.process({
        ...trigger,
        deliveryId: `delivery-${scenario.action}-after-queue`,
        action: scenario.action,
      });
      assert.deepEqual(revoked, {
        state: "not_eligible",
        reason: "Removed from GitHub merge queue: Pull request is closed or draft.",
      });
      assert.deepEqual(dequeues, ["PR_kwDOFixture42"]);
    } finally {
      ledger.close();
    }
  }
});

test("a queued PR with a changed pinned revision is dequeued before fresh proof can enqueue it again", async () => {
  const tokens = new RecordingTokens();
  const ledger = new RunLedger();
  let current = live();
  const enqueues: string[] = [];
  const dequeues: Array<{ pullRequestNodeId: string }> = [];
  const controller = new MergeProofController(
    {
      allowedRepositories: [trigger.repository],
      autoMergeEnabled: true,
      mergeStrategy: "merge_queue",
      verification: demoVerificationPolicy,
      merge: demoMergePolicy,
    },
    tokens,
    {
      createReadGateway: () => ({ getPullRequest: async () => current }),
      createMergeGateway: () => new MemoryMergeGateway(current),
      createQueueGateway: () => ({
        enqueue: async () => {
          enqueues.push("enqueue");
          return { message: "queued" };
        },
        dequeue: async (input) => {
          dequeues.push({ pullRequestNodeId: input.pullRequestNodeId });
          return { message: "removed" };
        },
      }),
      createCheckRunGateway: () => ({
        createInProgress: async () => ({ id: 5 }),
        complete: async () => undefined,
      }),
      createCommentGateway: () => ({ upsert: async () => undefined }),
    },
    new FixtureEvidenceHarness(safeFixture()),
    ledger,
    () => new Date("2026-07-14T18:00:00.000Z"),
  );
  try {
    const initial = await controller.process(trigger);
    assert.equal(initial.state, "queued");
    if (initial.state !== "queued") return;

    current = live({ headSha: "head-controller-next", mergeSha: "merge-controller-next" });
    const fresh = await controller.process({
      ...trigger,
      deliveryId: "delivery-synchronize-after-queue",
      action: "synchronize",
    });

    assert.equal(fresh.state, "queued");
    if (fresh.state !== "queued") return;
    assert.deepEqual(dequeues, [{ pullRequestNodeId: "PR_kwDOFixture42" }]);
    assert.deepEqual(enqueues, ["enqueue", "enqueue"]);
    assert.equal(ledger.get(initial.receipt.revision)?.outcome, "NOT_ELIGIBLE");
    assert.equal(fresh.receipt.revision.headSha, "head-controller-next");
  } finally {
    ledger.close();
  }
});

test("production evidence-check policy refuses to enqueue until branch protection pins the final MergeProof App Check Run", async () => {
  const tokens = new RecordingTokens();
  const enqueues: string[] = [];
  const conclusions: Array<string | undefined> = [];
  const ledger = new RunLedger();
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "merge_queue",
        verification: demoVerificationPolicy,
        merge: {
          ...demoMergePolicy,
          requiredCheckAppIds: { "ci / test": 41, "ci / security": 42 },
        },
        requiredEvidenceCheck: { name: "MergeProof / evidence", appId: 777 },
      },
      tokens,
      {
        createReadGateway: () => ({
          getPullRequest: async () => live({
            baseRef: "main",
            checks: [
              { name: "ci / test", status: "pass", appId: 41 },
              { name: "ci / security", status: "pass", appId: 42 },
            ],
          }),
          // An exact name from the wrong App must not satisfy the safety gate.
          getRequiredStatusChecks: async () => [
            { name: "ci / test", appId: 41 },
            { name: "ci / security", appId: 42 },
            { name: "MergeProof / evidence", appId: 7 },
          ],
        }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
        createQueueGateway: () => ({
          enqueue: async () => {
            enqueues.push("enqueue");
            return { message: "queued" };
          },
        }),
        createCheckRunGateway: () => ({
          createInProgress: async () => ({ id: 5 }),
          complete: async (input) => {
            conclusions.push(input.conclusion);
          },
        }),
        createCommentGateway: () => ({ upsert: async () => undefined }),
      },
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    ).process(trigger);

    assert.equal(result.state, "not_merged");
    if (result.state !== "not_merged") return;
    assert.match(result.decision.reason, /branch protection does not require/i);
    assert.deepEqual(enqueues, []);
    assert.deepEqual(conclusions, ["failure"]);
    assert.deepEqual(tokens.requests[0]?.permissions, {
      contents: "read",
      pull_requests: "read",
      checks: "read",
      administration: "read",
    });
  } finally {
    ledger.close();
  }
});

test("production evidence-check policy queues only when branch protection pins the exact MergeProof App Check Run", async () => {
  const tokens = new RecordingTokens();
  const enqueues: string[] = [];
  const ledger = new RunLedger();
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "merge_queue",
        verification: demoVerificationPolicy,
        merge: {
          ...demoMergePolicy,
          requiredCheckAppIds: { "ci / test": 41, "ci / security": 42 },
        },
        requiredEvidenceCheck: { name: "MergeProof / evidence", appId: 777 },
      },
      tokens,
      {
        createReadGateway: () => ({
          getPullRequest: async () => live({
            baseRef: "main",
            checks: [
              { name: "ci / test", status: "pass", appId: 41 },
              { name: "ci / security", status: "pass", appId: 42 },
            ],
          }),
          getRequiredStatusChecks: async () => [
            { name: "ci / test", appId: 41 },
            { name: "ci / security", appId: 42 },
            { name: "MergeProof / evidence", appId: 777 },
          ],
        }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
        createQueueGateway: () => ({
          enqueue: async () => {
            enqueues.push("enqueue");
            return { message: "queued" };
          },
        }),
        createCheckRunGateway: () => ({
          createInProgress: async () => ({ id: 5 }),
          complete: async () => undefined,
        }),
        createCommentGateway: () => ({ upsert: async () => undefined }),
      },
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    ).process(trigger);

    assert.equal(result.state, "queued");
    assert.deepEqual(enqueues, ["enqueue"]);
  } finally {
    ledger.close();
  }
});

test("production evidence-check policy refuses an unpinned required CI source in branch protection", async () => {
  const tokens = new RecordingTokens();
  const enqueues: string[] = [];
  const ledger = new RunLedger();
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "merge_queue",
        verification: demoVerificationPolicy,
        merge: {
          ...demoMergePolicy,
          requiredCheckAppIds: { "ci / test": 41, "ci / security": 42 },
        },
        requiredEvidenceCheck: { name: "MergeProof / evidence", appId: 777 },
      },
      tokens,
      {
        createReadGateway: () => ({
          getPullRequest: async () => live({
            baseRef: "main",
            checks: [
              { name: "ci / test", status: "pass", appId: 41 },
              { name: "ci / security", status: "pass", appId: 42 },
            ],
          }),
          getRequiredStatusChecks: async () => [
            { name: "ci / test", appId: 9 },
            { name: "ci / security", appId: 42 },
            { name: "MergeProof / evidence", appId: 777 },
          ],
        }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
        createQueueGateway: () => ({ enqueue: async () => ({ message: "queued" }) }),
        createCheckRunGateway: () => ({ createInProgress: async () => ({ id: 5 }), complete: async () => undefined }),
        createCommentGateway: () => ({ upsert: async () => undefined }),
      },
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
    ).process(trigger);

    assert.equal(result.state, "not_merged");
    if (result.state !== "not_merged") return;
    assert.match(result.decision.reason, /ci \/ test from App 41/i);
    assert.deepEqual(enqueues, []);
  } finally {
    ledger.close();
  }
});

test("controller fails closed when no evidence harness is configured", async () => {
  const tokens = new RecordingTokens();
  const ledger = new RunLedger();
  try {
    await assert.rejects(
      new MergeProofController(
        {
          allowedRepositories: [trigger.repository],
          autoMergeEnabled: true,
          mergeStrategy: "direct_fixture",
          verification: demoVerificationPolicy,
          merge: demoMergePolicy,
        },
        tokens,
        {
          createReadGateway: () => ({ getPullRequest: async () => live() }),
          createMergeGateway: () => new MemoryMergeGateway(live()),
        },
        undefined,
        ledger,
      ).process(trigger),
      /No evidence harness is configured/,
    );
    assert.equal(tokens.requests.length, 1);
  } finally {
    ledger.close();
  }
});

test("controller gives the E2B harness factory only the down-scoped read token", async () => {
  const tokens = new RecordingTokens();
  const factory: GitHubGatewayFactory = {
    createReadGateway: () => ({ getPullRequest: async () => live() }),
    createMergeGateway: () => new MemoryMergeGateway(live()),
  };
  const receivedTokens: string[] = [];
  const harnessFactory: EvidenceHarnessFactory = {
    create: ({ githubReadToken }) => {
      receivedTokens.push(githubReadToken);
      return new FixtureEvidenceHarness(incompleteFixture());
    },
  };
  const ledger = new RunLedger();
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "direct_fixture",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      factory,
      undefined,
      ledger,
      () => new Date("2026-07-14T18:00:00.000Z"),
      undefined,
      harnessFactory,
    ).process(trigger);

    assert.equal(result.state, "verified");
    assert.deepEqual(receivedTokens, ["token-1"]);
    assert.equal(tokens.requests.length, 1);
  } finally {
    ledger.close();
  }
});

test("disabled repositories and missing GitHub merge candidates stop before evidence execution", async () => {
  const tokens = new RecordingTokens();
  const ledger = new RunLedger();
  try {
    const blocked = await new MergeProofController(
      {
        allowedRepositories: ["acme/other"],
        autoMergeEnabled: true,
        mergeStrategy: "direct_fixture",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      {
        createReadGateway: () => ({ getPullRequest: async () => live() }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
      },
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
    ).process(trigger);
    assert.deepEqual(blocked, { state: "ignored", reason: "Repository is not enabled for MergeProof." });
    assert.equal(tokens.requests.length, 0);

    const waiting = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "direct_fixture",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      {
        createReadGateway: () => ({ getPullRequest: async () => live({ mergeSha: null }) }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
      },
      new FixtureEvidenceHarness(safeFixture()),
      ledger,
    ).process(trigger);
    assert.deepEqual(waiting, { state: "waiting", reason: "GitHub has not produced a test merge SHA yet." });
    assert.equal(tokens.requests.length, 1);
  } finally {
    ledger.close();
  }
});

test("pending required CI defers before spending on sandbox evidence", async () => {
  const tokens = new RecordingTokens();
  const ledger = new RunLedger();
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "direct_fixture",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      {
        createReadGateway: () => ({
          getPullRequest: async () => live({ checks: [{ name: "ci / test", status: "pending" }] }),
        }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
      },
      {
        kind: "should-not-run",
        collect: async () => {
          throw new Error("evidence must not run while required CI is pending");
        },
      },
      ledger,
    ).process(trigger);

    assert.deepEqual(result, { state: "waiting", reason: "Required live check is pending: ci / test." });
    assert.equal(tokens.requests.length, 1);
  } finally {
    ledger.close();
  }
});

test("failed required CI blocks before spending on sandbox evidence", async () => {
  const tokens = new RecordingTokens();
  const ledger = new RunLedger();
  try {
    const result = await new MergeProofController(
      {
        allowedRepositories: [trigger.repository],
        autoMergeEnabled: true,
        mergeStrategy: "direct_fixture",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      },
      tokens,
      {
        createReadGateway: () => ({
          getPullRequest: async () => live({ checks: [{ name: "ci / test", status: "fail" }] }),
        }),
        createMergeGateway: () => new MemoryMergeGateway(live()),
      },
      {
        kind: "should-not-run",
        collect: async () => {
          throw new Error("evidence must not run while required CI is failing");
        },
      },
      ledger,
    ).process(trigger);

    assert.deepEqual(result, { state: "not_eligible", reason: "Required live check failed: ci / test." });
    assert.equal(tokens.requests.length, 1);
  } finally {
    ledger.close();
  }
});
