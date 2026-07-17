import assert from "node:assert/strict";
import test from "node:test";

import { githubWebhookSignature, sealReceipt } from "../src/crypto.js";
import { parseHarnessResult } from "../src/e2b-harness.js";
import type { EvidenceReceipt } from "../src/domain.js";
import { demoRevision, demoVerificationPolicy, safeFixture } from "../src/fixtures.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import { RunLedger } from "../src/ledger.js";
import { VerificationEngine } from "../src/verifier.js";
import { acceptGitHubDelivery } from "../src/webhook.js";
import { queueGitHubDelivery } from "../src/webhook.js";
import { WebhookWorker } from "../src/webhook-worker.js";

test("webhook acceptance requires a valid signature and one delivery id", () => {
  const ledger = new RunLedger();
  try {
    const body = '{"action":"synchronize"}';
    const secret = "test-secret";
    const signature = githubWebhookSignature(body, secret);
    assert.deepEqual(
      acceptGitHubDelivery({ body, signature, deliveryId: "d-1" }, secret, ledger),
      { accepted: true, deliveryId: "d-1" },
    );
    assert.deepEqual(
      acceptGitHubDelivery({ body, signature, deliveryId: "d-1" }, secret, ledger),
      { accepted: false, reason: "duplicate_delivery" },
    );
    assert.deepEqual(
      acceptGitHubDelivery({ body, signature: "sha256=bad", deliveryId: "d-2" }, secret, ledger),
      { accepted: false, reason: "invalid_signature" },
    );
  } finally {
    ledger.close();
  }
});

test("authenticated webhook delivery is persisted before a worker processes it", async () => {
  const ledger = new RunLedger();
  try {
    const body = JSON.stringify({
      action: "synchronize",
      number: 42,
      installation: { id: 9 },
      repository: { id: 10, full_name: "acme/checkout-service" },
    });
    const secret = "queue-secret";
    const signature = githubWebhookSignature(body, secret);
    assert.deepEqual(
      queueGitHubDelivery(
        { body, signature, deliveryId: "queued-1", eventName: "pull_request" },
        secret,
        ledger,
      ),
      { accepted: true, deliveryId: "queued-1" },
    );
    const processed: string[] = [];
    const worker = new WebhookWorker(
      ledger,
      {
        process: async (trigger) => {
          processed.push(`${trigger.repository}#${trigger.pullRequest}`);
          return { state: "ignored", reason: "test" };
        },
      },
      "worker-1",
      3,
    );
    assert.deepEqual(await worker.processNext(), {
      state: "processed",
      deliveryId: "queued-1",
      detail: "ignored",
    });
    assert.deepEqual(processed, ["acme/checkout-service#42"]);
    assert.deepEqual(await worker.processNext(), { state: "idle" });
  } finally {
    ledger.close();
  }
});

test("one completed check-run delivery re-evaluates each associated pull request", async () => {
  const ledger = new RunLedger();
  try {
    const body = JSON.stringify({
      action: "completed",
      installation: { id: 9 },
      repository: { id: 10, full_name: "acme/checkout-service" },
      check_run: {
        status: "completed",
        name: "ci / test",
        app: { id: 77 },
        pull_requests: [{ number: 42 }, { number: 43 }],
      },
    });
    assert.equal(ledger.enqueueWebhook("check-run-1", "check_run", body, 10), true);
    const processed: string[] = [];
    const worker = new WebhookWorker(
      ledger,
      {
        process: async (trigger) => {
          processed.push(`${trigger.action}:${trigger.repository}#${trigger.pullRequest}`);
          return { state: "ignored", reason: "live state handled by controller" };
        },
      },
      "worker-1",
      3,
      undefined,
      undefined,
      {
        checkRunPolicy: {
          requiredChecks: ["ci / test"],
          requiredCheckAppIds: { "ci / test": 77 },
          ownAppId: 99,
          ownCheckName: "MergeProof / evidence",
        },
      },
    );

    assert.deepEqual(await worker.processNext(), {
      state: "processed",
      deliveryId: "check-run-1",
      detail: "re-evaluated 2 pull requests after a completed check run",
    });
    assert.deepEqual(processed, [
      "check_completed:acme/checkout-service#42",
      "check_completed:acme/checkout-service#43",
    ]);
  } finally {
    ledger.close();
  }
});

test("a linked-issue edit re-evaluates only queued PRs sealed to that issue", async () => {
  const ledger = new RunLedger();
  const revision = { ...demoRevision, issueContextDigest: "issue-before-edit" };
  try {
    const claim = ledger.claim(revision, "proof-worker", 60_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      revision,
      demoVerificationPolicy,
      new Date(10),
    );
    receipt.issueToProof = {
      source: "pull_request",
      pullRequestTitle: "sealed only for test setup",
      linkedIssue: {
        number: 42,
        source: "pull_request_description",
        contentDigest: "issue-before-edit",
        titleBytes: 10,
        bodyBytes: 10,
      },
      scenarioBindings: [],
    };
    const { integrityHash: _oldIntegrityHash, ...unsignedReceipt } = receipt;
    ledger.recordReceipt(claim.lease, sealReceipt(unsignedReceipt), 11);
    ledger.beginPublication(claim.lease, 12);
    ledger.markQueued(claim.lease, 13);
    const body = JSON.stringify({
      action: "edited",
      installation: { id: 9 },
      repository: { id: 10, full_name: "acme/checkout-service" },
      issue: { number: 42, body: "untrusted edited body" },
    });
    assert.equal(ledger.enqueueWebhook("issue-edit-1", "issues", body, 20), true);
    const processed: string[] = [];
    const worker = new WebhookWorker(
      ledger,
      {
        process: async (trigger) => {
          processed.push(`${trigger.action}:${trigger.repository}#${trigger.pullRequest}`);
          return { state: "not_eligible", reason: "queue membership revoked after fresh issue read" };
        },
      },
      "worker-1",
      3,
    );

    assert.deepEqual(await worker.processNext(), {
      state: "processed",
      deliveryId: "issue-edit-1",
      detail: "not_eligible",
    });
    assert.deepEqual(processed, ["linked_issue_edited:acme/checkout-service#42"]);
  } finally {
    ledger.close();
  }
});

test("GitHub merge-candidate wait states are deferred rather than dropped", async () => {
  const ledger = new RunLedger();
  try {
    const body = JSON.stringify({
      action: "synchronize",
      number: 42,
      installation: { id: 9 },
      repository: { id: 10, full_name: "acme/checkout-service" },
    });
    assert.equal(ledger.enqueueWebhook("waiting-1", "pull_request", body, 10), true);
    const worker = new WebhookWorker(
      ledger,
      {
        process: async () => ({
          state: "waiting" as const,
          reason: "GitHub has not produced a test merge SHA yet.",
        }),
      },
      "worker-1",
      3,
      () => 20,
    );
    assert.deepEqual(await worker.processNext(), {
      state: "retried",
      deliveryId: "waiting-1",
      detail: "GitHub has not produced a test merge SHA yet.",
    });
    assert.equal(ledger.claimWebhook("worker-2", 1_000, 5_019), null);
    const next = ledger.claimWebhook("worker-2", 1_000, 5_020);
    assert.equal(next?.deliveryId, "waiting-1");
    assert.equal(next?.attempt, 1);
  } finally {
    ledger.close();
  }
});

test("webhook failures use exponential backoff before consuming another attempt", () => {
  const ledger = new RunLedger();
  try {
    assert.equal(ledger.enqueueWebhook("retry-1", "pull_request", "{}", 10), true);
    const first = ledger.claimWebhook("worker-1", 1_000, 20);
    assert.ok(first);
    if (!first) return;

    ledger.retryWebhook(first.lease, "temporary GitHub failure", 20);
    assert.equal(ledger.claimWebhook("worker-2", 1_000, 1_019), null);

    const second = ledger.claimWebhook("worker-2", 1_000, 1_020);
    assert.ok(second);
    if (!second) return;
    assert.equal(second.attempt, 2);

    ledger.retryWebhook(second.lease, "temporary E2B failure", 1_020);
    assert.equal(ledger.claimWebhook("worker-3", 1_000, 3_019), null);
    assert.equal(ledger.claimWebhook("worker-3", 1_000, 3_020)?.attempt, 3);
  } finally {
    ledger.close();
  }
});

test("a terminal transient webhook failure receives one delayed durable re-drive without a new GitHub delivery", async () => {
  const ledger = new RunLedger();
  try {
    const body = JSON.stringify({
      action: "synchronize",
      number: 42,
      installation: { id: 9 },
      repository: { id: 10, full_name: "acme/checkout-service" },
    });
    assert.equal(ledger.enqueueWebhook("dead-letter-1", "pull_request", body, 10), true);
    let now = 20;
    let calls = 0;
    const worker = new WebhookWorker(
      ledger,
      {
        process: async () => {
          calls += 1;
          if (calls <= 3) {
            throw new Error("temporary upstream outage");
          }
          return { state: "ignored", reason: "upstream recovered" };
        },
      },
      "worker-1",
      3,
      () => now,
    );

    assert.equal((await worker.processNext()).state, "retried");
    now = 1_020;
    assert.equal((await worker.processNext()).state, "retried");
    now = 3_020;
    assert.equal((await worker.processNext()).state, "failed");
    assert.deepEqual(ledger.getWebhookEventMetadata("dead-letter-1"), {
      status: "dead_letter",
      bodyRetained: true,
      bodyBytes: Buffer.byteLength(body),
      attemptCount: 3,
      deadLetterReplayCount: 0,
    });

    now = 303_019;
    assert.deepEqual(await worker.processNext(), { state: "idle" });
    now = 303_020;
    assert.deepEqual(await worker.processNext(), {
      state: "processed",
      deliveryId: "dead-letter-1",
      detail: "ignored",
    });
    assert.equal(calls, 4);
    assert.deepEqual(ledger.getWebhookEventMetadata("dead-letter-1"), {
      status: "completed",
      bodyRetained: false,
      bodyBytes: 0,
      attemptCount: 1,
      deadLetterReplayCount: 1,
    });
  } finally {
    ledger.close();
  }
});

test("merge-group deliveries reach the queue-verification controller", async () => {
  const ledger = new RunLedger();
  try {
    const body = JSON.stringify({
      action: "checks_requested",
      installation: { id: 9 },
      repository: { id: 10, full_name: "acme/checkout-service" },
      merge_group: { base_sha: "abcdef1", head_sha: "1234567" },
    });
    assert.equal(ledger.enqueueWebhook("group-1", "merge_group", body, 10), true);
    const processed: string[] = [];
    const worker = new WebhookWorker(
      ledger,
      {
        process: async () => {
          throw new Error("pull-request controller should not receive a merge group");
        },
      },
      "worker-1",
      3,
      () => 20,
      {
        process: async (trigger) => {
          processed.push(`${trigger.baseSha}:${trigger.headSha}`);
          return { state: "reported" as const, receipt: {} as EvidenceReceipt };
        },
      },
    );
    assert.deepEqual(await worker.processNext(), {
      state: "processed",
      deliveryId: "group-1",
      detail: "reported",
    });
    assert.deepEqual(processed, ["abcdef1:1234567"]);
  } finally {
    ledger.close();
  }
});

test("E2B harness parser rejects malformed claimed evidence", () => {
  assert.throws(
    () => parseHarnessResult("MERGEPROOF_RESULT={\"harnessVersion\":\"v1\",\"checks\":[{}],\"metrics\":[]}"),
    /invalid/i,
  );

  const parsed = parseHarnessResult(
    'noise\nMERGEPROOF_RESULT={"harnessVersion":"v1","checks":[{"id":"ci","kind":"deterministic_gate","required":true,"status":"pass","detail":"ok"}],"metrics":[]}\n',
  );
  assert.equal(parsed.harnessVersion, "v1");
  assert.equal(parsed.checks[0]?.id, "ci");
});
