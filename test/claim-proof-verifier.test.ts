import assert from "node:assert/strict";
import test from "node:test";

import { verifyReceipt } from "../src/crypto.js";
import type { GeneratedExperimentObservation, PinnedRevision } from "../src/domain.js";
import { demoRevision, demoVerificationPolicy, safeFixture } from "../src/fixtures.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import type { ProofExperiment, ProofPlan } from "../src/proof-plan.js";
import type { SealedProofPlanningBundle } from "../src/proof-plan-store.js";
import { parseTrustedReplayProfile } from "../src/replay-profile.js";
import { VerificationEngine } from "../src/verifier.js";

const digest = (letter: string): string => letter.repeat(64);

function experiment(id: string, kind: ProofExperiment["kind"]): ProofExperiment {
  return {
    id,
    kind,
    sourcePlanId: id,
    claimIds: ["retry-idempotent"],
    mandatory: true,
    fixtures: [],
    requests: [],
    assertions: [],
    expected: kind === "primary"
      ? { base: "fail", candidate: "pass", ablation: "fail" }
      : kind === "positive_control"
        ? { base: "pass", candidate: "pass", ablation: "pass" }
        : { base: "fail", candidate: "fail", ablation: "fail" },
  };
}

function plan(): ProofPlan {
  return {
    schemaVersion: 1,
    status: "ready",
    revision: {
      repository: demoRevision.repository,
      pullRequest: demoRevision.pullRequest,
      baseSha: demoRevision.baseSha,
      headSha: demoRevision.headSha,
    },
    inputs: {
      claimContractDigest: digest("a"),
      impactMapDigest: digest("b"),
      replayProfileDigest: digest("c"),
    },
    experiments: [
      experiment("primary-retry", "primary"),
      experiment("positive-normal", "positive_control"),
      experiment("negative-detector", "negative_control"),
    ],
    impactTargets: [
      { id: "hunk:jobs.py:1", path: "jobs.py", kind: "hunk", detail: "control_flow" },
      { id: "symbol:jobs.generate", path: "jobs.py", kind: "symbol", detail: "function:generate" },
      { id: "workflow:worker.run", path: "worker.py", kind: "workflow", detail: "worker:caller" },
    ],
    coverage: {
      mandatoryClaimIds: ["retry-idempotent"],
      primaryClaimIds: ["retry-idempotent"],
      unmappedMandatoryClaimIds: [],
      changedFiles: ["jobs.py"],
      changedSymbolIds: ["symbol:jobs.generate"],
      workflowIds: ["workflow:worker.run"],
    },
    blockingReasons: [],
    reviewReasons: [],
    limitations: [],
  };
}

function observation(
  id: string,
  kind: GeneratedExperimentObservation["kind"],
  observed: GeneratedExperimentObservation["observed"],
): GeneratedExperimentObservation {
  return {
    id,
    kind,
    observed,
    assertions: 2,
    failedAssertionIds: observed === "fail" ? ["duplicate"] : [],
    artifactDigest: digest("d"),
  };
}

function preparedBundle(proofPlan: ProofPlan): SealedProofPlanningBundle {
  const replayProfile = parseTrustedReplayProfile({
    schemaVersion: 1,
    version: "python-retry-v1",
    application: {
      runtime: "python",
      executable: "python3",
      cwd: ".",
      args: ["server.py"],
      env: {},
      port: 4_321,
      health: { method: "GET", path: "/healthz", expectedStatus: 200, timeoutMs: 1_000, intervalMs: 25 },
      shutdownGraceMs: 100,
    },
    operations: [{ id: "retry-job", method: "POST", pathTemplate: "/jobs/{job_id}/generate", allowedQueryKeys: [], allowedBodyKeys: [], maxInvocations: 2 }],
    fixtures: [],
  });
  return {
    schemaVersion: 1,
    analysisKey: digest("e"),
    evidenceKey: digest("f"),
    claimContract: {} as SealedProofPlanningBundle["claimContract"],
    impactMap: {} as SealedProofPlanningBundle["impactMap"],
    proofPlan: { plan: proofPlan, digest: digest("9") },
    replayProfile,
  };
}

function scenario(proofPlanDigest: string) {
  const value = safeFixture();
  const phase = (
    primary: "pass" | "fail",
    positive: "pass" | "fail",
    negative: "pass" | "fail",
  ) => ({
    proofPlanDigest,
    experiments: [
      observation("primary-retry", "primary", primary),
      observation("positive-normal", "positive_control", positive),
      observation("negative-detector", "negative_control", negative),
    ],
  });
  value.base.generatedProof = phase("fail", "pass", "fail");
  value.candidate.generatedProof = phase("pass", "pass", "fail");
  value.ablation = structuredClone(value.base);
  value.ablation.generatedProof = phase("fail", "pass", "fail");
  return value;
}

test("generated proof is sealed into the receipt only after base, candidate, and ablation agree", async () => {
  const proofPlan = plan();
  const bundle = preparedBundle(proofPlan);
  const revision: PinnedRevision = {
    ...demoRevision,
    claimProofEvidenceIdentity: bundle.evidenceKey,
  };
  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(scenario(bundle.proofPlan.digest)),
  ).verify(
    revision,
    demoVerificationPolicy,
    new Date("2026-07-16T18:00:00.000Z"),
    undefined,
    { bundle, ablationDiff: "diff --git a/jobs.py b/jobs.py\n" },
  );

  assert.equal(receipt.verdict, "LOW_OBSERVED_RISK");
  assert.equal(receipt.claimProof?.judgment.decision, "MERGE");
  assert.equal(receipt.claimProof?.phases.base.experiments[0]?.observed, "fail");
  assert.equal(receipt.claimProof?.phases.candidate.experiments[0]?.observed, "pass");
  assert.equal(receipt.claimProof?.phases.ablation.experiments[0]?.observed, "fail");
  assert.equal(verifyReceipt(receipt), true);
});

test("a missing causal observation blocks the generated claim proof", async () => {
  const proofPlan = plan();
  const bundle = preparedBundle(proofPlan);
  const evidence = scenario(bundle.proofPlan.digest);
  evidence.ablation!.generatedProof!.experiments = evidence.ablation!.generatedProof!.experiments.filter(
    ({ id }) => id !== "primary-retry",
  );
  const receipt = await new VerificationEngine(new FixtureEvidenceHarness(evidence)).verify(
    { ...demoRevision, claimProofEvidenceIdentity: bundle.evidenceKey },
    demoVerificationPolicy,
    new Date("2026-07-16T18:00:00.000Z"),
    undefined,
    { bundle, ablationDiff: "diff --git a/jobs.py b/jobs.py\n" },
  );

  assert.equal(receipt.verdict, "BLOCK");
  assert.equal(receipt.claimProof?.judgment.decision, "BLOCK");
  assert.ok(receipt.claimProof?.judgment.reasons.some((reason) => reason.includes("missing-observation")));
});
