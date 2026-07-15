import assert from "node:assert/strict";
import test from "node:test";

import { demoRevision } from "../src/fixtures.js";
import { demoVerificationPolicy, safeFixture } from "../src/fixtures.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import { RunLedger } from "../src/ledger.js";
import { VerificationEngine } from "../src/verifier.js";

test("ledger deduplicates webhook deliveries and fences expired workers", () => {
  const ledger = new RunLedger();
  try {
    assert.equal(ledger.registerDelivery("delivery-1", 1), true);
    assert.equal(ledger.registerDelivery("delivery-1", 2), false);

    const first = ledger.claim(demoRevision, "worker-a", 1_000, 10);
    assert.equal(first.state, "claimed");
    if (first.state !== "claimed") return;

    const busy = ledger.claim(demoRevision, "worker-b", 1_000, 11);
    assert.deepEqual(busy, { state: "busy", retryAt: 1_010 });

    const replacement = ledger.claim(demoRevision, "worker-b", 1_000, 1_011);
    assert.equal(replacement.state, "claimed");
    if (replacement.state !== "claimed") return;
    assert.equal(replacement.lease.fenceToken, first.lease.fenceToken + 1);
  } finally {
    ledger.close();
  }
});

test("durable automation pause survives ordinary ledger activity and can be explicitly resumed", () => {
  const ledger = new RunLedger();
  try {
    assert.deepEqual(ledger.automationControl(), { paused: false, updatedAt: 0 });
    assert.deepEqual(ledger.setAutomationPaused(true, 100), { paused: true, updatedAt: 100 });
    assert.equal(ledger.automationControl().paused, true);
    assert.deepEqual(ledger.setAutomationPaused(false, 200), { paused: false, updatedAt: 200 });
  } finally {
    ledger.close();
  }
});

test("lease renewal extends only the current fenced owner and rejects a stale holder", () => {
  const ledger = new RunLedger();
  try {
    const run = ledger.claim(demoRevision, "run-worker-a", 3_000, 10);
    assert.equal(run.state, "claimed");
    if (run.state !== "claimed") return;

    assert.equal(ledger.renewRunLease(run.lease, 3_000, 1_000).expiresAt, 4_000);
    assert.deepEqual(ledger.claim(demoRevision, "run-worker-b", 3_000, 3_500), {
      state: "busy",
      retryAt: 4_000,
    });
    assert.throws(() => ledger.renewRunLease(run.lease, 3_000, 4_001), /stale/i);

    assert.equal(ledger.enqueueWebhook("renewal-event", "pull_request", "{}", 10), true);
    const webhook = ledger.claimWebhook("webhook-worker-a", 3_000, 10);
    assert.ok(webhook);
    if (!webhook) return;
    assert.equal(ledger.renewWebhookLease(webhook.lease, 3_000, 1_000).expiresAt, 4_000);
    assert.equal(ledger.claimWebhook("webhook-worker-b", 3_000, 3_500), null);
    assert.throws(() => ledger.renewWebhookLease(webhook.lease, 3_000, 4_001), /stale/i);
    assert.equal(ledger.claimWebhook("webhook-worker-b", 3_000, 4_001)?.lease.fenceToken, 2);
  } finally {
    ledger.close();
  }
});

test("webhook inbox writes before acknowledgement and fences stale workers", () => {
  const ledger = new RunLedger();
  try {
    assert.equal(ledger.enqueueWebhook("event-1", "pull_request", "{}", 10), true);
    assert.equal(ledger.enqueueWebhook("event-1", "pull_request", "{}", 11), false);
    const first = ledger.claimWebhook("worker-a", 1_000, 20);
    assert.ok(first);
    if (!first) return;
    assert.equal(first.attempt, 1);
    assert.throws(() => ledger.completeWebhook(first.lease, 1_021), /stale/i);

    const second = ledger.claimWebhook("worker-b", 1_000, 1_021);
    assert.ok(second);
    if (!second) return;
    assert.equal(second.lease.fenceToken, first.lease.fenceToken + 1);
    ledger.completeWebhook(second.lease, 1_022);
    assert.deepEqual(ledger.getWebhookEventMetadata("event-1"), {
      status: "completed",
      bodyRetained: false,
      bodyBytes: 0,
      attemptCount: 2,
      deadLetterReplayCount: 0,
    });
    assert.equal(ledger.claimWebhook("worker-c", 1_000, 1_023), null);
  } finally {
    ledger.close();
  }
});

test("webhook inbox rejects excess pending work without consuming a delivery id", () => {
  const ledger = new RunLedger(":memory:", 1);
  try {
    assert.equal(ledger.enqueueWebhook("event-1", "pull_request", "{}", 10), true);
    assert.equal(ledger.enqueueWebhook("event-2", "pull_request", "{}", 11), "inbox_full");
    assert.equal(ledger.claimWebhook("worker", 1_000, 12)?.deliveryId, "event-1");
  } finally {
    ledger.close();
  }
});

test("webhook inbox atomically enforces its retained byte budget", () => {
  const ledger = new RunLedger(":memory:", 10, 5);
  try {
    assert.equal(ledger.enqueueWebhook("event-1", "pull_request", "12345", 10), true);
    assert.equal(ledger.enqueueWebhook("event-2", "pull_request", "x", 11), "inbox_full");
    assert.deepEqual(ledger.operatorStats().inbox, {
      queued: 1,
      running: 0,
      completed: 0,
      failed: 0,
      deadLetter: 0,
      pendingBytes: 5,
      maxPendingEvents: 10,
      maxPendingBytes: 5,
    });
  } finally {
    ledger.close();
  }
});

test("repository-fair scheduling alternates webhook claims before giving one repository another slot", () => {
  const ledger = new RunLedger();
  const body = (repository: string) => JSON.stringify({ repository: { full_name: repository } });
  try {
    assert.equal(ledger.enqueueWebhook("acme-1", "pull_request", body("acme/service"), 10), true);
    assert.equal(ledger.enqueueWebhook("acme-2", "pull_request", body("acme/service"), 11), true);
    assert.equal(ledger.enqueueWebhook("other-1", "pull_request", body("other/service"), 12), true);

    assert.equal(ledger.claimWebhook("worker-1", 60_000, 20)?.deliveryId, "acme-1");
    // `other/service` has not used a worker slot yet, so it is selected ahead
    // of the second delivery from the busy acme repository.
    assert.equal(ledger.claimWebhook("worker-2", 60_000, 20)?.deliveryId, "other-1");
    assert.equal(ledger.claimWebhook("worker-3", 60_000, 20)?.deliveryId, "acme-2");
  } finally {
    ledger.close();
  }
});

test("dead-letter replay is bounded and erases the retained payload after its final failure", () => {
  const ledger = new RunLedger();
  try {
    assert.equal(ledger.enqueueWebhook("dead-letter-final", "pull_request", "{}", 10), true);
    const first = ledger.claimWebhook("worker-1", 1_000, 20);
    assert.ok(first);
    if (!first) return;
    ledger.failWebhook(first.lease, "temporary outage", 20);
    assert.equal(ledger.getWebhookEventMetadata("dead-letter-final")?.status, "dead_letter");

    const replay = ledger.claimWebhook("worker-2", 1_000, 300_020);
    assert.ok(replay);
    if (!replay) return;
    assert.equal(replay.attempt, 1);
    ledger.failWebhook(replay.lease, "still unavailable", 300_020);
    assert.deepEqual(ledger.getWebhookEventMetadata("dead-letter-final"), {
      status: "failed",
      bodyRetained: false,
      bodyBytes: 0,
      attemptCount: 1,
      deadLetterReplayCount: 1,
    });
    assert.equal(ledger.claimWebhook("worker-3", 1_000, 1_000_000), null);
  } finally {
    ledger.close();
  }
});

test("an interrupted GitHub publication requires reconciliation instead of replaying a merge side effect", async () => {
  const ledger = new RunLedger();
  const revision = { ...demoRevision, headSha: "head-publication", mergeSha: "merge-publication" };
  try {
    const claim = ledger.claim(revision, "worker-a", 60_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      revision,
      demoVerificationPolicy,
      new Date(10),
    );
    ledger.recordReceipt(claim.lease, receipt, 11);
    assert.deepEqual(ledger.listRuns().runs[0]?.decision, {
      stage: "evidence",
      state: "eligible",
      outcome: "READY",
      reason: "All configured deterministic obligations passed.",
      decidedAt: new Date(11).toISOString(),
    });
    ledger.beginPublication(claim.lease, 12);

    assert.equal(ledger.get(revision)?.status, "publishing");
    assert.deepEqual(ledger.claim(revision, "worker-b", 60_000, 13), {
      state: "reconciliation_required",
    });
  } finally {
    ledger.close();
  }
});

test("revoking a queued revision clears its terminal queue state so a later trigger requires fresh evidence", async () => {
  const ledger = new RunLedger();
  try {
    const claim = ledger.claim(demoRevision, "worker-a", 60_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      demoRevision,
      demoVerificationPolicy,
      new Date(10),
    );
    ledger.recordReceipt(claim.lease, receipt, 11);
    ledger.beginPublication(claim.lease, 12);
    ledger.markQueued(claim.lease, 13);
    assert.equal(ledger.revokeQueuedRevision(demoRevision, "Required label is missing: mergeproof:auto.", 14), true);
    assert.equal(ledger.get(demoRevision)?.status, "verified");
    assert.equal(ledger.get(demoRevision)?.outcome, "NOT_ELIGIBLE");
    assert.equal(ledger.claim(demoRevision, "worker-b", 60_000, 15).state, "claimed");
  } finally {
    ledger.close();
  }
});

test("duplicate deliveries cannot displace an active verified run or an in-flight direct merge", async () => {
  const ledger = new RunLedger();
  const revision = { ...demoRevision, headSha: "head-nonreplay", mergeSha: "merge-nonreplay" };
  try {
    const claim = ledger.claim(revision, "worker-a", 60_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      revision,
      demoVerificationPolicy,
      new Date(10),
    );
    ledger.recordReceipt(claim.lease, receipt, 11);
    assert.deepEqual(ledger.claim(revision, "worker-b", 60_000, 12), {
      state: "busy",
      retryAt: 60_010,
    });

    ledger.beginMerge(
      claim.lease,
      {
        attemptId: "nonreplay-attempt",
        runKey: receipt.runKey,
        expectedHeadSha: revision.headSha,
        state: "started",
        createdAt: new Date(12).toISOString(),
      },
      12,
    );
    assert.deepEqual(ledger.claim(revision, "worker-b", 60_000, 13), {
      state: "reconciliation_required",
    });
  } finally {
    ledger.close();
  }
});
