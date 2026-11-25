import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  validateAndCompileClaimContract,
  type ClaimContractCandidate,
} from "../src/claim-compiler.js";
import { canonicalJson, sha256 } from "../src/crypto.js";
import type { ImpactMap } from "../src/impact-mapper.js";
import { planningIdentity } from "../src/proof-identity.js";
import { buildProofPlan } from "../src/proof-plan.js";
import {
  ProofPlanningBundleTooLargeError,
  ProofPlanStore,
  StaleProofPlanningLeaseError,
  type ProofPlanningArtifacts,
} from "../src/proof-plan-store.js";
import { parseTrustedReplayProfile } from "../src/replay-profile.js";

const revision = {
  repository: "mergeproof/demo",
  pullRequest: 42,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};
const authority = { class: "REPOSITORY_POLICY", reference: "policy:retry-v1" } as const;

function replay(id: string, fixtureId: string) {
  return {
    id,
    claimIds: ["retry-idempotent"],
    setup: { fixtures: [{ name: "job", fixtureId, parameters: { jobId: "job-42" } }] },
    requests: [{ id: "retry", method: "POST" as const, path: "/jobs/job-42/retry", query: [] }],
    assertions: [{
      id: "image-count",
      kind: "state" as const,
      fixture: "job",
      path: "/imageCount",
      predicate: { operator: "equals" as const, expected: 1 },
    }],
  };
}

function candidate(): ClaimContractCandidate {
  return {
    schemaVersion: 1,
    revision,
    expectedBehaviors: [{
      id: "retry-idempotent",
      when: "the same image job is retried",
      then: "one image and one charge exist",
      authority,
      supportingAuthorities: [],
      mandatory: true,
    }],
    invariants: [],
    failureSignatures: [],
    positiveControls: [{
      id: "single-submit",
      description: "one submission succeeds",
      claimIds: ["retry-idempotent"],
      replayPlanId: "positive",
      authority,
      supportingAuthorities: [],
      mandatory: true,
    }],
    negativeControls: [{
      id: "duplicate-detector",
      description: "duplicates fail",
      claimIds: ["retry-idempotent"],
      replayPlanId: "negative",
      authority,
      supportingAuthorities: [],
      mandatory: true,
    }],
    ambiguities: [],
    replayPlans: [replay("primary", "empty"), replay("positive", "single"), replay("negative", "duplicate")],
  };
}

function impactMap(): ImpactMap {
  return {
    schemaVersion: 1,
    status: "complete",
    diffFiles: [{
      oldPath: "src/jobs.ts",
      newPath: "src/jobs.ts",
      change: "modified",
      classifications: ["source"],
      hunks: [{
        oldStart: 10,
        oldCount: 1,
        newStart: 10,
        newCount: 2,
        section: "retry",
        classifications: ["control_flow"],
        changes: [{ kind: "added", line: 10, content: "if (seen) return;" }],
      }],
    }],
    changedSymbols: [],
    affectedFiles: [{ path: "src/jobs.ts", reasons: ["changed"] }],
    workflows: [],
    unresolvedPaths: [],
    stats: {
      repositoryFiles: 1,
      repositoryBytes: 100,
      diffFiles: 1,
      hunks: 1,
      changedLines: 1,
      parsedSourceFiles: 1,
      analyzedSymbols: 0,
    },
  };
}

function profile() {
  const fixture = (id: string) => ({
    id,
    setupEndpoint: { method: "POST" as const, path: `/__proof/setup/${id}`, expectedStatus: 204 },
    stateEndpoint: { method: "GET" as const, path: `/__proof/state/${id}`, expectedStatus: 200 },
  });
  return parseTrustedReplayProfile({
    schemaVersion: 1,
    version: "retry-v1",
    application: {
      runtime: "node",
      cwd: ".",
      executable: "node",
      args: ["src/server.mjs"],
      env: { NODE_ENV: "test" },
      port: 4_321,
      health: {
        method: "GET",
        path: "/healthz",
        expectedStatus: 200,
        timeoutMs: 5_000,
        intervalMs: 50,
      },
      shutdownGraceMs: 500,
    },
    operations: [{ id: "retry-job", method: "POST", pathTemplate: "/jobs/job-42/retry", allowedQueryKeys: [], allowedBodyKeys: [], maxInvocations: 1 }],
    fixtures: [fixture("empty"), fixture("single"), fixture("duplicate")],
  });
}

function artifacts(): ProofPlanningArtifacts {
  const claimContract = validateAndCompileClaimContract(candidate(), {
    revision,
    trustedAuthorityReferences: [authority],
  });
  const impact = impactMap();
  const replayProfile = profile();
  return {
    claimContract,
    impactMap: impact,
    proofPlan: buildProofPlan({ claimContract, impactMap: impact, replayProfile }),
    replayProfile,
  };
}

function analysisKey(): string {
  const digest = (value: string) => sha256(value);
  return planningIdentity({
    repository: revision.repository,
    pullRequest: revision.pullRequest,
    baseSha: revision.baseSha,
    headSha: revision.headSha,
    mergeSha: "c".repeat(40),
    diffDigest: digest("diff"),
    issueContextDigest: digest("issue"),
    baseContractDigest: digest("base-contract"),
    policyHash: digest("policy"),
    trustedArtifactDigest: digest("artifacts"),
    compiler: {
      model: "gpt-5.4",
      promptDigest: digest("prompt"),
      schemaVersion: 1,
      toolVersion: "claim-compiler-v1",
    },
  });
}

test("claims an analysis identity before planning and returns the sealed bundle on retries", () => {
  const store = new ProofPlanStore();
  try {
    const claimed = store.claim(analysisKey(), "planner-a", 1_000, 10);
    assert.equal(claimed.state, "claimed");
    if (claimed.state !== "claimed") return;

    assert.deepEqual(store.claim(analysisKey(), "planner-b", 1_000, 11), {
      state: "busy",
      retryAt: 1_010,
    });
    const sealed = store.seal(claimed.lease, artifacts(), 12);
    assert.match(sealed.bundleDigest, /^[a-f0-9]{64}$/);
    assert.match(sealed.bundle.evidenceKey, /^[a-f0-9]{64}$/);
    assert.equal(sealed.bundle.analysisKey, analysisKey());
    assert.equal(sealed.bundle.proofPlan.digest, sha256(canonicalJson(sealed.bundle.proofPlan.plan)));

    const retry = store.claim(analysisKey(), "planner-b", 1_000, 13);
    assert.equal(retry.state, "sealed");
    if (retry.state === "sealed") assert.deepEqual(retry.record, sealed);
    assert.deepEqual(store.seal(claimed.lease, artifacts(), 14), sealed);

    const conflicting = artifacts();
    conflicting.proofPlan.plan.limitations.push("different-valid-plan");
    conflicting.proofPlan.digest = sha256(canonicalJson(conflicting.proofPlan.plan));
    assert.throws(
      () => store.seal(claimed.lease, conflicting, 15),
      /already sealed with a different bundle/i,
    );
  } finally {
    store.close();
  }
});

test("expired planning leases are fenced and stale writers cannot seal", () => {
  const store = new ProofPlanStore();
  try {
    const first = store.claim(analysisKey(), "planner-a", 100, 10);
    assert.equal(first.state, "claimed");
    if (first.state !== "claimed") return;
    const replacement = store.claim(analysisKey(), "planner-b", 100, 111);
    assert.equal(replacement.state, "claimed");
    if (replacement.state !== "claimed") return;
    assert.equal(replacement.lease.fenceToken, first.lease.fenceToken + 1);
    assert.throws(
      () => store.seal(first.lease, artifacts(), 112),
      StaleProofPlanningLeaseError,
    );
    assert.throws(
      () => store.renew(first.lease, 100, 112),
      StaleProofPlanningLeaseError,
    );

    const renewed = store.renew(replacement.lease, 200, 112);
    assert.equal(renewed.expiresAt, 312);
    assert.equal(store.seal(renewed, artifacts(), 113).bundle.analysisKey, analysisKey());
    assert.throws(
      () => store.seal(first.lease, artifacts(), 114),
      StaleProofPlanningLeaseError,
    );
  } finally {
    store.close();
  }
});

test("a sealed normalized bundle survives closing and reopening SQLite", () => {
  const directory = mkdtempSync(path.join(tmpdir(), "mergeproof-plan-store-"));
  const databasePath = path.join(directory, "planning.sqlite");
  try {
    const firstStore = new ProofPlanStore(databasePath);
    const claim = firstStore.claim(analysisKey(), "planner-a", 1_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const expected = firstStore.seal(claim.lease, artifacts(), 11);
    firstStore.close();

    const reopened = new ProofPlanStore(databasePath);
    try {
      assert.deepEqual(reopened.getSealed(analysisKey()), expected);
      const retry = reopened.claim(analysisKey(), "planner-b", 1_000, 12);
      assert.equal(retry.state, "sealed");
      if (retry.state === "sealed") assert.deepEqual(retry.record, expected);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rejects oversized planning JSON before writing a sealed row", () => {
  const store = new ProofPlanStore(":memory:", { maxBundleBytes: 1_000 });
  try {
    const claim = store.claim(analysisKey(), "planner-a", 1_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    assert.throws(
      () => store.seal(claim.lease, artifacts(), 11),
      ProofPlanningBundleTooLargeError,
    );
    assert.equal(store.getSealed(analysisKey()), null);
  } finally {
    store.close();
  }
});

test("refuses mismatched artifact digests instead of sealing an inconsistent plan", () => {
  const store = new ProofPlanStore();
  try {
    const claim = store.claim(analysisKey(), "planner-a", 1_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const inconsistent = artifacts();
    inconsistent.proofPlan = { ...inconsistent.proofPlan, digest: sha256("wrong") };
    assert.throws(
      () => store.seal(claim.lease, inconsistent, 11),
      /Proof plan digest does not match/i,
    );
    assert.equal(store.getSealed(analysisKey()), null);
  } finally {
    store.close();
  }
});
