import { canonicalJson, revisionRunKey, sha256, verifyReceipt } from "./crypto.js";
import {
  extractLinkedIssue,
  plannerLinkedIssueContext,
  type ProofPlanner,
} from "./agent-planner.js";
import type { CheckRunGateway } from "./check-run.js";
import type { PullRequestCommentGateway } from "./github-comment.js";
import type { RequiredStatusCheck } from "./github-gateway.js";
import type {
  EvidenceReceipt,
  CanonicalGitHubIssue,
  LinkedIssueReference,
  LivePullRequest,
  MergeDecision,
  MergePolicy,
  PinnedRevision,
  VerificationPolicy,
} from "./domain.js";
import type { GitHubPermission, InstallationTokenProvider } from "./github-app.js";
import type { PullRequestTrigger } from "./github-webhook-event.js";
import type { EvidenceHarness } from "./harness.js";
import type { EvidenceHarnessFactory } from "./harness.js";
import { RunLedger, type ExternalOperation, type RunLease } from "./ledger.js";
import { startLeaseHeartbeat } from "./lease-heartbeat.js";
import type { MergeGateway } from "./merge-broker.js";
import { MergeBroker, preflight } from "./merge-broker.js";
import type { MergeQueueGateway } from "./merge-queue.js";
import { FIXTURE_TRUSTED_ARTIFACT_DIGEST } from "./trusted-artifacts.js";
import { VerificationEngine } from "./verifier.js";

export interface GitHubGatewayFactory {
  createReadGateway(token: string): Pick<MergeGateway, "getPullRequest"> & {
    /** Optional only for fixture adapters; required by Issue-to-Proof policy at runtime. */
    getIssue?: (repository: string, issueNumber: number) => Promise<CanonicalGitHubIssue>;
    /** Required by production runtime before a PR can enter GitHub's merge queue. */
    getRequiredStatusChecks?: (
      repository: string,
      branch: string,
    ) => Promise<RequiredStatusCheck[]>;
  };
  createMergeGateway(token: string): MergeGateway;
  createQueueGateway?(token: string): MergeQueueGateway;
  createCheckRunGateway?(token: string): CheckRunGateway;
  createCommentGateway?(token: string): PullRequestCommentGateway;
}

export interface MergeProofControllerPolicy {
  allowedRepositories: string[];
  autoMergeEnabled: boolean;
  /** Direct REST merge is for fixture tests only; real automation uses GitHub's merge queue. */
  mergeStrategy: "direct_fixture" | "merge_queue";
  verification: VerificationPolicy;
  merge: MergePolicy;
  /** Injected from mounted trusted artifacts at production runtime startup. */
  trustedArtifactDigest?: string;
  /** Runtime-owned requirement for the final merge_group evidence Check Run. */
  requiredEvidenceCheck?: { name: string; appId: number };
}

export type ControllerResult =
  | { state: "ignored"; reason: string }
  | { state: "waiting"; reason: string }
  | { state: "not_eligible"; reason: string }
  | { state: "busy"; retryAt: number }
  | { state: "completed" }
  | { state: "reconciliation_required" }
  | { state: "verified"; receipt: EvidenceReceipt }
  | { state: "merged" | "queued" | "not_merged"; receipt: EvidenceReceipt; decision: MergeDecision };

const verificationPermissions = {
  contents: "read",
  pull_requests: "read",
  checks: "read",
} as const;

function verificationReadPermissions(
  policy: Pick<MergeProofControllerPolicy, "verification" | "requiredEvidenceCheck">,
): Record<string, GitHubPermission> {
  return {
    ...verificationPermissions,
    ...(policy.verification.issueToProof?.requireLinkedIssue ? { issues: "read" as const } : {}),
    ...(policy.requiredEvidenceCheck ? { administration: "read" as const } : {}),
  };
}

const mergePermissions = {
  contents: "write",
  pull_requests: "read",
} as const;

const queuePermissions = {
  pull_requests: "write",
} as const;

const queueObservationPermissions = {
  pull_requests: "read",
  merge_queues: "read",
} as const;

const checkPermissions = {
  checks: "write",
} as const;

const commentPermissions = {
  issues: "write",
} as const;
const DEFAULT_VERIFICATION_RUN_LEASE_MS = 20 * 60_000;
const AUTOMATION_PAUSED_REASON = "MergeProof automatic merge is paused by an operator.";

function requiredCheckStatus(
  live: { checks: Array<{ name: string; status: string; appId?: number }> },
  policy: MergePolicy,
): { state: "pending" | "failed"; check: string; appId?: number } | undefined {
  for (const name of policy.requiredChecks) {
    const requiredAppId = policy.requiredCheckAppIds?.[name];
    const matching = live.checks.filter(
      (check) => check.name === name && (requiredAppId === undefined || check.appId === requiredAppId),
    );
    const status = matching.some((check) => check.status === "fail")
      ? "fail"
      : matching.some((check) => check.status === "pending") || matching.length === 0
        ? "pending"
        : "pass";
    if (status !== "pass") {
      return { state: status === "fail" ? "failed" : "pending", check: name, ...(requiredAppId ? { appId: requiredAppId } : {}) };
    }
  }
  return undefined;
}

function externalOperationId(kind: "merge_queue_enqueue" | "check_run_publish", runKey: string): string {
  // The run key already seals the exact revision, policy, issue context, and
  // trusted artifact bundle. One operation of each kind is therefore safe per
  // run and cannot be replayed under a fresh process-local UUID.
  return `${kind}:${runKey}`;
}

function isReusableReconciledPrHeadCheck(
  operation: ExternalOperation,
  expected: {
    operationId: string;
    installationId: number;
    repository: string;
    pullRequest: number;
    headSha: string;
    pullRequestNodeId: string;
    conclusion: "success" | "failure";
  },
): boolean {
  return (
    operation.kind === "check_run_publish" &&
    operation.state === "observed_applied" &&
    operation.installationId === expected.installationId &&
    operation.target.repository === expected.repository &&
    operation.target.pullRequest === expected.pullRequest &&
    operation.target.pullRequest > 0 &&
    operation.target.expectedHeadSha === expected.headSha &&
    operation.target.checkName === "MergeProof / evidence" &&
    operation.expectation.pullRequestNodeId === expected.pullRequestNodeId &&
    operation.expectation.checkRunExternalId === expected.operationId &&
    operation.expectation.expectedCheckConclusion === expected.conclusion
  );
}

/**
 * A controller-side CI policy is not enough for merge-queue production: every
 * required Check Run must also be present in GitHub branch protection and
 * pinned to the App that produced it. Otherwise a later queue revision could
 * merge after a same-named or unrequired CI check changes.
 */
export function sourcePinnedBranchProtectionFailure(
  policy: Pick<MergeProofControllerPolicy, "merge" | "requiredEvidenceCheck">,
  requiredChecks: RequiredStatusCheck[],
): string | undefined {
  const requirements = [
    ...policy.merge.requiredChecks.map((name) => ({
      name,
      appId: policy.merge.requiredCheckAppIds?.[name],
    })),
    ...(policy.requiredEvidenceCheck ? [policy.requiredEvidenceCheck] : []),
  ];
  for (const requirement of requirements) {
    if (requirement.appId === undefined) {
      return `MergeProof policy is missing a source pin for required Check Run ${requirement.name}.`;
    }
    const isPinned = requiredChecks.some(
      (check) => check.name === requirement.name && check.appId === requirement.appId,
    );
    if (!isPinned) {
      return `GitHub branch protection does not require the source-pinned Check Run ${requirement.name} from App ${requirement.appId}.`;
    }
  }
  return undefined;
}

export function policyDigest(policy: MergeProofControllerPolicy): string {
  return sha256(
    canonicalJson({
      allowedRepositories: [...policy.allowedRepositories].sort(),
      autoMergeEnabled: policy.autoMergeEnabled,
      mergeStrategy: policy.mergeStrategy,
      verification: policy.verification,
      merge: policy.merge,
      trustedArtifactDigest: policy.trustedArtifactDigest ?? FIXTURE_TRUSTED_ARTIFACT_DIGEST,
      ...(policy.requiredEvidenceCheck ? { requiredEvidenceCheck: policy.requiredEvidenceCheck } : {}),
    }),
  );
}

export function trustedArtifactDigestForPolicy(policy: MergeProofControllerPolicy): string {
  return policy.trustedArtifactDigest ?? FIXTURE_TRUSTED_ARTIFACT_DIGEST;
}

/**
 * A queue worker surface: it consumes an authenticated trigger, immediately
 * reloads PR state from GitHub, and gives only the merge broker a fresh write
 * token. It deliberately contains no HTTP parsing or model authority.
 */
export class MergeProofController {
  constructor(
    private readonly policy: MergeProofControllerPolicy,
    private readonly tokens: InstallationTokenProvider,
    private readonly gateways: GitHubGatewayFactory,
    private readonly harness: EvidenceHarness | undefined,
    private readonly ledger: RunLedger,
    private readonly now: () => Date = () => new Date(),
    private readonly planner?: ProofPlanner,
    private readonly harnessFactory?: EvidenceHarnessFactory,
  ) {}

  async process(trigger: PullRequestTrigger): Promise<ControllerResult> {
    if (!this.policy.allowedRepositories.includes(trigger.repository)) {
      return { state: "ignored", reason: "Repository is not enabled for MergeProof." };
    }
    // A pause is checked before any token mint, sandbox, Check Run, queue, or
    // comment action. It is a durable emergency stop, not another policy
    // condition that a model or a stale receipt could bypass.
    if (this.ledger.automationControl().paused) {
      return { state: "not_eligible", reason: AUTOMATION_PAUSED_REASON };
    }

    const readToken = await this.tokens.mint({
      installationId: trigger.installationId,
      repository: trigger.repository,
      permissions: verificationReadPermissions(this.policy),
    });
    const readGateway = this.gateways.createReadGateway(readToken.token);
    const live = await readGateway.getPullRequest(trigger.repository, trigger.pullRequest);

    if (live.repository !== trigger.repository || live.pullRequest !== trigger.pullRequest) {
      return { state: "ignored", reason: "GitHub live state does not match the webhook trigger." };
    }
    const queuedForPullRequest = this.ledger.findQueuedRunForPullRequest(
      trigger.repository,
      trigger.pullRequest,
    );
    if (live.state !== "open" || live.draft) {
      if (queuedForPullRequest?.receipt) {
        return this.revalidateQueuedRevision(
          trigger,
          live,
          queuedForPullRequest.receipt.revision,
          queuedForPullRequest.receipt,
        );
      }
      return { state: "ignored", reason: "Pull request is closed or draft." };
    }
    if (!live.mergeSha) {
      if (queuedForPullRequest?.receipt) {
        return this.revalidateQueuedRevision(
          trigger,
          live,
          queuedForPullRequest.receipt.revision,
          queuedForPullRequest.receipt,
        );
      }
      return { state: "waiting", reason: "GitHub has not produced a test merge SHA yet." };
    }
    const linkedIssue = extractLinkedIssue(live.description);
    const canonicalIssue = await this.loadCanonicalIssue(
      readGateway,
      trigger.repository,
      linkedIssue,
    );
    const issueContext =
      linkedIssue && canonicalIssue
        ? plannerLinkedIssueContext(linkedIssue, canonicalIssue)
        : null;

    const revision: PinnedRevision = {
      repository: trigger.repository,
      pullRequest: trigger.pullRequest,
      baseSha: live.baseSha,
      headSha: live.headSha,
      mergeSha: live.mergeSha,
      policyHash: policyDigest(this.policy),
      trustedArtifactDigest: trustedArtifactDigestForPolicy(this.policy),
      ...(issueContext ? { issueContextDigest: issueContext.contentDigest } : {}),
    };
    const now = this.now();
    if (queuedForPullRequest?.receipt) {
      const queuedRevision = queuedForPullRequest.receipt.revision;
      if (revisionRunKey(queuedRevision) === revisionRunKey(revision)) {
        return this.revalidateQueuedRevision(
          trigger,
          live,
          queuedRevision,
          queuedForPullRequest.receipt,
        );
      }
      const revocationReason = "Pinned revision or canonical Issue-to-Proof context changed after queueing.";
      const revoked = await this.dequeueQueuedRevision(
        trigger,
        live,
        queuedRevision,
        revocationReason,
      );
      if (!revoked) {
        return { state: "reconciliation_required" };
      }
      await this.publishCommentBestEffort(
        trigger,
        queuedForPullRequest.receipt,
        `Removed from GitHub merge queue: ${revocationReason}`,
      );
    }

    const requiredCheck = requiredCheckStatus(live, this.policy.merge);
    if (requiredCheck) {
      const source = requiredCheck.appId ? ` (App ${requiredCheck.appId})` : "";
      if (requiredCheck.state === "pending") {
        return { state: "waiting", reason: `Required live check is pending: ${requiredCheck.check}${source}.` };
      }
      return { state: "not_eligible", reason: `Required live check failed: ${requiredCheck.check}${source}.` };
    }
    const claimed = this.ledger.claim(
      revision,
      `delivery:${trigger.deliveryId}`,
      this.verificationRunLeaseMs(),
      now.getTime(),
    );
    if (claimed.state === "busy") {
      return claimed;
    }
    if (claimed.state === "completed" || claimed.state === "reconciliation_required") {
      return claimed;
    }

    return this.processClaimedRevision(
      trigger,
      live,
      revision,
      readToken.token,
      claimed.lease,
      now,
      linkedIssue,
      canonicalIssue,
    );
  }

  private async loadCanonicalIssue(
    gateway: ReturnType<GitHubGatewayFactory["createReadGateway"]>,
    repository: string,
    reference: LinkedIssueReference | null,
  ): Promise<CanonicalGitHubIssue | undefined> {
    if (!this.policy.verification.issueToProof?.requireLinkedIssue || !reference || !gateway.getIssue) {
      return undefined;
    }
    try {
      const issue = await gateway.getIssue(repository, reference.number);
      return issue.number === reference.number && !issue.isPullRequest ? issue : undefined;
    } catch {
      // Do not expose GitHub response text or proceed with unbound issue data.
      // The verifier turns the missing canonical context into a REVIEW receipt.
      return undefined;
    }
  }

  /**
   * Queue membership is never a permanent approval. Labels, reviews, CI, or
   * the exact revision may change after enqueue, so every later trigger
   * evaluates the current GitHub state and safely removes an ineligible PR.
   */
  private async revalidateQueuedRevision(
    trigger: PullRequestTrigger,
    live: LivePullRequest,
    revision: PinnedRevision,
    receipt: EvidenceReceipt | null,
  ): Promise<ControllerResult> {
    if (!receipt) {
      return { state: "reconciliation_required" };
    }
    const failure = verifyReceipt(receipt)
      ? preflight(revision, receipt, this.policy.merge, live)
      : "Stored evidence receipt failed integrity verification.";
    if (!failure) {
      const queueState = await this.observeQueuedRevision(trigger, live, revision);
      if (queueState === "not_queued") {
        const reason = "GitHub no longer reports the exact pinned PR revision in its merge queue.";
        if (!this.ledger.revokeQueuedRevision(revision, reason, this.now().getTime())) {
          return { state: "reconciliation_required" };
        }
        await this.publishCommentBestEffort(trigger, receipt, reason);
        return { state: "not_eligible", reason };
      }
      if (queueState !== "queued") {
        return { state: "reconciliation_required" };
      }
      return { state: "completed" };
    }
    const revoked = await this.dequeueQueuedRevision(trigger, live, revision, failure);
    if (!revoked) {
      return { state: "reconciliation_required" };
    }
    await this.publishCommentBestEffort(
      trigger,
      receipt,
      `Removed from GitHub merge queue: ${failure}`,
    );
    return { state: "not_eligible", reason: `Removed from GitHub merge queue: ${failure}` };
  }

  /**
   * Observes only GitHub's current queue state for the sealed PR head. A
   * missing adapter, a malformed response, or a read failure is ambiguous and
   * intentionally prevents the caller from treating the queue as healthy.
   */
  private async observeQueuedRevision(
    trigger: PullRequestTrigger,
    live: LivePullRequest,
    revision: PinnedRevision,
  ): Promise<"queued" | "not_queued" | "unknown"> {
    if (!this.gateways.createQueueGateway) {
      return "unknown";
    }
    try {
      const token = await this.tokens.mint({
        installationId: trigger.installationId,
        repository: trigger.repository,
        permissions: queueObservationPermissions,
      });
      const queue = this.gateways.createQueueGateway(token.token);
      if (!queue.observeQueuedPullRequest) {
        return "unknown";
      }
      const observation = await queue.observeQueuedPullRequest({
        repository: trigger.repository,
        pullRequestNodeId: live.nodeId,
        expectedHeadSha: revision.headSha,
      });
      return observation.state === "queued" || observation.state === "not_queued"
        ? observation.state
        : "unknown";
    } catch {
      return "unknown";
    }
  }

  /** Returns false when GitHub did not confirm the safety dequeue. */
  private async dequeueQueuedRevision(
    trigger: PullRequestTrigger,
    live: LivePullRequest,
    revision: PinnedRevision,
    reason: string,
  ): Promise<boolean> {
    if (!this.gateways.createQueueGateway) {
      return false;
    }
    const token = await this.tokens.mint({
      installationId: trigger.installationId,
      repository: trigger.repository,
      permissions: queuePermissions,
    });
    const queue = this.gateways.createQueueGateway(token.token);
    if (!queue.dequeue) {
      return false;
    }
    try {
      await queue.dequeue({
        repository: trigger.repository,
        pullRequestNodeId: live.nodeId,
      });
    } catch {
      return false;
    }
    return this.ledger.revokeQueuedRevision(revision, reason, this.now().getTime());
  }

  /**
   * A PR comment explains a result but never grants merge authority. Publish it
   * only after the durable state transition it describes, and never let a
   * transient GitHub comment failure strand a verified or queued revision.
   */
  private async publishCommentBestEffort(
    trigger: PullRequestTrigger,
    receipt: EvidenceReceipt,
    eligibilityReason?: string,
  ): Promise<void> {
    if (!this.gateways.createCommentGateway) {
      return;
    }
    try {
      const token = await this.tokens.mint({
        installationId: trigger.installationId,
        repository: trigger.repository,
        permissions: commentPermissions,
      });
      await this.gateways.createCommentGateway(token.token).upsert({
        repository: trigger.repository,
        pullRequest: trigger.pullRequest,
        receipt,
        ...(eligibilityReason ? { eligibilityReason } : {}),
      });
    } catch {
      // The evidence Check Run and queue operation are the authoritative
      // surfaces. The next eligible delivery can refresh this explanation.
    }
  }

  private async processClaimedRevision(
    trigger: PullRequestTrigger,
    live: LivePullRequest,
    revision: PinnedRevision,
    readToken: string,
    lease: RunLease,
    now: Date,
    linkedIssue: LinkedIssueReference | null,
    canonicalIssue: CanonicalGitHubIssue | undefined,
  ): Promise<ControllerResult> {
    const runLeaseMs = this.verificationRunLeaseMs();
    const heartbeat = startLeaseHeartbeat(
      `Verification ${lease.runKey}`,
      () => this.ledger.renewRunLease(lease, runLeaseMs, this.now().getTime()),
      runLeaseMs,
    );
    try {
      const harness = this.harnessFactory?.create({
        revision,
        githubReadToken: readToken,
      }) ?? this.harness;
      if (!harness) {
        throw new Error("No evidence harness is configured for this MergeProof controller.");
      }
      const receipt = await new VerificationEngine(harness, this.planner).verify(
        revision,
        this.policy.verification,
        now,
        {
          title: live.title,
          description: live.description,
          diff: live.diff,
          ...(linkedIssue ? { linkedIssue } : {}),
          ...(canonicalIssue ? { canonicalIssue } : {}),
        },
      );
      heartbeat.assertHealthy();
      this.ledger.recordReceipt(lease, receipt, this.now().getTime());

      // The control can change while the sandbox is running. Do not publish a
      // fresh success signal or spend a write token after that pause.
      if (this.ledger.automationControl().paused) {
        heartbeat.assertHealthy();
        this.ledger.markNotEligible(lease, AUTOMATION_PAUSED_REASON, this.now().getTime());
        await this.publishCommentBestEffort(trigger, receipt, AUTOMATION_PAUSED_REASON);
        return {
          state: "not_merged",
          receipt,
          decision: { outcome: "NOT_ELIGIBLE", reason: AUTOMATION_PAUSED_REASON },
        };
      }

      // Merge queue eligibility is evaluated on the PR head, while the sealed
      // receipt records the stronger current test-merge SHA. GitHub's later
      // merge_group check re-verifies the actual queue-generated revision.
      if (this.policy.mergeStrategy === "merge_queue") {
        let eligibilityReason: string | undefined;
        if (receipt.verdict === "LOW_OBSERVED_RISK" && this.policy.autoMergeEnabled) {
          const finalReadToken = await this.tokens.mint({
            installationId: trigger.installationId,
            repository: trigger.repository,
            permissions: verificationReadPermissions(this.policy),
          });
          const finalReadGateway = this.gateways.createReadGateway(finalReadToken.token);
          const finalLive = await finalReadGateway.getPullRequest(
            trigger.repository,
            trigger.pullRequest,
          );
          eligibilityReason = preflight(revision, receipt, this.policy.merge, finalLive) ?? undefined;
          if (!eligibilityReason && this.policy.requiredEvidenceCheck) {
            if (!finalLive.baseRef || !finalReadGateway.getRequiredStatusChecks) {
              eligibilityReason = "Cannot verify that GitHub requires the final MergeProof merge-group Check Run.";
            } else {
              const requiredChecks = await finalReadGateway.getRequiredStatusChecks(
                trigger.repository,
                finalLive.baseRef,
              );
              eligibilityReason = sourcePinnedBranchProtectionFailure(this.policy, requiredChecks);
            }
          }
        }
        if (!this.gateways.createCheckRunGateway) {
          throw new Error("Merge-queue strategy requires a Check Run gateway.");
        }
        const eligibleForQueue =
          receipt.verdict === "LOW_OBSERVED_RISK" &&
          this.policy.autoMergeEnabled &&
          !eligibilityReason;
        const nonEligibilityReason = eligibilityReason ?? (
          receipt.verdict !== "LOW_OBSERVED_RISK"
            ? `Evidence receipt verdict ${receipt.verdict} is not eligible for automatic merge.`
            : "Automatic merge is disabled by the active MergeProof policy."
        );
        const expectedCheckConclusion = eligibleForQueue ? "success" : "failure";
        // Every PR-head conclusion is journaled before Check Run creation.
        // This covers safe, live-policy-failed, and review/non-low-risk
        // receipts: an interrupted Check Run can only be read back or failed
        // closed, never blindly published a second time.
        heartbeat.assertHealthy();
        this.ledger.beginPublication(lease, this.now().getTime());
        const checkOperationId = externalOperationId("check_run_publish", lease.runKey);
        const expectedCheck = {
          operationId: checkOperationId,
          installationId: trigger.installationId,
          repository: trigger.repository,
          pullRequest: trigger.pullRequest,
          headSha: revision.headSha,
          pullRequestNodeId: live.nodeId,
          conclusion: expectedCheckConclusion,
        } as const;
        const priorCheckOperation = this.ledger.getExternalOperation(checkOperationId);
        const reuseRecoveredPrHeadCheck =
          priorCheckOperation !== null &&
          isReusableReconciledPrHeadCheck(priorCheckOperation, expectedCheck);
        if (priorCheckOperation && !reuseRecoveredPrHeadCheck) {
          // A prior unresolved, mismatched, or non-successful journal entry
          // must be reconciled rather than turned into a new Check Run or
          // merge-queue enqueue.
          return { state: "reconciliation_required" };
        }
        if (!reuseRecoveredPrHeadCheck) {
          const prepared = this.ledger.prepareExternalOperation(
            lease,
            {
              operationId: checkOperationId,
              kind: "check_run_publish",
              installationId: trigger.installationId,
              target: {
                repository: trigger.repository,
                pullRequest: trigger.pullRequest,
                expectedHeadSha: revision.headSha,
                checkName: "MergeProof / evidence",
              },
              expectation: {
                pullRequestNodeId: live.nodeId,
                checkRunExternalId: checkOperationId,
                expectedCheckConclusion,
              },
            },
            this.now().getTime(),
          );
          if (prepared.state === "already_recorded") {
            return { state: "reconciliation_required" };
          }
          const checkToken = await this.tokens.mint({
            installationId: trigger.installationId,
            repository: trigger.repository,
            permissions: checkPermissions,
          });
          const checkGateway = this.gateways.createCheckRunGateway(checkToken.token);
          heartbeat.assertHealthy();
          const checkRun = await checkGateway.createInProgress({
            repository: trigger.repository,
            headSha: live.headSha,
            name: "MergeProof / evidence",
            externalId: checkOperationId,
          });
          heartbeat.assertHealthy();
          this.ledger.bindCheckRunToOperation(lease, checkOperationId, checkRun.id, this.now().getTime());
          heartbeat.assertHealthy();
          await checkGateway.complete({
            repository: trigger.repository,
            checkRunId: checkRun.id,
            receipt,
            ...(expectedCheckConclusion === "failure"
              ? { conclusion: "failure" as const, summaryNote: nonEligibilityReason }
              : {}),
          });
          heartbeat.assertHealthy();
          this.ledger.confirmCheckRunCompletion(
            lease,
            checkOperationId,
            checkRun.id,
            this.now().getTime(),
          );
        }

        if (!eligibleForQueue) {
          heartbeat.assertHealthy();
          if (
            nonEligibilityReason.includes("SHA changed") ||
            nonEligibilityReason.includes("closed") ||
            nonEligibilityReason.includes("identity")
          ) {
            this.ledger.markStale(lease, nonEligibilityReason, this.now().getTime());
            await this.publishCommentBestEffort(trigger, receipt, nonEligibilityReason);
            return {
              state: "not_merged",
              receipt,
              decision: { outcome: "STALE", reason: nonEligibilityReason },
            };
          }
          this.ledger.markNotEligibleAfterPublication(
            lease,
            nonEligibilityReason,
            this.now().getTime(),
          );
          await this.publishCommentBestEffort(trigger, receipt, nonEligibilityReason);
          return {
            state: "not_merged",
            receipt,
            decision: { outcome: "NOT_ELIGIBLE", reason: nonEligibilityReason },
          };
        }
      }
      if (receipt.verdict !== "LOW_OBSERVED_RISK" || !this.policy.autoMergeEnabled) {
        if (receipt.verdict === "LOW_OBSERVED_RISK" && !this.policy.autoMergeEnabled) {
          heartbeat.assertHealthy();
          this.ledger.markNotEligible(
            lease,
            "Automatic merge is disabled by the active MergeProof policy.",
            this.now().getTime(),
          );
          await this.publishCommentBestEffort(
            trigger,
            receipt,
            "Automatic merge is disabled by the active MergeProof policy.",
          );
        } else if (this.policy.mergeStrategy === "merge_queue") {
          await this.publishCommentBestEffort(trigger, receipt);
        }
        return { state: "verified", receipt };
      }

      if (this.policy.mergeStrategy === "merge_queue") {
        if (!this.gateways.createQueueGateway) {
          throw new Error("Merge-queue strategy requires a queue gateway.");
        }
        // Fence the final external queue write independently of the earlier
        // sandbox/CI preflight. If a pause lands in this narrow window, the
        // existing PR-head result is never admitted to GitHub's queue.
        if (this.ledger.automationControl().paused) {
          heartbeat.assertHealthy();
          this.ledger.markNotEligibleAfterPublication(
            lease,
            AUTOMATION_PAUSED_REASON,
            this.now().getTime(),
          );
          await this.publishCommentBestEffort(trigger, receipt, AUTOMATION_PAUSED_REASON);
          return {
            state: "not_merged",
            receipt,
            decision: { outcome: "NOT_ELIGIBLE", reason: AUTOMATION_PAUSED_REASON },
          };
        }
        const queueToken = await this.tokens.mint({
          installationId: trigger.installationId,
          repository: trigger.repository,
          permissions: queuePermissions,
        });
        heartbeat.assertHealthy();
        const queueOperation = this.ledger.prepareExternalOperation(
          lease,
          {
            operationId: externalOperationId("merge_queue_enqueue", lease.runKey),
            kind: "merge_queue_enqueue",
            installationId: trigger.installationId,
            target: {
              repository: trigger.repository,
              pullRequest: trigger.pullRequest,
              expectedHeadSha: revision.headSha,
            },
            expectation: { pullRequestNodeId: live.nodeId },
          },
          this.now().getTime(),
        );
        if (queueOperation.state === "already_recorded") {
          return { state: "reconciliation_required" };
        }
        const queued = await this.gateways.createQueueGateway(queueToken.token).enqueue({
          repository: trigger.repository,
          pullRequestNodeId: live.nodeId,
          expectedHeadSha: revision.headSha,
        });
        heartbeat.assertHealthy();
        this.ledger.markQueued(lease, this.now().getTime());
        await this.publishCommentBestEffort(
          trigger,
          receipt,
          "Queued in GitHub's merge queue; final evidence runs against the queue-generated revision.",
        );
        return {
          state: "queued",
          receipt,
          decision: { outcome: "QUEUED", reason: queued.message },
        };
      }

      const writeToken = await this.tokens.mint({
        installationId: trigger.installationId,
        repository: trigger.repository,
        permissions: mergePermissions,
      });
      heartbeat.assertHealthy();
      const decision = await new MergeBroker(
        this.gateways.createMergeGateway(writeToken.token),
        this.ledger,
      ).mergeIfEligible({
        revision,
        receipt,
        policy: this.policy.merge,
        lease,
        installationId: trigger.installationId,
        now,
      });
      return {
        state: decision.outcome === "MERGED" ? "merged" : "not_merged",
        receipt,
        decision,
      };
    } finally {
      heartbeat.stop();
    }
  }

  /** Source-backed factories publish a sealed E2B-aware lease; fixtures retain the POC default. */
  private verificationRunLeaseMs(): number {
    return this.harnessFactory?.verificationLeaseMs ?? DEFAULT_VERIFICATION_RUN_LEASE_MS;
  }
}
