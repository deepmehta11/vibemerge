import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { demoRevision, demoVerificationPolicy, safeFixture } from "../src/fixtures.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import type { ExternalOperation, ExternalOperationIntent } from "../src/ledger.js";
import { RunLedger } from "../src/ledger.js";
import {
  resolveExternalOperationReadOnly,
  type ReadOnlyReconciliationReader,
} from "../src/reconciliation-resolver.js";
import { VerificationEngine } from "../src/verifier.js";

async function publishingRun(ledger: RunLedger): Promise<{
  lease: { runKey: string; workerId: string; fenceToken: number; expiresAt: number };
  revision: typeof demoRevision;
}> {
  const revision = { ...demoRevision, headSha: "reconciliation-head", mergeSha: "reconciliation-merge" };
  const claimed = ledger.claim(revision, "verification-worker", 60_000, 10);
  assert.equal(claimed.state, "claimed");
  if (claimed.state !== "claimed") throw new Error("Expected a claimed run.");
  const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
    revision,
    demoVerificationPolicy,
    new Date(10),
  );
  ledger.recordReceipt(claimed.lease, receipt, 11);
  ledger.beginPublication(claimed.lease, 12);
  return { lease: claimed.lease, revision };
}

function queueIntent(revision: typeof demoRevision): ExternalOperationIntent {
  return {
    operationId: "queue-intent-42",
    kind: "merge_queue_enqueue",
    installationId: 123_456,
    target: {
      repository: revision.repository,
      pullRequest: revision.pullRequest,
      expectedHeadSha: revision.headSha,
    },
    expectation: { pullRequestNodeId: "PR_kwDOFixture42" },
  };
}

test("external write intent is durable before a write and is never represented as replayable work", async () => {
  const ledger = new RunLedger();
  try {
    const { lease, revision } = await publishingRun(ledger);
    const intent = queueIntent(revision);
    const prepared = ledger.prepareExternalOperation(lease, intent, 13);
    assert.equal(prepared.state, "prepared");
    assert.deepEqual(prepared.operation, {
      operationId: "queue-intent-42",
      runKey: lease.runKey,
      kind: "merge_queue_enqueue",
      installationId: 123_456,
      target: {
        repository: revision.repository,
        pullRequest: revision.pullRequest,
        expectedHeadSha: revision.headSha,
      },
      expectation: { pullRequestNodeId: "PR_kwDOFixture42" },
      state: "intent_recorded",
      intentFenceToken: lease.fenceToken,
      reconciliationFenceToken: 0,
      createdAt: 13,
      updatedAt: 13,
      resolvedAt: null,
      evidence: null,
    });

    // A retry sees the previously durable intent and must reconcile, not emit
    // the enqueue again—even with a different caller-generated id.
    assert.equal(ledger.prepareExternalOperation(lease, intent, 14).state, "already_recorded");
    assert.equal(
      ledger.prepareExternalOperation(
        lease,
        { ...intent, operationId: "queue-intent-retry" },
        15,
      ).state,
      "already_recorded",
    );

    assert.throws(
      () =>
        ledger.prepareExternalOperation(
          lease,
          {
            operationId: "check-with-name-only",
            kind: "check_run_publish",
            installationId: 123_456,
            target: {
              repository: revision.repository,
              pullRequest: revision.pullRequest,
              expectedHeadSha: revision.headSha,
              checkName: "MergeProof / exact revision",
            },
            expectation: { expectedCheckConclusion: "success" },
          },
          16,
        ),
      /id or deterministic external id/i,
    );
  } finally {
    ledger.close();
  }
});

test("external operation intent survives a ledger reopen before any external write occurs", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mergeproof-reconciliation-"));
  const path = join(directory, "ledger.sqlite");
  try {
    const initial = new RunLedger(path);
    try {
      const { lease, revision } = await publishingRun(initial);
      assert.equal(initial.prepareExternalOperation(lease, queueIntent(revision), 13).state, "prepared");
    } finally {
      initial.close();
    }

    const reopened = new RunLedger(path);
    try {
      assert.equal(reopened.getExternalOperation("queue-intent-42")?.state, "intent_recorded");
      assert.equal(reopened.getExternalOperation("queue-intent-42")?.installationId, 123_456);
      assert.equal(reopened.claimReconciliationCandidate("reconciler-restart", 3_000, 20), null);
      assert.equal(
        reopened.claimReconciliationCandidate("reconciler-restart", 3_000, 60_011)?.operation.operationId,
        "queue-intent-42",
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("reconciliation candidates are fenced, delayed after ambiguity, and finalized by CAS", async () => {
  const ledger = new RunLedger();
  try {
    const { lease, revision } = await publishingRun(ledger);
    ledger.prepareExternalOperation(lease, queueIntent(revision), 13);

    assert.equal(ledger.claimReconciliationCandidate("reconciler-a", 3_000, 20), null);

    const first = ledger.claimReconciliationCandidate("reconciler-a", 3_000, 60_011);
    assert.ok(first);
    if (!first) return;
    assert.equal(first.lease.fenceToken, 1);
    assert.equal(ledger.claimReconciliationCandidate("reconciler-b", 3_000, 60_012), null);

    ledger.renewReconciliationLease(first.lease, 3_000, 61_000);
    assert.throws(
      () => ledger.resolveReconciliationCandidate(first.lease, {
        state: "observed_applied",
        evidence: "Exact queue entry was observed.",
      }, 64_001),
      /stale/i,
    );

    const second = ledger.claimReconciliationCandidate("reconciler-b", 3_000, 64_001);
    assert.ok(second);
    if (!second) return;
    assert.equal(second.lease.fenceToken, 2);
    const ambiguous = ledger.resolveReconciliationCandidate(
      second.lease,
      { state: "ambiguous", evidence: "GitHub read API was temporarily unavailable.", retryAfterMs: 1_000 },
      64_002,
    );
    assert.equal(ambiguous.state, "ambiguous");
    assert.equal(ledger.claimReconciliationCandidate("reconciler-c", 3_000, 65_001), null);

    const third = ledger.claimReconciliationCandidate("reconciler-c", 3_000, 65_002);
    assert.ok(third);
    if (!third) return;
    const applied = ledger.resolveReconciliationCandidate(
      third.lease,
      { state: "observed_applied", evidence: "Exact queue entry was observed." },
      65_003,
    );
    assert.equal(applied.state, "observed_applied");
    assert.equal(applied.resolvedAt, 65_003);
    assert.equal(ledger.claimReconciliationCandidate("reconciler-d", 3_000, 66_000), null);
  } finally {
    ledger.close();
  }
});

test("an active Check Run publisher can acknowledge GitHub before reconciliation is admitted", async () => {
  const ledger = new RunLedger();
  try {
    const { lease, revision } = await publishingRun(ledger);
    const operationId = "check_run_publish:active-publisher";
    ledger.prepareExternalOperation(lease, {
      operationId,
      kind: "check_run_publish",
      installationId: 123_456,
      target: {
        repository: revision.repository,
        pullRequest: revision.pullRequest,
        expectedHeadSha: revision.headSha,
        checkName: "MergeProof / evidence",
      },
      expectation: {
        checkRunExternalId: operationId,
        expectedCheckConclusion: "failure",
      },
    }, 13);
    ledger.bindCheckRunToOperation(lease, operationId, 7, 14);

    assert.equal(ledger.claimReconciliationCandidate("reconciler", 3_000, 20), null);
    assert.equal(
      ledger.confirmCheckRunCompletion(lease, operationId, 7, 21).state,
      "observed_applied",
    );
  } finally {
    ledger.close();
  }
});

test("read-only reconciliation resolves only exact queue, check, or merge observations", async () => {
  const operation: ExternalOperation = {
    operationId: "check-intent-42",
    runKey: "run-42",
    kind: "check_run_publish",
    installationId: 123_456,
    target: {
      repository: "acme/checkout-service",
      pullRequest: 42,
      expectedHeadSha: "head-42",
      checkName: "MergeProof / exact revision",
    },
    expectation: {
      pullRequestNodeId: "PR_kwDOFixture42",
      checkRunExternalId: "mergeproof:run-42",
      expectedCheckConclusion: "success",
    },
    state: "intent_recorded",
    intentFenceToken: 1,
    reconciliationFenceToken: 0,
    createdAt: 1,
    updatedAt: 1,
    resolvedAt: null,
    evidence: null,
  };
  let observedInstallationId: number | undefined;
  const exactReader: ReadOnlyReconciliationReader = {
    async observeMergeQueue() {
      throw new Error("Unexpected queue observation.");
    },
    async observeDirectMerge() {
      throw new Error("Unexpected merge observation.");
    },
    async observeCheckRun(input) {
      observedInstallationId = input.installationId;
      return {
        kind: "check_run_publish",
        target: input.target,
        expectation: input.expectation,
        state: "published",
      };
    },
  };
  assert.deepEqual(await resolveExternalOperationReadOnly(operation, exactReader), {
    state: "observed_applied",
    evidence: "Exact Check Run state was observed as published.",
  });
  assert.equal(observedInstallationId, 123_456);

  const mismatchedReader: ReadOnlyReconciliationReader = {
    ...exactReader,
    async observeCheckRun(input) {
      return {
        kind: "check_run_publish",
        target: { ...input.target, expectedHeadSha: "different-head" },
        expectation: input.expectation,
        state: "published",
      };
    },
  };
  assert.deepEqual(await resolveExternalOperationReadOnly(operation, mismatchedReader), {
    state: "ambiguous",
    evidence: "Check Run readback did not exactly match the journaled operation.",
    retryAfterMs: 30_000,
  });
});
