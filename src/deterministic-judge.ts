import type { ProofExperiment, ProofPlan } from "./proof-plan.js";

export type ClaimProofPhase = "base" | "candidate" | "ablation";
export type ClaimProofDecision = "MERGE" | "REPAIR" | "SPLIT" | "BLOCK";

export interface ExperimentObservation {
  experimentId: string;
  phase: ClaimProofPhase;
  observed: "pass" | "fail" | "unsupported";
  artifactDigest: string;
}

export interface DeterministicClaimProofJudgment {
  decision: ClaimProofDecision;
  reasons: string[];
  satisfiedExperimentIds: string[];
  uncoveredImpactTargetIds: string[];
}

function key(experimentId: string, phase: ClaimProofPhase): string {
  return `${experimentId}:${phase}`;
}

function expected(experiment: ProofExperiment, phase: ClaimProofPhase): "pass" | "fail" {
  return experiment.expected[phase];
}

/**
 * A whole-patch ablation can conservatively close impact only for a narrowly
 * shaped proof: one changed file, at most one changed symbol, one affected
 * workflow, and one mandatory primary experiment. Larger changes remain
 * uncovered until the trusted runner can report finer-grained instrumentation.
 */
export function deriveCausalTargetCoverage(
  plan: ProofPlan,
): Readonly<Record<string, readonly string[]>> {
  const primary = plan.experiments.filter(
    (experiment) => experiment.kind === "primary" && experiment.mandatory,
  );
  if (
    plan.status !== "ready" ||
    primary.length !== 1 ||
    plan.coverage.changedFiles.length !== 1 ||
    plan.coverage.changedSymbolIds.length > 1 ||
    plan.coverage.workflowIds.length > 1 ||
    plan.impactTargets.length === 0
  ) {
    return {};
  }
  return {
    [primary[0]!.id]: plan.impactTargets.map(({ id }) => id).sort(),
  };
}

/**
 * The final authority is intentionally boring: it compares sealed expected
 * observations with typed runner output. It cannot waive a missing experiment,
 * reinterpret model prose, or merge on confidence.
 */
export function judgeClaimProof(input: {
  plan: ProofPlan;
  observations: readonly ExperimentObservation[];
  targetCoverage: Readonly<Record<string, readonly string[]>>;
}): DeterministicClaimProofJudgment {
  if (input.plan.status !== "ready") {
    return {
      decision: "BLOCK",
      reasons: [`proof-plan-${input.plan.status}`, ...input.plan.blockingReasons, ...input.plan.reviewReasons],
      satisfiedExperimentIds: [],
      uncoveredImpactTargetIds: input.plan.impactTargets.map(({ id }) => id),
    };
  }
  const observations = new Map<string, ExperimentObservation>();
  const reasons: string[] = [];
  const experimentIds = new Set(input.plan.experiments.map(({ id }) => id));
  for (const observation of input.observations) {
    const observationKey = key(observation.experimentId, observation.phase);
    if (!experimentIds.has(observation.experimentId)) {
      reasons.push(`unknown-observation:${observationKey}`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(observation.artifactDigest)) {
      reasons.push(`invalid-artifact-digest:${observationKey}`);
      continue;
    }
    if (observations.has(observationKey)) {
      reasons.push(`duplicate-observation:${observationKey}`);
      continue;
    }
    observations.set(observationKey, observation);
  }

  const impactTargetIds = new Set(input.plan.impactTargets.map(({ id }) => id));
  for (const [experimentId, targetIds] of Object.entries(input.targetCoverage)) {
    const experiment = input.plan.experiments.find(({ id }) => id === experimentId);
    if (!experiment || experiment.kind !== "primary") {
      reasons.push(`unknown-coverage-experiment:${experimentId}`);
      continue;
    }
    for (const targetId of targetIds) {
      if (!impactTargetIds.has(targetId)) {
        reasons.push(`unknown-coverage-target:${experimentId}:${targetId}`);
      }
    }
  }

  const satisfiedExperimentIds: string[] = [];
  let candidateFailure = false;
  let mixedPrimaryOutcome = false;
  const primaryCandidateOutcomes: boolean[] = [];
  for (const experiment of input.plan.experiments.filter(({ mandatory }) => mandatory)) {
    let satisfied = true;
    for (const phase of ["base", "candidate", "ablation"] as const) {
      const observation = observations.get(key(experiment.id, phase));
      if (!observation) {
        reasons.push(`missing-observation:${experiment.id}:${phase}`);
        satisfied = false;
        continue;
      }
      if (observation.observed === "unsupported") {
        reasons.push(`unsupported-observation:${experiment.id}:${phase}`);
        satisfied = false;
      } else if (observation.observed !== expected(experiment, phase)) {
        reasons.push(
          `unexpected-observation:${experiment.id}:${phase}:expected-${expected(experiment, phase)}:observed-${observation.observed}`,
        );
        satisfied = false;
        if (phase === "candidate") candidateFailure = true;
      }
    }
    if (experiment.kind === "primary") primaryCandidateOutcomes.push(satisfied);
    if (satisfied) satisfiedExperimentIds.push(experiment.id);
  }
  if (primaryCandidateOutcomes.some(Boolean) && primaryCandidateOutcomes.some((value) => !value)) {
    mixedPrimaryOutcome = true;
  }

  const covered = new Set<string>();
  for (const experimentId of satisfiedExperimentIds) {
    const experiment = input.plan.experiments.find(({ id }) => id === experimentId);
    if (experiment?.kind !== "primary") continue;
    for (const targetId of input.targetCoverage[experimentId] ?? []) {
      if (impactTargetIds.has(targetId)) covered.add(targetId);
    }
  }
  const uncoveredImpactTargetIds = input.plan.impactTargets
    .map(({ id }) => id)
    .filter((targetId) => !covered.has(targetId))
    .sort();
  for (const targetId of uncoveredImpactTargetIds) reasons.push(`uncovered-impact-target:${targetId}`);

  const uniqueReasons = [...new Set(reasons)].sort();
  const decision: ClaimProofDecision = uniqueReasons.length === 0
    ? "MERGE"
    : mixedPrimaryOutcome
      ? "SPLIT"
      : candidateFailure
        ? "REPAIR"
        : "BLOCK";
  return {
    decision,
    reasons: uniqueReasons,
    satisfiedExperimentIds: [...satisfiedExperimentIds].sort(),
    uncoveredImpactTargetIds,
  };
}
