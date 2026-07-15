export type VerificationVerdict =
  | "BLOCK"
  | "REVIEW"
  | "LOW_OBSERVED_RISK"
  | "UNSUPPORTED";

export type MergeOutcome =
  | "NOT_ELIGIBLE"
  | "READY"
  | "QUEUED"
  | "STALE"
  | "MERGING"
  | "MERGED"
  | "MERGE_FAILED"
  | "MERGE_UNKNOWN";

export type CheckStatus = "pass" | "fail" | "unknown" | "unsupported";

export type CheckKind =
  | "deterministic_gate"
  | "bug_reproduction"
  | "protected_behavior"
  | "adversarial"
  | "hunk_closure";

export type MetricName =
  | "p95_latency_ms"
  | "peak_memory_mb"
  | "cpu_ms"
  | "error_rate";

export interface PinnedRevision {
  repository: string;
  pullRequest: number;
  baseSha: string;
  headSha: string;
  mergeSha: string;
  policyHash: string;
  /** Digest of the exact controller-owned E2B artifacts used for this proof. */
  trustedArtifactDigest: string;
  /**
   * Present only when a configured Issue-to-Proof run bound a canonical GitHub
   * issue. Including it in the revision makes a changed issue a distinct
   * proof identity instead of allowing a prior receipt to be reused.
   */
  issueContextDigest?: string;
}

export interface PairedCheck {
  id: string;
  kind: CheckKind;
  required: boolean;
  base: CheckStatus;
  candidate: CheckStatus;
  detail: string;
}

export interface PairedMetric {
  name: MetricName;
  required: boolean;
  base: number | null;
  candidate: number | null;
  detail: string;
}

export interface HarnessResult {
  phase: "base" | "candidate";
  sandboxId: string;
  harnessVersion: string;
  checks: Array<{
    id: string;
    kind: CheckKind;
    required: boolean;
    status: CheckStatus;
    detail: string;
  }>;
  metrics: Array<{
    name: MetricName;
    required: boolean;
    value: number | null;
    detail: string;
  }>;
}

export interface MetricThreshold {
  maxRatio: number;
  /** Applies when the base has no meaningful value. */
  maxAbsolute: number;
}

export interface VerificationPolicy {
  version: string;
  /** Immutable policy-owned obligations; a harness cannot silently omit them. */
  requiredCheckIds: string[];
  requiredMetricNames: MetricName[];
  requireBugReproduction: boolean;
  requireAdversarialChecks: boolean;
  requireHunkClosure: boolean;
  metricThresholds: Partial<Record<MetricName, MetricThreshold>>;
  /**
   * Opt-in Issue-to-Proof gate for bug-fix pull requests. These identifiers
   * are policy-owned; an advisory model may only reference them, never add an
   * executable test command or a new merge condition.
   */
  issueToProof?: IssueToProofPolicy;
}

export interface IssueToProofPolicy {
  /** A PR must contain an explicit closing issue reference such as `Fixes #42`. */
  requireLinkedIssue: boolean;
  /** These policy-owned deterministic obligations must be covered by the plan. */
  requiredObligationIds: string[];
}

export interface VerdictReason {
  code:
    | "CHECK_FAILED"
    | "INCOMPLETE_PROOF"
    | "UNSUPPORTED_PROOF"
    | "RESOURCE_REGRESSION"
    | "MISMATCHED_HARNESS_OUTPUT";
  subject: string;
  detail: string;
}

export interface EvidenceReceipt {
  schemaVersion: 1;
  runKey: string;
  revision: PinnedRevision;
  policy: VerificationPolicy;
  /** Sanitized PR/issue linkage used to compile the advisory proof plan. */
  issueToProof: IssueToProofReceiptContext;
  base: HarnessResult;
  candidate: HarnessResult;
  pairedChecks: PairedCheck[];
  pairedMetrics: PairedMetric[];
  agentAnalysis: AgentAnalysis;
  /** The policy result before the advisory Issue-to-Proof gate can fail closed. */
  deterministicVerdict: VerificationVerdict;
  verdict: VerificationVerdict;
  reasons: VerdictReason[];
  observedAt: string;
  integrityHash: string;
}

/**
 * Agent output is explicitly non-authoritative. It is a bounded list of
 * hypotheses that a trusted harness or maintainer policy may choose to replay.
 */
export interface AgentHypothesis {
  id: string;
  category: "boundary" | "concurrency" | "regression" | "security" | "resource";
  claim: string;
  suggestedProbe: string;
  relatedObligationIds: string[];
  confidence: "low" | "medium" | "high";
}

export interface AgentChallenge {
  hypothesisId: string;
  challenge: string;
  suggestedCounterexample: string;
  severity: "low" | "medium" | "high";
}

/**
 * This is deliberately a declarative, fixed DSL. It has no command, source
 * path, environment, or arbitrary-code field. Trusted maintainer probes may
 * read it as guidance, but only policy-owned probes execute in the sandbox.
 */
export type AdvisoryScenarioKind =
  | "base_fails_candidate_passes"
  | "both_revisions_pass"
  | "candidate_not_worse";

export interface AdvisoryProofScenario {
  id: string;
  obligationId: string;
  kind: AdvisoryScenarioKind;
  assertion: string;
}

export interface IssueToProofPlan {
  schemaVersion: 1;
  issueNumber: number;
  scenarios: AdvisoryProofScenario[];
  limitation: string;
}

/** An explicit PR closing reference, not a bare issue mention. */
export interface LinkedIssueReference {
  number: number;
  source: "pull_request_description";
}

/**
 * Canonical issue data retrieved through the controller's down-scoped GitHub
 * read gateway. This type is strictly transient: title and body must never
 * be copied into a receipt, sandbox, log, or durable ledger field.
 */
export interface CanonicalGitHubIssue {
  number: number;
  title: string;
  body: string;
  /** GitHub's issue endpoint also represents pull requests; those are not an issue proof target. */
  isPullRequest: boolean;
}

/** Safe metadata that may be sealed into a receipt after canonical issue retrieval. */
export interface SealedLinkedIssue extends LinkedIssueReference {
  contentDigest: string;
  titleBytes: number;
  bodyBytes: number;
}

/**
 * A sealed link from one model-authored scenario to the policy-owned paired
 * check that actually observed it. The model's assertion remains explanation
 * only; the status is computed solely from trusted harness observations.
 */
export interface IssueToProofScenarioBinding {
  scenarioId: string;
  obligationId: string;
  kind: AdvisoryScenarioKind;
  /** Null only when no unique paired, policy-required check was observed. */
  pairedCheckId: string | null;
  checkKind: CheckKind | null;
  base: CheckStatus | null;
  candidate: CheckStatus | null;
  status: "satisfied" | "unmet" | "missing";
  detail: string;
}

export interface IssueToProofReceiptContext {
  /** Whether this receipt represents an individual PR or a queue merge group. */
  source: "pull_request" | "merge_group";
  pullRequestTitle: string;
  /** Contains a digest and byte counts only; never canonical issue title/body. */
  linkedIssue: SealedLinkedIssue | null;
  /**
   * Computed after both trusted harness runs complete. An Issue-to-Proof gate
   * cannot be eligible unless every validated scenario is satisfied here.
   */
  scenarioBindings: IssueToProofScenarioBinding[];
}

export interface AgentAnalysis {
  status: "not_configured" | "completed" | "unavailable" | "failed" | "skipped";
  model?: string;
  hypotheses: AgentHypothesis[];
  challenges: AgentChallenge[];
  /** Validated, sanitized, non-executable guidance for maintainer probes. */
  issueToProofPlan?: IssueToProofPlan;
  limitation?: string;
}

export interface MergePolicy {
  requiredApprovals: number;
  requiredLabels: string[];
  requiredChecks: string[];
  /**
   * Optional check-run App identities keyed by required check name. Production
   * production automation requires a source for every required check.
   */
  requiredCheckAppIds?: Record<string, number>;
  mergeMethod: "merge" | "squash" | "rebase";
}

export interface LiveCheck {
  name: string;
  status: "pending" | "pass" | "fail";
  appId?: number;
  appSlug?: string;
}

export interface LivePullRequest {
  /** GitHub GraphQL node ID; used only for exact-head merge-queue enqueue. */
  nodeId: string;
  repository: string;
  pullRequest: number;
  state: "open" | "closed";
  draft: boolean;
  baseSha: string;
  /** Queue mode uses the base branch name to verify its live merge protection. */
  baseRef?: string;
  headSha: string;
  mergeSha: string | null;
  title: string;
  description: string;
  diff: string;
  labels: string[];
  approvals: number;
  checks: LiveCheck[];
}

export interface MergeAttempt {
  attemptId: string;
  runKey: string;
  expectedHeadSha: string;
  state: "started" | "merged" | "failed" | "stale" | "unknown";
  createdAt: string;
  message?: string;
}

export interface MergeDecision {
  outcome: MergeOutcome;
  reason: string;
  attempt?: MergeAttempt;
}
