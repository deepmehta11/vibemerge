import { z } from "zod";

import {
  normalizedClaimContractSchema,
  type BoundedJsonValue,
  type CompiledClaimContract,
  type HttpReplayPlan,
  type ReplayAssertion,
  type ReplayRequest,
} from "./claim-compiler.js";
import { canonicalJson, sha256 } from "./crypto.js";
import type { ImpactMap } from "./impact-mapper.js";
import {
  parseTrustedReplayProfile,
  trustedReplayProfileDigest,
  type TrustedReplayProfile,
} from "./replay-profile.js";

export type ProofExperimentKind = "primary" | "positive_control" | "negative_control";
export type ProofExpectation = "pass" | "fail";

export interface ProofFixtureBinding {
  name: string;
  fixtureId: string;
  parameters?: Record<string, BoundedJsonValue>;
  setupEndpoint: TrustedReplayProfile["fixtures"][number]["setupEndpoint"];
  stateEndpoint: TrustedReplayProfile["fixtures"][number]["stateEndpoint"];
}

export interface ProofExperiment {
  id: string;
  kind: ProofExperimentKind;
  sourcePlanId: string;
  controlId?: string;
  claimIds: string[];
  mandatory: boolean;
  fixtures: ProofFixtureBinding[];
  requests: ReplayRequest[];
  assertions: ReplayAssertion[];
  expected: {
    base: ProofExpectation;
    candidate: ProofExpectation;
    ablation: ProofExpectation;
  };
}

export interface ProofImpactTarget {
  id: string;
  path: string;
  kind: "hunk" | "symbol" | "workflow";
  detail: string;
}

export interface ProofPlan {
  schemaVersion: 1;
  status: "ready" | "review" | "blocked";
  revision: CompiledClaimContract["contract"]["revision"];
  inputs: {
    claimContractDigest: string;
    impactMapDigest: string;
    replayProfileDigest: string;
  };
  experiments: ProofExperiment[];
  impactTargets: ProofImpactTarget[];
  coverage: {
    mandatoryClaimIds: string[];
    primaryClaimIds: string[];
    unmappedMandatoryClaimIds: string[];
    changedFiles: string[];
    changedSymbolIds: string[];
    workflowIds: string[];
  };
  blockingReasons: string[];
  reviewReasons: string[];
  limitations: string[];
}

export interface CompiledProofPlan {
  plan: ProofPlan;
  /** SHA-256 over the normalized plan without a self-referential digest field. */
  digest: string;
}

export interface BuildProofPlanInput {
  claimContract: CompiledClaimContract;
  impactMap: ImpactMap;
  replayProfile: TrustedReplayProfile;
}

export class ProofPlanInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofPlanInputError";
  }
}

const digest = z.string().regex(/^[a-f0-9]{64}$/);

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function planDigest(value: unknown): string {
  return sha256(canonicalJson(value));
}

function validateClaimContract(compiled: CompiledClaimContract): CompiledClaimContract["contract"] {
  const contract = normalizedClaimContractSchema.parse(compiled.contract);
  digest.parse(compiled.digest);
  const actualDigest = planDigest(contract);
  if (actualDigest !== compiled.digest) {
    throw new ProofPlanInputError("Claim contract digest does not match its normalized contents.");
  }
  return contract;
}

function validateImpactMap(impactMap: ImpactMap): void {
  if (impactMap.schemaVersion !== 1 || !["complete", "blocked"].includes(impactMap.status)) {
    throw new ProofPlanInputError("Impact map is not a supported normalized report.");
  }
}

function mandatoryClaimIds(contract: CompiledClaimContract["contract"]): string[] {
  return sortedUnique(
    [...contract.expectedBehaviors, ...contract.invariants, ...contract.failureSignatures]
      .filter((claim) => claim.mandatory)
      .map((claim) => claim.id),
  );
}

function fixtureBindings(
  replayPlan: HttpReplayPlan,
  profile: TrustedReplayProfile,
  blockingReasons: string[],
): ProofFixtureBinding[] {
  const registry = new Map(profile.fixtures.map((fixture) => [fixture.id, fixture]));
  const bindings: ProofFixtureBinding[] = [];
  for (const fixture of replayPlan.setup.fixtures) {
    const trusted = registry.get(fixture.fixtureId);
    if (!trusted) {
      blockingReasons.push(
        `missing-trusted-fixture:${replayPlan.id}:${fixture.name}:${fixture.fixtureId}`,
      );
      continue;
    }
    bindings.push({
      name: fixture.name,
      fixtureId: fixture.fixtureId,
      ...(fixture.parameters === undefined ? {} : { parameters: fixture.parameters }),
      setupEndpoint: { ...trusted.setupEndpoint },
      stateEndpoint: { ...trusted.stateEndpoint },
    });
  }
  return bindings.sort((left, right) => left.name.localeCompare(right.name));
}

function validateTrustedOperations(
  replayPlan: HttpReplayPlan,
  profile: TrustedReplayProfile,
  blockingReasons: string[],
): void {
  const registry = new Map(
    profile.operations.map((operation) => [`${operation.method}:${operation.pathTemplate}`, operation]),
  );
  const invocationCounts = new Map<string, number>();
  for (const request of replayPlan.requests) {
    const operation = registry.get(`${request.method}:${request.path}`);
    if (!operation) {
      blockingReasons.push(`untrusted-operation:${replayPlan.id}:${request.id}`);
      continue;
    }
    const invocations = (invocationCounts.get(operation.id) ?? 0) + 1;
    invocationCounts.set(operation.id, invocations);
    if (invocations > operation.maxInvocations) {
      blockingReasons.push(`operation-invocation-limit:${replayPlan.id}:${operation.id}`);
    }
    const allowedQuery = new Set(operation.allowedQueryKeys);
    for (const query of request.query) {
      if (!allowedQuery.has(query.name)) {
        blockingReasons.push(`untrusted-query-key:${replayPlan.id}:${request.id}:${query.name}`);
      }
    }
    if (request.body !== undefined) {
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) {
        blockingReasons.push(`untrusted-request-body:${replayPlan.id}:${request.id}`);
      } else {
        const allowedBody = new Set(operation.allowedBodyKeys);
        for (const key of Object.keys(request.body)) {
          if (!allowedBody.has(key)) {
            blockingReasons.push(`untrusted-body-key:${replayPlan.id}:${request.id}:${key}`);
          }
        }
      }
    }
  }
}

function experiment(
  replayPlan: HttpReplayPlan,
  profile: TrustedReplayProfile,
  blockingReasons: string[],
  options: {
    id: string;
    kind: ProofExperimentKind;
    controlId?: string;
    mandatory: boolean;
  },
): ProofExperiment {
  validateTrustedOperations(replayPlan, profile, blockingReasons);
  const expected = options.kind === "primary"
    ? { base: "fail", candidate: "pass", ablation: "fail" } as const
    : options.kind === "positive_control"
      ? { base: "pass", candidate: "pass", ablation: "pass" } as const
      : { base: "fail", candidate: "fail", ablation: "fail" } as const;
  return {
    id: options.id,
    kind: options.kind,
    sourcePlanId: replayPlan.id,
    ...(options.controlId === undefined ? {} : { controlId: options.controlId }),
    claimIds: [...replayPlan.claimIds],
    mandatory: options.mandatory,
    fixtures: fixtureBindings(replayPlan, profile, blockingReasons),
    requests: replayPlan.requests.map((request) => ({ ...request })),
    assertions: replayPlan.assertions.map((assertion) => ({ ...assertion })),
    expected,
  };
}

function buildExperiments(
  contract: CompiledClaimContract["contract"],
  profile: TrustedReplayProfile,
  mandatoryClaims: ReadonlySet<string>,
  blockingReasons: string[],
): ProofExperiment[] {
  const replayPlans = new Map(contract.replayPlans.map((plan) => [plan.id, plan]));
  const controlPlanIds = new Set([
    ...contract.positiveControls.map((control) => control.replayPlanId),
    ...contract.negativeControls.map((control) => control.replayPlanId),
  ]);
  const experiments: ProofExperiment[] = [];

  for (const replayPlan of contract.replayPlans) {
    if (controlPlanIds.has(replayPlan.id)) continue;
    experiments.push(
      experiment(replayPlan, profile, blockingReasons, {
        id: `primary-${replayPlan.id}`,
        kind: "primary",
        mandatory: replayPlan.claimIds.some((claimId) => mandatoryClaims.has(claimId)),
      }),
    );
  }
  for (const control of contract.positiveControls) {
    const replayPlan = replayPlans.get(control.replayPlanId);
    if (!replayPlan) throw new ProofPlanInputError(`Missing validated replay plan ${control.replayPlanId}.`);
    experiments.push(
      experiment(replayPlan, profile, blockingReasons, {
        id: `positive-${control.id}`,
        kind: "positive_control",
        controlId: control.id,
        mandatory: control.mandatory,
      }),
    );
  }
  for (const control of contract.negativeControls) {
    const replayPlan = replayPlans.get(control.replayPlanId);
    if (!replayPlan) throw new ProofPlanInputError(`Missing validated replay plan ${control.replayPlanId}.`);
    experiments.push(
      experiment(replayPlan, profile, blockingReasons, {
        id: `negative-${control.id}`,
        kind: "negative_control",
        controlId: control.id,
        mandatory: control.mandatory,
      }),
    );
  }
  return experiments.sort((left, right) => left.id.localeCompare(right.id));
}

function impactTargets(impactMap: ImpactMap): ProofImpactTarget[] {
  const targets: ProofImpactTarget[] = [];
  for (const file of impactMap.diffFiles) {
    const filePath = file.newPath ?? file.oldPath ?? "unknown";
    for (const [index, hunk] of file.hunks.entries()) {
      targets.push({
        id: `hunk:${filePath}:${index + 1}`,
        path: filePath,
        kind: "hunk",
        detail: hunk.classifications.join(","),
      });
    }
  }
  for (const symbol of impactMap.changedSymbols) {
    targets.push({
      id: symbol.id,
      path: symbol.path,
      kind: "symbol",
      detail: `${symbol.kind}:${symbol.name}`,
    });
  }
  for (const workflow of impactMap.workflows) {
    targets.push({
      id: workflow.id,
      path: workflow.path,
      kind: "workflow",
      detail: `${workflow.kind}:${workflow.reason}`,
    });
  }
  return targets.sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Joins model-compiled intent to deterministic code impact and controller-owned
 * application plumbing. Missing evidence never becomes an executable partial
 * plan: the normalized output is sealed, but its status fail-closes automation.
 */
export function buildProofPlan(input: BuildProofPlanInput): CompiledProofPlan {
  const contract = validateClaimContract(input.claimContract);
  validateImpactMap(input.impactMap);
  const profile = parseTrustedReplayProfile(input.replayProfile);
  const blockingReasons: string[] = [];
  const reviewReasons: string[] = [];
  const limitations: string[] = [];

  if (input.impactMap.status !== "complete") {
    blockingReasons.push("impact-map-incomplete");
    for (const unresolved of input.impactMap.unresolvedPaths) {
      blockingReasons.push(`unresolved-impact:${unresolved.kind}:${unresolved.path}:${unresolved.line}`);
    }
  }

  const mandatoryClaims = mandatoryClaimIds(contract);
  const mandatoryClaimSet = new Set(mandatoryClaims);
  if (mandatoryClaims.length === 0) blockingReasons.push("no-mandatory-trusted-claims");
  if (!contract.positiveControls.some((control) => control.mandatory)) {
    blockingReasons.push("missing-mandatory-positive-control");
  }
  if (!contract.negativeControls.some((control) => control.mandatory)) {
    blockingReasons.push("missing-mandatory-negative-control");
  }
  for (const ambiguity of contract.ambiguities.filter(({ status }) => status === "unresolved")) {
    const reason = `unresolved-ambiguity:${ambiguity.impact}:${ambiguity.id}`;
    if (ambiguity.mandatory || ambiguity.impact === "high") blockingReasons.push(reason);
    else reviewReasons.push(reason);
  }

  const experiments = buildExperiments(contract, profile, mandatoryClaimSet, blockingReasons);
  const primaryExperiments = experiments.filter((entry) => entry.kind === "primary");
  if (primaryExperiments.length === 0) blockingReasons.push("missing-primary-experiment");
  if (!primaryExperiments.some((entry) => entry.mandatory)) {
    blockingReasons.push("missing-mandatory-primary-experiment");
  }
  const primaryClaimIds = sortedUnique(primaryExperiments.flatMap((entry) => entry.claimIds));
  const unmappedMandatoryClaimIds = mandatoryClaims.filter((claimId) => !primaryClaimIds.includes(claimId));
  for (const claimId of unmappedMandatoryClaimIds) {
    blockingReasons.push(`mandatory-claim-without-primary-proof:${claimId}`);
  }

  const hasChangedSource = input.impactMap.diffFiles.some((file) =>
    file.classifications.includes("source") && file.hunks.length > 0);
  if (input.impactMap.diffFiles.some((file) => file.hunks.length > 0)) {
    limitations.push("hunk-closure-requires-execution-evidence");
  }
  if (hasChangedSource && input.impactMap.changedSymbols.length === 0) {
    blockingReasons.push("no-changed-symbols-resolved");
  }
  if (hasChangedSource && input.impactMap.workflows.length === 0) {
    blockingReasons.push("no-workflow-entrypoints-resolved");
  }

  const uniqueBlockingReasons = sortedUnique(blockingReasons);
  const uniqueReviewReasons = sortedUnique(reviewReasons);
  const plan: ProofPlan = {
    schemaVersion: 1,
    status: uniqueBlockingReasons.length > 0
      ? "blocked"
      : uniqueReviewReasons.length > 0
        ? "review"
        : "ready",
    revision: { ...contract.revision },
    inputs: {
      claimContractDigest: input.claimContract.digest,
      impactMapDigest: planDigest(input.impactMap),
      replayProfileDigest: trustedReplayProfileDigest(profile),
    },
    experiments,
    impactTargets: impactTargets(input.impactMap),
    coverage: {
      mandatoryClaimIds: mandatoryClaims,
      primaryClaimIds,
      unmappedMandatoryClaimIds,
      changedFiles: sortedUnique(
        input.impactMap.diffFiles.flatMap((file) => [file.newPath, file.oldPath].filter((value): value is string => value !== null)),
      ),
      changedSymbolIds: sortedUnique(input.impactMap.changedSymbols.map((symbol) => symbol.id)),
      workflowIds: sortedUnique(input.impactMap.workflows.map((workflow) => workflow.id)),
    },
    blockingReasons: uniqueBlockingReasons,
    reviewReasons: uniqueReviewReasons,
    limitations: sortedUnique(limitations),
  };
  return { plan, digest: planDigest(plan) };
}

export function proofPlanDigest(plan: ProofPlan): string {
  return planDigest(plan);
}
