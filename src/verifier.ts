import { revisionRunKey, sealReceipt } from "./crypto.js";
import {
  extractLinkedIssue,
  plannerLinkedIssueContext,
  sanitizeUntrustedAgentInput,
  validateIssueToProofPlan,
  type PlannerInput,
  type ProofPlanner,
} from "./agent-planner.js";
import type {
  AgentAnalysis,
  AdvisoryProofScenario,
  CanonicalGitHubIssue,
  CheckStatus,
  EvidenceReceipt,
  HarnessResult,
  IssueToProofReceiptContext,
  IssueToProofScenarioBinding,
  PairedCheck,
  PairedMetric,
  PinnedRevision,
  VerificationPolicy,
  VerdictReason,
} from "./domain.js";
import { HarnessUnavailableError, type EvidenceHarness } from "./harness.js";
import { evaluateEvidence } from "./policy.js";

export type VerificationPullRequestContext = Pick<
  PlannerInput,
  "title" | "description" | "diff"
> & {
  linkedIssue?: PlannerInput["linkedIssue"];
  /** Canonical issue data from the controller read gateway; never persisted verbatim. */
  canonicalIssue?: CanonicalGitHubIssue;
};

function pairChecks(base: HarnessResult, candidate: HarnessResult): {
  checks: PairedCheck[];
  reasons: VerdictReason[];
} {
  const duplicateIds = new Set<string>();
  for (const checks of [base.checks, candidate.checks]) {
    const seen = new Set<string>();
    for (const check of checks) {
      if (seen.has(check.id)) {
        duplicateIds.add(check.id);
      }
      seen.add(check.id);
    }
  }
  const candidateById = new Map(
    candidate.checks
      .filter((check) => !duplicateIds.has(check.id))
      .map((check) => [check.id, check]),
  );
  const checks: PairedCheck[] = [];
  const reasons: VerdictReason[] = [];

  for (const id of [...duplicateIds].sort()) {
    reasons.push({
      code: "MISMATCHED_HARNESS_OUTPUT",
      subject: id,
      detail: "A harness phase emitted this proof obligation more than once, so it cannot be bound to a scenario.",
    });
  }

  for (const baseCheck of base.checks.filter((check) => !duplicateIds.has(check.id))) {
    const candidateCheck = candidateById.get(baseCheck.id);
    if (!candidateCheck || candidateCheck.kind !== baseCheck.kind) {
      reasons.push({
        code: "MISMATCHED_HARNESS_OUTPUT",
        subject: baseCheck.id,
        detail: "Base and candidate did not emit the same proof obligation.",
      });
      continue;
    }
    candidateById.delete(baseCheck.id);
    checks.push({
      id: baseCheck.id,
      kind: baseCheck.kind,
      required: baseCheck.required || candidateCheck.required,
      base: baseCheck.status,
      candidate: candidateCheck.status,
      detail: candidateCheck.detail,
    });
  }

  for (const unexpected of candidateById.values()) {
    reasons.push({
      code: "MISMATCHED_HARNESS_OUTPUT",
      subject: unexpected.id,
      detail: "Candidate emitted an obligation missing from the base proof run.",
    });
  }
  return { checks, reasons };
}

function pairMetrics(base: HarnessResult, candidate: HarnessResult): {
  metrics: PairedMetric[];
  reasons: VerdictReason[];
} {
  const candidateByName = new Map(candidate.metrics.map((metric) => [metric.name, metric]));
  const metrics: PairedMetric[] = [];
  const reasons: VerdictReason[] = [];

  for (const baseMetric of base.metrics) {
    const candidateMetric = candidateByName.get(baseMetric.name);
    if (!candidateMetric) {
      reasons.push({
        code: "MISMATCHED_HARNESS_OUTPUT",
        subject: baseMetric.name,
        detail: "Candidate omitted a base infrastructure metric.",
      });
      continue;
    }
    candidateByName.delete(baseMetric.name);
    metrics.push({
      name: baseMetric.name,
      required: baseMetric.required || candidateMetric.required,
      base: baseMetric.value,
      candidate: candidateMetric.value,
      detail: candidateMetric.detail,
    });
  }

  for (const unexpected of candidateByName.values()) {
    reasons.push({
      code: "MISMATCHED_HARNESS_OUTPUT",
      subject: unexpected.name,
      detail: "Candidate emitted an infrastructure metric missing from the base run.",
    });
  }
  return { metrics, reasons };
}

function unavailableResult(phase: "base" | "candidate", detail: string): HarnessResult {
  return {
    phase,
    sandboxId: "unavailable",
    harnessVersion: "unavailable",
    checks: [
      {
        id: "harness-availability",
        kind: "deterministic_gate",
        required: true,
        status: "unsupported",
        detail,
      },
    ],
    metrics: [],
  };
}

function notConfiguredAgentAnalysis(): AgentAnalysis {
  return {
    status: "not_configured",
    hypotheses: [],
    challenges: [],
    limitation: "No OpenAI proof planner is configured for this run.",
  };
}

/**
 * Receipts and sandbox requests carry only structural advisory metadata. The
 * no-tool agents may inspect untrusted PR and canonical issue content, but
 * their free text is never durable and never becomes probe input.
 */
function sealAgentAnalysis(
  analysis: AgentAnalysis,
  allowedObligationIds: readonly string[],
  issueToProofPlan?: AgentAnalysis["issueToProofPlan"],
): AgentAnalysis {
  const allowed = new Set(allowedObligationIds);
  return {
    status: analysis.status,
    hypotheses: analysis.hypotheses.slice(0, 4).map((hypothesis, index) => ({
      id: `hypothesis-${index + 1}`,
      category: hypothesis.category,
      claim: "Structural advisory hypothesis is intentionally not retained.",
      suggestedProbe: "Trusted maintainer-owned probes define observable evidence.",
      relatedObligationIds: hypothesis.relatedObligationIds
        .filter((obligationId) => allowed.has(obligationId))
        .slice(0, 5),
      confidence: hypothesis.confidence,
    })),
    challenges: analysis.challenges.slice(0, 4).map((challenge, index) => ({
      hypothesisId: `hypothesis-${index + 1}`,
      challenge: "Structural advisory challenge is intentionally not retained.",
      suggestedCounterexample: "Trusted maintainer-owned probes define observable evidence.",
      severity: challenge.severity,
    })),
    ...(issueToProofPlan ? { issueToProofPlan } : {}),
    limitation:
      analysis.status === "completed"
        ? "Model prose is not retained; trusted evidence determines the verdict."
        : "Advisory analysis was unavailable or invalid and did not affect this verdict.",
  };
}

function plannerInputFor(
  revision: PinnedRevision,
  policy: VerificationPolicy,
  context: VerificationPullRequestContext | undefined,
): PlannerInput {
  const description = context?.description ?? "";
  const suppliedIssue = context?.linkedIssue;
  const linkedIssue =
    suppliedIssue &&
    Number.isSafeInteger(suppliedIssue.number) &&
    suppliedIssue.number > 0 &&
    suppliedIssue.source === "pull_request_description"
      ? { number: suppliedIssue.number, source: "pull_request_description" as const }
      : extractLinkedIssue(description);
  const canonicalIssueContext =
    linkedIssue && context?.canonicalIssue
      ? plannerLinkedIssueContext(linkedIssue, context.canonicalIssue)
      : null;
  const requiresCanonicalIssue = policy.issueToProof?.requireLinkedIssue === true;
  const issueContextMatchesRevision =
    canonicalIssueContext !== null &&
    revision.issueContextDigest === canonicalIssueContext.contentDigest;
  const plannerLinkedIssue =
    requiresCanonicalIssue && !issueContextMatchesRevision ? null : linkedIssue;
  const plannerIssueContext =
    requiresCanonicalIssue && !issueContextMatchesRevision ? null : canonicalIssueContext;
  return {
    repository: revision.repository,
    pullRequest: revision.pullRequest,
    title: context?.title ?? "",
    description,
    diff: context?.diff ?? "",
    requiredObligationIds: policy.requiredCheckIds,
    ...(policy.issueToProof ? { issueToProof: policy.issueToProof } : {}),
    linkedIssue: plannerLinkedIssue,
    linkedIssueContext: plannerIssueContext,
  };
}

function issueToProofContextFor(
  revision: PinnedRevision,
  input: PlannerInput,
): IssueToProofReceiptContext {
  return {
    source: revision.pullRequest > 0 ? "pull_request" : "merge_group",
    pullRequestTitle: sanitizeUntrustedAgentInput(input.title, 500),
    linkedIssue: input.linkedIssueContext
      ? {
          number: input.linkedIssueContext.number,
          source: input.linkedIssueContext.source,
          contentDigest: input.linkedIssueContext.contentDigest,
          titleBytes: input.linkedIssueContext.titleBytes,
          bodyBytes: input.linkedIssueContext.bodyBytes,
        }
      : null,
    scenarioBindings: [],
  };
}

function statusRank(status: CheckStatus): number | null {
  if (status === "fail") return 0;
  if (status === "pass") return 1;
  return null;
}

function scenarioExpectation(scenario: AdvisoryProofScenario): string {
  switch (scenario.kind) {
    case "base_fails_candidate_passes":
      return "base=fail and candidate=pass";
    case "both_revisions_pass":
      return "base=pass and candidate=pass";
    case "candidate_not_worse":
      return "candidate status to be at least as good as the base";
  }
}

function scenarioIsSatisfied(scenario: AdvisoryProofScenario, check: PairedCheck): boolean {
  switch (scenario.kind) {
    case "base_fails_candidate_passes":
      return check.base === "fail" && check.candidate === "pass";
    case "both_revisions_pass":
      return check.base === "pass" && check.candidate === "pass";
    case "candidate_not_worse": {
      const baseRank = statusRank(check.base);
      const candidateRank = statusRank(check.candidate);
      return baseRank !== null && candidateRank !== null && candidateRank >= baseRank;
    }
  }
}

function bindScenario(
  scenario: AdvisoryProofScenario,
  policy: VerificationPolicy,
  checksById: Map<string, PairedCheck>,
): IssueToProofScenarioBinding {
  const check = checksById.get(scenario.obligationId);
  if (!check) {
    return {
      scenarioId: scenario.id,
      obligationId: scenario.obligationId,
      kind: scenario.kind,
      pairedCheckId: null,
      checkKind: null,
      base: null,
      candidate: null,
      status: "missing",
      detail: "No unique paired check was observed for this policy-owned obligation.",
    };
  }
  if (!policy.requiredCheckIds.includes(check.id) || !check.required) {
    return {
      scenarioId: scenario.id,
      obligationId: scenario.obligationId,
      kind: scenario.kind,
      pairedCheckId: check.id,
      checkKind: check.kind,
      base: check.base,
      candidate: check.candidate,
      status: "unmet",
      detail: "The paired check is not a policy-required maintainer-owned obligation.",
    };
  }
  if (!scenarioIsSatisfied(scenario, check)) {
    return {
      scenarioId: scenario.id,
      obligationId: scenario.obligationId,
      kind: scenario.kind,
      pairedCheckId: check.id,
      checkKind: check.kind,
      base: check.base,
      candidate: check.candidate,
      status: "unmet",
      detail: `Expected ${scenarioExpectation(scenario)}; observed base=${check.base} and candidate=${check.candidate}.`,
    };
  }
  return {
    scenarioId: scenario.id,
    obligationId: scenario.obligationId,
    kind: scenario.kind,
    pairedCheckId: check.id,
    checkKind: check.kind,
    base: check.base,
    candidate: check.candidate,
    status: "satisfied",
    detail: `Observed ${scenarioExpectation(scenario)} on the policy-required paired check.`,
  };
}

function issueToProofAssessment(
  revision: PinnedRevision,
  policy: VerificationPolicy,
  context: IssueToProofReceiptContext,
  analysis: AgentAnalysis,
  checks: PairedCheck[],
): { context: IssueToProofReceiptContext; reasons: VerdictReason[] } {
  // A GitHub merge_group has no single PR or issue to link. It is re-proved
  // deterministically on the queue-generated SHA, while its original PR went
  // through this Issue-to-Proof gate before enqueue.
  if (!policy.issueToProof || revision.pullRequest <= 0) {
    return { context, reasons: [] };
  }
  const requiredObligations = policy.issueToProof.requiredObligationIds;
  if (requiredObligations.length === 0) {
    return {
      context,
      reasons: [
        {
          code: "INCOMPLETE_PROOF",
          subject: "issue-to-proof-policy",
          detail: "Issue-to-Proof is configured without any policy-owned proof obligations.",
        },
      ],
    };
  }
  if (new Set(requiredObligations).size !== requiredObligations.length) {
    return {
      context,
      reasons: [
        {
          code: "INCOMPLETE_PROOF",
          subject: "issue-to-proof-policy",
          detail: "Issue-to-Proof policy contains duplicate required proof obligations.",
        },
      ],
    };
  }
  const unknownPolicyObligation = requiredObligations.find(
    (id) => !policy.requiredCheckIds.includes(id),
  );
  if (unknownPolicyObligation) {
    return {
      context,
      reasons: [
        {
          code: "INCOMPLETE_PROOF",
          subject: unknownPolicyObligation,
          detail: "Issue-to-Proof policy references an obligation that is not policy-owned.",
        },
      ],
    };
  }
  if (policy.issueToProof.requireLinkedIssue && !context.linkedIssue) {
    return {
      context,
      reasons: [
        {
          code: "INCOMPLETE_PROOF",
          subject: "linked-issue",
          detail: "A configured Issue-to-Proof run requires a canonical GitHub issue context sealed to this exact revision.",
        },
      ],
    };
  }
  if (analysis.status !== "completed" || !analysis.issueToProofPlan) {
    return {
      context,
      reasons: [
        {
          code: "INCOMPLETE_PROOF",
          subject: "issue-to-proof-plan",
          detail: "The configured Issue-to-Proof planner did not produce a validated advisory plan.",
        },
      ],
    };
  }
  const checksById = new Map(checks.map((check) => [check.id, check]));
  const bindings = analysis.issueToProofPlan.scenarios.map((scenario) =>
    bindScenario(scenario, policy, checksById),
  );
  const reasons = bindings
    .filter((binding) => binding.status !== "satisfied")
    .map((binding) => ({
      code: "INCOMPLETE_PROOF" as const,
      subject: binding.scenarioId,
      detail: `Issue-to-Proof scenario is not satisfied: ${binding.detail}`,
    }));
  return { context: { ...context, scenarioBindings: bindings }, reasons };
}

function requiredObligationReasons(
  checks: PairedCheck[],
  metrics: PairedMetric[],
  policy: VerificationPolicy,
): VerdictReason[] {
  const reasons: VerdictReason[] = [];
  const checksById = new Map(checks.map((check) => [check.id, check]));
  const metricsByName = new Map(metrics.map((metric) => [metric.name, metric]));

  for (const id of policy.requiredCheckIds) {
    const check = checksById.get(id);
    if (!check) {
      reasons.push({
        code: "INCOMPLETE_PROOF",
        subject: id,
        detail: "A policy-required check was not emitted by both harness runs.",
      });
    } else if (!check.required) {
      reasons.push({
        code: "INCOMPLETE_PROOF",
        subject: id,
        detail: "A policy-required check was downgraded by the harness.",
      });
    }
  }
  for (const name of policy.requiredMetricNames) {
    const metric = metricsByName.get(name);
    if (!metric) {
      reasons.push({
        code: "INCOMPLETE_PROOF",
        subject: name,
        detail: "A policy-required resource metric was not emitted by both harness runs.",
      });
    } else if (!metric.required) {
      reasons.push({
        code: "INCOMPLETE_PROOF",
        subject: name,
        detail: "A policy-required resource metric was downgraded by the harness.",
      });
    }
  }
  return reasons;
}

export class VerificationEngine {
  constructor(
    private readonly harness: EvidenceHarness,
    private readonly planner?: ProofPlanner,
  ) {}

  async verify(
    revision: PinnedRevision,
    policy: VerificationPolicy,
    now = new Date(),
    prContext?: VerificationPullRequestContext,
  ): Promise<EvidenceReceipt> {
    // Planning deliberately happens first. It can only produce a bounded,
    // validated JSON plan for maintainer-owned probes; it never executes a
    // command and never controls deterministic evidence evaluation.
    const plannerInput = plannerInputFor(revision, policy, prContext);
    const agentAnalysis = await this.analyzeWithPlanner(plannerInput);
    const issueToProof = issueToProofContextFor(revision, plannerInput);
    let base: HarnessResult;
    let candidate: HarnessResult;

    try {
      [base, candidate] = await Promise.all([
        this.harness.collect({
          revision,
          phase: "base",
          ...(agentAnalysis.issueToProofPlan
            ? { advisoryPlan: agentAnalysis.issueToProofPlan }
            : {}),
        }),
        this.harness.collect({
          revision,
          phase: "candidate",
          ...(agentAnalysis.issueToProofPlan
            ? { advisoryPlan: agentAnalysis.issueToProofPlan }
            : {}),
        }),
      ]);
    } catch (error) {
      const detail =
        error instanceof HarnessUnavailableError
          ? error.message
          : "Verification harness failed unexpectedly; merge is not safe to automate.";
      base = unavailableResult("base", detail);
      candidate = unavailableResult("candidate", detail);
    }

    const pairedChecks = pairChecks(base, candidate);
    const pairedMetrics = pairMetrics(base, candidate);
    const completenessReasons = requiredObligationReasons(
      pairedChecks.checks,
      pairedMetrics.metrics,
      policy,
    );
    const mismatchReasons = [
      ...pairedChecks.reasons,
      ...pairedMetrics.reasons,
      ...completenessReasons,
    ];
    const evaluation = evaluateEvidence(
      pairedChecks.checks,
      pairedMetrics.metrics,
      policy,
    );

    const planAssessment = issueToProofAssessment(
      revision,
      policy,
      issueToProof,
      agentAnalysis,
      pairedChecks.checks,
    );
    const receiptIssueToProof = planAssessment.context;
    const planReasons = planAssessment.reasons;
    const deterministicVerdict =
      evaluation.verdict === "BLOCK" || evaluation.verdict === "UNSUPPORTED"
        ? evaluation.verdict
        : mismatchReasons.length > 0
          ? "REVIEW"
          : evaluation.verdict;
    const deterministicReasons =
      evaluation.verdict === "BLOCK" || evaluation.verdict === "UNSUPPORTED"
        ? [...evaluation.reasons, ...mismatchReasons]
        : mismatchReasons.length > 0
          ? mismatchReasons
          : evaluation.reasons;

    const verdict =
      deterministicVerdict === "BLOCK" || deterministicVerdict === "UNSUPPORTED"
        ? deterministicVerdict
        : planReasons.length > 0
          ? "REVIEW"
          : deterministicVerdict;
    const reasons =
      deterministicVerdict === "BLOCK" || deterministicVerdict === "UNSUPPORTED"
        ? [...deterministicReasons, ...planReasons]
        : planReasons.length > 0
          ? [...deterministicReasons, ...planReasons]
          : deterministicReasons;
    const runKey = revisionRunKey(revision);

    return sealReceipt({
      schemaVersion: 1,
      runKey,
      revision,
      policy,
      issueToProof: receiptIssueToProof,
      base,
      candidate,
      pairedChecks: pairedChecks.checks,
      pairedMetrics: pairedMetrics.metrics,
      agentAnalysis,
      deterministicVerdict,
      verdict,
      reasons,
      observedAt: now.toISOString(),
    });
  }

  private async analyzeWithPlanner(
    input: PlannerInput,
  ): Promise<AgentAnalysis> {
    if (!this.planner) {
      return notConfiguredAgentAnalysis();
    }
    try {
      const analysis = await this.planner.analyze(input);
      if (analysis.status !== "completed" || !analysis.issueToProofPlan) {
        return sealAgentAnalysis(analysis, input.requiredObligationIds);
      }
      const validation = validateIssueToProofPlan(analysis.issueToProofPlan, input);
      if (!validation.ok) {
        return sealAgentAnalysis(
          { status: "failed", hypotheses: [], challenges: [] },
          input.requiredObligationIds,
        );
      }
      return sealAgentAnalysis(analysis, input.requiredObligationIds, validation.plan);
    } catch {
      return sealAgentAnalysis(
        { status: "unavailable", hypotheses: [], challenges: [] },
        input.requiredObligationIds,
      );
    }
  }
}
