import assert from "node:assert/strict";
import test from "node:test";

import { judgeClaimProof, type ExperimentObservation } from "../src/deterministic-judge.js";
import type { ProofExperiment, ProofPlan } from "../src/proof-plan.js";

function experiment(id: string, kind: ProofExperiment["kind"]): ProofExperiment {
  return {
    id,
    kind,
    sourcePlanId: id,
    claimIds: ["claim"],
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
    revision: { repository: "mergeproof/demo", pullRequest: 1, baseSha: "a".repeat(40), headSha: "b".repeat(40) },
    inputs: { claimContractDigest: "a".repeat(64), impactMapDigest: "b".repeat(64), replayProfileDigest: "c".repeat(64) },
    experiments: [experiment("primary", "primary"), experiment("positive", "positive_control"), experiment("negative", "negative_control")],
    impactTargets: [{ id: "hunk:server:1", path: "server.mjs", kind: "hunk", detail: "control_flow" }],
    coverage: { mandatoryClaimIds: ["claim"], primaryClaimIds: ["claim"], unmappedMandatoryClaimIds: [], changedFiles: ["server.mjs"], changedSymbolIds: [], workflowIds: [] },
    blockingReasons: [],
    reviewReasons: [],
    limitations: [],
  };
}

function goodObservations(): ExperimentObservation[] {
  return [
    ["primary", "base", "fail"], ["primary", "candidate", "pass"], ["primary", "ablation", "fail"],
    ["positive", "base", "pass"], ["positive", "candidate", "pass"], ["positive", "ablation", "pass"],
    ["negative", "base", "fail"], ["negative", "candidate", "fail"], ["negative", "ablation", "fail"],
  ].map(([experimentId, phase, observed]) => ({
    experimentId: experimentId!,
    phase: phase as ExperimentObservation["phase"],
    observed: observed as ExperimentObservation["observed"],
    artifactDigest: "d".repeat(64),
  }));
}

test("merges only complete base-red candidate-green ablation-red evidence with closure", () => {
  const judgment = judgeClaimProof({
    plan: plan(),
    observations: goodObservations(),
    targetCoverage: { primary: ["hunk:server:1"] },
  });
  assert.equal(judgment.decision, "MERGE");
  assert.deepEqual(judgment.reasons, []);
});

test("candidate failure repairs while missing causality or closure blocks", () => {
  const broken = goodObservations();
  broken.find((entry) => entry.experimentId === "primary" && entry.phase === "candidate")!.observed = "fail";
  assert.equal(judgeClaimProof({ plan: plan(), observations: broken, targetCoverage: {} }).decision, "REPAIR");

  const noCausality = goodObservations();
  noCausality.find((entry) => entry.experimentId === "primary" && entry.phase === "ablation")!.observed = "pass";
  const blocked = judgeClaimProof({ plan: plan(), observations: noCausality, targetCoverage: {} });
  assert.equal(blocked.decision, "BLOCK");
  assert.ok(blocked.reasons.some((reason) => reason.startsWith("uncovered-impact-target:")));
});

test("review or blocked plans never execute into merge authority", () => {
  const value = plan();
  value.status = "review";
  value.reviewReasons = ["unresolved-ambiguity:medium:provider-timeout"];
  assert.equal(judgeClaimProof({ plan: value, observations: goodObservations(), targetCoverage: {} }).decision, "BLOCK");
});
