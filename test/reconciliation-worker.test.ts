import assert from "node:assert/strict";
import test from "node:test";

import type { CheckRunFailureCloser } from "../src/check-run.js";
import { demoRevision, demoVerificationPolicy, safeFixture } from "../src/fixtures.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import { RunLedger } from "../src/ledger.js";
import { ReconciliationWorker } from "../src/reconciliation-worker.js";
import type { ReadOnlyReconciliationReader } from "../src/reconciliation-resolver.js";
import { VerificationEngine } from "../src/verifier.js";

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

test("queue recovery is not admitted while the original publisher lease is active", async () => {
  const ledger = new RunLedger();
  try {
    const revision = { ...demoRevision, headSha: "reconciler-head", mergeSha: "reconciler-merge" };
    const claim = ledger.claim(revision, "verify-worker", 60_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      revision,
      demoVerificationPolicy,
      new Date(10),
    );
    ledger.recordReceipt(claim.lease, receipt, 11);
    ledger.beginPublication(claim.lease, 12);
    ledger.prepareExternalOperation(claim.lease, {
      operationId: "merge_queue_enqueue:run-42",
      kind: "merge_queue_enqueue",
      installationId: 99,
      target: {
        repository: revision.repository,
        pullRequest: revision.pullRequest,
        expectedHeadSha: revision.headSha,
      },
      expectation: { pullRequestNodeId: "PR_kwDOFixture42" },
    }, 13);
    let observations = 0;
    const reader: ReadOnlyReconciliationReader = {
      async observeMergeQueue(input) {
        observations += 1;
        return { kind: "merge_queue_enqueue", target: input.target, expectation: input.expectation, state: "queued" };
      },
      async observeDirectMerge() {
        throw new Error("Unexpected direct merge observation.");
      },
      async observeCheckRun() {
        throw new Error("Unexpected Check Run observation.");
      },
    };
    let now = 20;
    const worker = new ReconciliationWorker(ledger, reader, "reconciler", () => now);
    assert.deepEqual(await worker.processNext(), { state: "idle" });
    assert.equal(observations, 0);
    assert.equal(ledger.getExternalOperation("merge_queue_enqueue:run-42")?.state, "intent_recorded");
    assert.equal(ledger.getByRunKey(claim.lease.runKey)?.status, "publishing");

    now = 100_000;
    assert.deepEqual(await worker.processNext(), {
      state: "observed_applied",
      operationId: "merge_queue_enqueue:run-42",
    });
    assert.equal(observations, 1);
    assert.equal(ledger.getExternalOperation("merge_queue_enqueue:run-42")?.state, "observed_applied");
    assert.deepEqual(
      {
        status: ledger.getByRunKey(claim.lease.runKey)?.status,
        outcome: ledger.getByRunKey(claim.lease.runKey)?.outcome,
      },
      { status: "queued", outcome: "QUEUED" },
    );
    assert.deepEqual(await worker.processNext(), { state: "idle" });
  } finally {
    ledger.close();
  }
});

test("direct-merge recovery is not admitted until publisher expiry", async () => {
  for (const scenario of [
    {
      remoteState: "merged" as const,
      resolution: "observed_applied" as const,
      initialRunStatus: "merging" as const,
      status: "merged" as const,
      outcome: "MERGED" as const,
      attempt: "merged" as const,
    },
    {
      remoteState: "not_merged" as const,
      resolution: "observed_not_applied" as const,
      initialRunStatus: "merge_unknown" as const,
      status: "merge_failed" as const,
      outcome: "MERGE_FAILED" as const,
      attempt: "failed" as const,
    },
  ]) {
    const ledger = new RunLedger();
    try {
      const revision = {
        ...demoRevision,
        headSha: `direct-${scenario.remoteState}-head`,
        mergeSha: `direct-${scenario.remoteState}-merge`,
      };
      const claim = ledger.claim(revision, "merge-worker", 60_000, 10);
      assert.equal(claim.state, "claimed");
      if (claim.state !== "claimed") return;
      const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
        revision,
        demoVerificationPolicy,
        new Date(10),
      );
      ledger.recordReceipt(claim.lease, receipt, 11);
      const attemptId = `direct-recovery:${scenario.remoteState}`;
      ledger.beginMerge(claim.lease, {
        attemptId,
        runKey: receipt.runKey,
        expectedHeadSha: revision.headSha,
        state: "started",
        createdAt: new Date(12).toISOString(),
      }, 12);
      const operationId = `direct_merge:${receipt.runKey}`;
      ledger.prepareExternalOperation(claim.lease, {
        operationId,
        kind: "direct_merge",
        installationId: 99,
        target: {
          repository: revision.repository,
          pullRequest: revision.pullRequest,
          expectedHeadSha: revision.headSha,
        },
        expectation: { pullRequestNodeId: "PR_kwDOFixture42" },
      }, 13);
      if (scenario.initialRunStatus === "merge_unknown") {
        ledger.markMergeUnknown(
          claim.lease,
          {
            attemptId,
            runKey: receipt.runKey,
            expectedHeadSha: revision.headSha,
            state: "started",
            createdAt: new Date(12).toISOString(),
          },
          "Timed out after the direct fixture request crossed the write boundary.",
          14,
        );
      }
      const reader: ReadOnlyReconciliationReader = {
        async observeMergeQueue() {
          throw new Error("Unexpected queue observation.");
        },
        async observeDirectMerge(input) {
          return {
            kind: "direct_merge",
            target: input.target,
            expectation: input.expectation,
            state: scenario.remoteState,
          };
        },
        async observeCheckRun() {
          throw new Error("Unexpected Check Run observation.");
        },
      };
      let now = 20;
      const worker = new ReconciliationWorker(ledger, reader, "reconciler", () => now);

      assert.deepEqual(await worker.processNext(), { state: "idle" });
      assert.deepEqual(
        {
          operation: ledger.getExternalOperation(operationId)?.state,
          status: ledger.getByRunKey(receipt.runKey)?.status,
        },
        { operation: "intent_recorded", status: scenario.initialRunStatus },
      );

      now = 100_000;
      assert.deepEqual(await worker.processNext(), { state: scenario.resolution, operationId });
      assert.deepEqual(
        {
          operation: ledger.getExternalOperation(operationId)?.state,
          status: ledger.getByRunKey(receipt.runKey)?.status,
          outcome: ledger.getByRunKey(receipt.runKey)?.outcome,
          attempt: ledger.getAttempt(attemptId)?.state,
        },
        {
          operation: scenario.resolution,
          status: scenario.status,
          outcome: scenario.outcome,
          attempt: scenario.attempt,
        },
      );
    } finally {
      ledger.close();
    }
  }
});

test("an interrupted exact Check Run is failed closed only after its publisher lease expires", async () => {
  const ledger = new RunLedger();
  try {
    const revision = { ...demoRevision, headSha: "recovery-head", mergeSha: "recovery-merge" };
    const claim = ledger.claim(revision, "verify-worker", 60_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      revision,
      demoVerificationPolicy,
      new Date(10),
    );
    ledger.recordReceipt(claim.lease, receipt, 11);
    ledger.beginPublication(claim.lease, 12);
    const operationId = "check_run_publish:interrupted-run";
    ledger.prepareExternalOperation(claim.lease, {
      operationId,
      kind: "check_run_publish",
      installationId: 99,
      target: {
        repository: revision.repository,
        pullRequest: revision.pullRequest,
        expectedHeadSha: revision.headSha,
        checkName: "MergeProof / evidence",
      },
      expectation: {
        checkRunExternalId: operationId,
        expectedCheckConclusion: "success",
      },
    }, 13);
    ledger.bindCheckRunToOperation(claim.lease, operationId, 7, 14);

    const reader: ReadOnlyReconciliationReader = {
      async observeMergeQueue() {
        throw new Error("Unexpected queue observation.");
      },
      async observeDirectMerge() {
        throw new Error("Unexpected direct merge observation.");
      },
      async observeCheckRun(input) {
        return {
          kind: "check_run_publish",
          target: input.target,
          expectation: input.expectation,
          state: "in_progress",
          checkRunId: 7,
        };
      },
    };
    const recovered: Array<{ operationId: string; checkRunId: number }> = [];
    const closer: CheckRunFailureCloser = {
      async completeAsFailure(input) {
        recovered.push({ operationId: input.operation.operationId, checkRunId: input.checkRunId });
      },
    };
    let now = 20;
    const worker = new ReconciliationWorker(ledger, reader, "reconciler", () => now, 3_000, closer);

    assert.deepEqual(await worker.processNext(), { state: "idle" });
    assert.deepEqual(recovered, []);
    assert.equal(ledger.getExternalOperation(operationId)?.state, "intent_recorded");

    now = 100_000;
    assert.deepEqual(await worker.processNext(), {
      state: "failed_closed",
      operationId,
    });
    assert.deepEqual(recovered, [{ operationId, checkRunId: 7 }]);
    assert.equal(ledger.getExternalOperation(operationId)?.state, "observed_not_applied");
    assert.deepEqual(
      {
        status: ledger.getByRunKey(claim.lease.runKey)?.status,
        outcome: ledger.getByRunKey(claim.lease.runKey)?.outcome,
      },
      { status: "verified", outcome: "NOT_ELIGIBLE" },
    );
  } finally {
    ledger.close();
  }
});

test("a recovered green PR-head Check Run returns to verified for a fresh controller evaluation", async () => {
  const ledger = new RunLedger();
  try {
    const revision = { ...demoRevision, headSha: "recovered-green-head", mergeSha: "recovered-green-merge" };
    const claim = ledger.claim(revision, "verify-worker", 1_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      revision,
      demoVerificationPolicy,
      new Date(10),
    );
    ledger.recordReceipt(claim.lease, receipt, 11);
    ledger.beginPublication(claim.lease, 12);
    const operationId = "check_run_publish:recovered-green";
    ledger.prepareExternalOperation(claim.lease, {
      operationId,
      kind: "check_run_publish",
      installationId: 99,
      target: {
        repository: revision.repository,
        pullRequest: revision.pullRequest,
        expectedHeadSha: revision.headSha,
        checkName: "MergeProof / evidence",
      },
      expectation: {
        checkRunExternalId: operationId,
        expectedCheckConclusion: "success",
      },
    }, 13);
    const reader: ReadOnlyReconciliationReader = {
      async observeMergeQueue() {
        throw new Error("Unexpected queue observation.");
      },
      async observeDirectMerge() {
        throw new Error("Unexpected direct merge observation.");
      },
      async observeCheckRun(input) {
        return {
          kind: "check_run_publish",
          target: input.target,
          expectation: input.expectation,
          state: "published",
          checkRunId: 8,
        };
      },
    };
    const worker = new ReconciliationWorker(ledger, reader, "reconciler", () => 2_000);

    assert.deepEqual(await worker.processNext(), { state: "observed_applied", operationId });
    assert.deepEqual(
      {
        status: ledger.getByRunKey(claim.lease.runKey)?.status,
        outcome: ledger.getByRunKey(claim.lease.runKey)?.outcome,
        decision: ledger.getByRunKey(claim.lease.runKey)?.decision?.state,
      },
      { status: "verified", outcome: "READY", decision: "eligible" },
    );
    assert.equal(ledger.claim(revision, "fresh-controller", 1_000, 2_001).state, "claimed");
  } finally {
    ledger.close();
  }
});

test("an interrupted expected-failure PR-head Check Run is recovered as a non-eligible result", async () => {
  const ledger = new RunLedger();
  try {
    const revision = { ...demoRevision, headSha: "recovered-failure-head", mergeSha: "recovered-failure-merge" };
    const claim = ledger.claim(revision, "verify-worker", 1_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      revision,
      demoVerificationPolicy,
      new Date(10),
    );
    ledger.recordReceipt(claim.lease, receipt, 11);
    ledger.beginPublication(claim.lease, 12);
    const operationId = "check_run_publish:recovered-failure";
    ledger.prepareExternalOperation(claim.lease, {
      operationId,
      kind: "check_run_publish",
      installationId: 99,
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
    ledger.bindCheckRunToOperation(claim.lease, operationId, 10, 14);
    const reader: ReadOnlyReconciliationReader = {
      async observeMergeQueue() {
        throw new Error("Unexpected queue observation.");
      },
      async observeDirectMerge() {
        throw new Error("Unexpected direct merge observation.");
      },
      async observeCheckRun(input) {
        return {
          kind: "check_run_publish",
          target: input.target,
          expectation: input.expectation,
          state: "in_progress",
          checkRunId: 10,
        };
      },
    };
    const recovered: number[] = [];
    const closer: CheckRunFailureCloser = {
      async completeAsFailure(input) {
        recovered.push(input.checkRunId);
      },
    };
    const worker = new ReconciliationWorker(ledger, reader, "reconciler", () => 2_000, 3_000, closer);

    assert.deepEqual(await worker.processNext(), { state: "failed_closed", operationId });
    assert.deepEqual(recovered, [10]);
    assert.deepEqual(
      {
        operation: ledger.getExternalOperation(operationId)?.state,
        status: ledger.getByRunKey(claim.lease.runKey)?.status,
        outcome: ledger.getByRunKey(claim.lease.runKey)?.outcome,
      },
      { operation: "observed_applied", status: "verified", outcome: "NOT_ELIGIBLE" },
    );
    assert.equal(ledger.claim(revision, "fresh-controller", 1_000, 2_001).state, "claimed");
  } finally {
    ledger.close();
  }
});

test("a recovered final merge-group Check Run remains terminally reported", async () => {
  const ledger = new RunLedger();
  try {
    const revision = { ...demoRevision, pullRequest: 0, headSha: "recovered-group-head", mergeSha: "recovered-group-head" };
    const claim = ledger.claim(revision, "merge-group-worker", 1_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      revision,
      demoVerificationPolicy,
      new Date(10),
    );
    ledger.recordReceipt(claim.lease, receipt, 11);
    ledger.beginPublication(claim.lease, 12);
    const operationId = "check_run_publish:recovered-group";
    ledger.prepareExternalOperation(claim.lease, {
      operationId,
      kind: "check_run_publish",
      installationId: 99,
      target: {
        repository: revision.repository,
        pullRequest: 0,
        expectedHeadSha: revision.headSha,
        checkName: "MergeProof / evidence",
      },
      expectation: {
        checkRunExternalId: operationId,
        expectedCheckConclusion: "success",
      },
    }, 13);
    const reader: ReadOnlyReconciliationReader = {
      async observeMergeQueue() {
        throw new Error("Unexpected queue observation.");
      },
      async observeDirectMerge() {
        throw new Error("Unexpected direct merge observation.");
      },
      async observeCheckRun(input) {
        return {
          kind: "check_run_publish",
          target: input.target,
          expectation: input.expectation,
          state: "published",
          checkRunId: 9,
        };
      },
    };
    const worker = new ReconciliationWorker(ledger, reader, "reconciler", () => 2_000);

    assert.deepEqual(await worker.processNext(), { state: "observed_applied", operationId });
    assert.deepEqual(
      {
        status: ledger.getByRunKey(claim.lease.runKey)?.status,
        outcome: ledger.getByRunKey(claim.lease.runKey)?.outcome,
      },
      { status: "reported", outcome: "READY" },
    );
    assert.deepEqual(ledger.claim(revision, "fresh-controller", 1_000, 2_001), { state: "completed" });
  } finally {
    ledger.close();
  }
});

test("a slow reconciliation read keeps its fenced lease alive and blocks a second slot", async () => {
  const ledger = new RunLedger();
  try {
    const revision = { ...demoRevision, headSha: "heartbeat-read-head", mergeSha: "heartbeat-read-merge" };
    const claim = ledger.claim(revision, "publisher", 60_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      revision,
      demoVerificationPolicy,
      new Date(10),
    );
    ledger.recordReceipt(claim.lease, receipt, 11);
    ledger.beginPublication(claim.lease, 12);
    const operationId = "merge_queue_enqueue:heartbeat-read";
    ledger.prepareExternalOperation(claim.lease, {
      operationId,
      kind: "merge_queue_enqueue",
      installationId: 99,
      target: {
        repository: revision.repository,
        pullRequest: revision.pullRequest,
        expectedHeadSha: revision.headSha,
      },
      expectation: { pullRequestNodeId: "PR_kwDOFixture42" },
    }, 13);

    let releaseRead: (() => void) | undefined;
    let readStarted = false;
    const reader: ReadOnlyReconciliationReader = {
      async observeMergeQueue(input) {
        readStarted = true;
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        return { kind: "merge_queue_enqueue", target: input.target, expectation: input.expectation, state: "queued" };
      },
      async observeDirectMerge() {
        throw new Error("Unexpected direct merge observation.");
      },
      async observeCheckRun() {
        throw new Error("Unexpected Check Run observation.");
      },
    };
    let now = 60_011;
    const worker = new ReconciliationWorker(
      ledger,
      reader,
      "reconciler:slot:1",
      () => now,
      3_000,
      undefined,
      { heartbeatMs: 1 },
    );
    const running = worker.processNext();
    while (!readStarted) {
      await delay(1);
    }
    now = 62_000;
    await delay(5);
    // The reconciliation lease initially ended at 63011. The heartbeat
    // extended it from the slow read, so a second slot cannot steal it at 64001.
    now = 64_001;
    assert.equal(ledger.claimReconciliationCandidate("reconciler:slot:2", 3_000, now), null);
    assert.ok(releaseRead);
    releaseRead?.();
    assert.deepEqual(await running, { state: "observed_applied", operationId });
  } finally {
    ledger.close();
  }
});

test("a lost reconciliation lease discards a slow read instead of running a finalizer", async () => {
  const ledger = new RunLedger();
  try {
    const revision = { ...demoRevision, headSha: "lost-read-head", mergeSha: "lost-read-merge" };
    const claim = ledger.claim(revision, "publisher", 60_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      revision,
      demoVerificationPolicy,
      new Date(10),
    );
    ledger.recordReceipt(claim.lease, receipt, 11);
    ledger.beginPublication(claim.lease, 12);
    const operationId = "merge_queue_enqueue:lost-read";
    ledger.prepareExternalOperation(claim.lease, {
      operationId,
      kind: "merge_queue_enqueue",
      installationId: 99,
      target: {
        repository: revision.repository,
        pullRequest: revision.pullRequest,
        expectedHeadSha: revision.headSha,
      },
      expectation: { pullRequestNodeId: "PR_kwDOFixture42" },
    }, 13);

    let releaseRead: (() => void) | undefined;
    let readStarted = false;
    const reader: ReadOnlyReconciliationReader = {
      async observeMergeQueue(input) {
        readStarted = true;
        await new Promise<void>((resolve) => {
          releaseRead = resolve;
        });
        return { kind: "merge_queue_enqueue", target: input.target, expectation: input.expectation, state: "queued" };
      },
      async observeDirectMerge() {
        throw new Error("Unexpected direct merge observation.");
      },
      async observeCheckRun() {
        throw new Error("Unexpected Check Run observation.");
      },
    };
    let now = 60_011;
    const worker = new ReconciliationWorker(
      ledger,
      reader,
      "reconciler:slot:1",
      () => now,
      3_000,
      undefined,
      { heartbeatMs: 1 },
    );
    const running = worker.processNext();
    while (!readStarted) {
      await delay(1);
    }
    // Jump beyond the unrenewed lease before the timer gets a chance to
    // heartbeat. The heartbeat records ownership loss and the second slot
    // gets the only valid fence token.
    now = 64_000;
    await delay(5);
    assert.ok(ledger.claimReconciliationCandidate("reconciler:slot:2", 3_000, 64_001));
    assert.ok(releaseRead);
    releaseRead?.();
    await assert.rejects(running, /stale or owned by another worker/i);
    assert.equal(ledger.getExternalOperation(operationId)?.state, "intent_recorded");
  } finally {
    ledger.close();
  }
});

test("a slow failure-only Check Run close is heartbeated before its fail-closed finalizer", async () => {
  const ledger = new RunLedger();
  try {
    const revision = { ...demoRevision, headSha: "heartbeat-close-head", mergeSha: "heartbeat-close-merge" };
    const claim = ledger.claim(revision, "publisher", 3_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      revision,
      demoVerificationPolicy,
      new Date(10),
    );
    ledger.recordReceipt(claim.lease, receipt, 11);
    ledger.beginPublication(claim.lease, 12);
    const operationId = "check_run_publish:heartbeat-close";
    ledger.prepareExternalOperation(claim.lease, {
      operationId,
      kind: "check_run_publish",
      installationId: 99,
      target: {
        repository: revision.repository,
        pullRequest: revision.pullRequest,
        expectedHeadSha: revision.headSha,
        checkName: "MergeProof / evidence",
      },
      expectation: {
        checkRunExternalId: operationId,
        expectedCheckConclusion: "success",
      },
    }, 13);
    let closeStarted = false;
    let releaseClose: (() => void) | undefined;
    const closer: CheckRunFailureCloser = {
      async completeAsFailure() {
        closeStarted = true;
        await new Promise<void>((resolve) => {
          releaseClose = resolve;
        });
      },
    };
    const reader: ReadOnlyReconciliationReader = {
      async observeMergeQueue() {
        throw new Error("Unexpected queue observation.");
      },
      async observeDirectMerge() {
        throw new Error("Unexpected direct merge observation.");
      },
      async observeCheckRun(input) {
        return {
          kind: "check_run_publish",
          target: input.target,
          expectation: input.expectation,
          state: "in_progress",
          checkRunId: 88,
        };
      },
    };
    let now = 4_000;
    const worker = new ReconciliationWorker(
      ledger,
      reader,
      "reconciler:slot:1",
      () => now,
      3_000,
      closer,
      { heartbeatMs: 1 },
    );
    const running = worker.processNext();
    while (!closeStarted) {
      await delay(1);
    }
    now = 6_000;
    await delay(5);
    now = 7_001;
    assert.equal(ledger.claimReconciliationCandidate("reconciler:slot:2", 3_000, now), null);
    assert.ok(releaseClose);
    releaseClose?.();
    assert.deepEqual(await running, { state: "failed_closed", operationId });
    assert.equal(ledger.getExternalOperation(operationId)?.state, "observed_not_applied");
  } finally {
    ledger.close();
  }
});
