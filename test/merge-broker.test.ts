import assert from "node:assert/strict";
import test from "node:test";

import type { LivePullRequest, PinnedRevision } from "../src/domain.js";
import {
  demoMergePolicy,
  demoRevision,
  demoVerificationPolicy,
  safeFixture,
} from "../src/fixtures.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import { RunLedger } from "../src/ledger.js";
import { MemoryMergeGateway, MergeBroker } from "../src/merge-broker.js";
import type { MergeGateway } from "../src/merge-broker.js";
import { preflight } from "../src/merge-broker.js";
import { VerificationEngine } from "../src/verifier.js";

function live(revision: PinnedRevision): LivePullRequest {
  return {
    nodeId: "PR_kwDOFixture42",
    repository: revision.repository,
    pullRequest: revision.pullRequest,
    state: "open",
    draft: false,
    baseSha: revision.baseSha,
    headSha: revision.headSha,
    mergeSha: revision.mergeSha,
    title: "Prevent duplicate checkout settlement",
    description: "Fixture PR for merge broker tests.",
    diff: "diff --git a/checkout.ts b/checkout.ts\n+// fixture diff",
    labels: ["mergeproof:auto"],
    approvals: 1,
    checks: [
      { name: "ci / test", status: "pass" },
      { name: "ci / security", status: "pass" },
    ],
  };
}

async function verifiedRun() {
  const revision = { ...demoRevision, headSha: "head-broker", mergeSha: "merge-broker" };
  const now = new Date("2026-07-14T18:00:00.000Z");
  const ledger = new RunLedger();
  const claim = ledger.claim(revision, "worker", 60_000, now.getTime());
  if (claim.state !== "claimed") throw new Error("Unable to claim test run.");
  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(safeFixture()),
  ).verify(revision, demoVerificationPolicy, now);
  ledger.recordReceipt(claim.lease, receipt, now.getTime());
  return { revision, now, ledger, receipt, lease: claim.lease, installationId: 99 };
}

test("exact-head preflight merges only a fully eligible receipt", async () => {
  const run = await verifiedRun();
  try {
    const gateway = new MemoryMergeGateway(live(run.revision));
    const decision = await new MergeBroker(gateway, run.ledger).mergeIfEligible({
      ...run,
      policy: demoMergePolicy,
    });

    assert.equal(decision.outcome, "MERGED");
    assert.equal(gateway.mergeCalls, 1);
    assert.equal(run.ledger.get(run.revision)?.outcome, "MERGED");
    assert.equal(
      run.ledger.getExternalOperation(`direct_merge:${run.receipt.runKey}`)?.installationId,
      99,
    );
  } finally {
    run.ledger.close();
  }
});

test("a changed head invalidates the receipt without calling merge", async () => {
  const run = await verifiedRun();
  try {
    const gateway = new MemoryMergeGateway({ ...live(run.revision), headSha: "new-head" });
    const decision = await new MergeBroker(gateway, run.ledger).mergeIfEligible({
      ...run,
      policy: demoMergePolicy,
    });

    assert.equal(decision.outcome, "STALE");
    assert.equal(gateway.mergeCalls, 0);
    assert.equal(run.ledger.get(run.revision)?.outcome, "STALE");
  } finally {
    run.ledger.close();
  }
});

test("missing live policy checks never reaches the merge gateway", async () => {
  const run = await verifiedRun();
  try {
    const gateway = new MemoryMergeGateway({
      ...live(run.revision),
      checks: [{ name: "ci / test", status: "pass" }],
    });
    const decision = await new MergeBroker(gateway, run.ledger).mergeIfEligible({
      ...run,
      policy: demoMergePolicy,
    });

    assert.equal(decision.outcome, "NOT_ELIGIBLE");
    assert.equal(gateway.mergeCalls, 0);
    assert.equal(run.ledger.get(run.revision)?.decision?.state, "not_eligible");
  } finally {
    run.ledger.close();
  }
});

test("a same-named check from the wrong GitHub App cannot satisfy a source-pinned requirement", async () => {
  const run = await verifiedRun();
  try {
    const sourcePinnedPolicy = {
      ...demoMergePolicy,
      requiredCheckAppIds: {
        "ci / test": 101,
        "ci / security": 101,
      },
    };
    const reason = preflight(run.revision, run.receipt, sourcePinnedPolicy, {
      ...live(run.revision),
      checks: [
        { name: "ci / test", status: "pass", appId: 7 },
        { name: "ci / security", status: "pass", appId: 101 },
      ],
    });
    assert.match(reason ?? "", /ci \/ test \(App 101\)/);
  } finally {
    run.ledger.close();
  }
});

test("an ambiguous merge request is never retried automatically", async () => {
  const run = await verifiedRun();
  try {
    const gateway: MergeGateway = {
      getPullRequest: async () => live(run.revision),
      merge: async () => {
        throw new Error("network timeout after merge request write");
      },
    };
    const decision = await new MergeBroker(gateway, run.ledger).mergeIfEligible({
      ...run,
      policy: demoMergePolicy,
    });

    assert.equal(decision.outcome, "MERGE_UNKNOWN");
    assert.equal(run.ledger.get(run.revision)?.status, "merge_unknown");
    assert.deepEqual(run.ledger.claim(run.revision, "retry-worker", 60_000), {
      state: "reconciliation_required",
    });
  } finally {
    run.ledger.close();
  }
});
