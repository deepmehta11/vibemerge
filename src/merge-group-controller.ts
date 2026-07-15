import {
  extractLinkedIssue,
  plannerLinkedIssueContext,
} from "./agent-planner.js";
import type { CheckRunGateway } from "./check-run.js";
import {
  policyDigest,
  sourcePinnedBranchProtectionFailure,
  trustedArtifactDigestForPolicy,
  type MergeProofControllerPolicy,
} from "./controller.js";
import { verifyReceipt } from "./crypto.js";
import type { CanonicalGitHubIssue, EvidenceReceipt, LivePullRequest, PinnedRevision } from "./domain.js";
import type { RequiredStatusCheck } from "./github-gateway.js";
import type { GitHubPermission, InstallationTokenProvider } from "./github-app.js";
import type { EvidenceHarnessFactory } from "./harness.js";
import type { MergeGroupTrigger } from "./github-webhook-event.js";
import { RunLedger } from "./ledger.js";
import { startLeaseHeartbeat } from "./lease-heartbeat.js";
import { preflight } from "./merge-broker.js";
import { VerificationEngine } from "./verifier.js";

const sourcePermissions = { contents: "read" } as const;
const checkPermissions = { checks: "write" } as const;
const DEFAULT_VERIFICATION_RUN_LEASE_MS = 20 * 60_000;

export interface MergeGroupReadGateway {
  getPullRequestsForCommit(repository: string, commitSha: string): Promise<number[]>;
  getPullRequest(repository: string, pullRequest: number): Promise<LivePullRequest>;
  getIssue?(repository: string, issueNumber: number): Promise<CanonicalGitHubIssue>;
  getRequiredStatusChecks?(
    repository: string,
    branch: string,
  ): Promise<RequiredStatusCheck[]>;
}

function mergeGroupReadPermissions(
  policy: Pick<MergeProofControllerPolicy, "verification" | "requiredEvidenceCheck">,
): Record<string, GitHubPermission> {
  return {
    contents: "read",
    pull_requests: "read",
    checks: "read",
    ...(policy.verification.issueToProof?.requireLinkedIssue ? { issues: "read" as const } : {}),
    ...(policy.requiredEvidenceCheck ? { administration: "read" as const } : {}),
  };
}

export type MergeGroupResult =
  | { state: "ignored"; reason: string }
  | { state: "busy"; retryAt: number }
  | { state: "completed" }
  | { state: "reconciliation_required" }
  | { state: "reported"; receipt: EvidenceReceipt };

/**
 * Runs the final policy gate over GitHub's queue-generated merge SHA. A
 * successful Check Run is the only success signal the merge queue consumes.
 */
export class MergeGroupController {
  constructor(
    private readonly policy: Pick<
      MergeProofControllerPolicy,
      | "allowedRepositories"
      | "autoMergeEnabled"
      | "mergeStrategy"
      | "verification"
      | "merge"
      | "trustedArtifactDigest"
      | "requiredEvidenceCheck"
    >,
    private readonly tokens: InstallationTokenProvider,
    private readonly harnesses: EvidenceHarnessFactory,
    private readonly checks: { create(token: string): CheckRunGateway },
    private readonly reads: { create(token: string): MergeGroupReadGateway },
    private readonly ledger: RunLedger,
    private readonly now: () => Date = () => new Date(),
    private readonly checkName = "MergeProof / evidence",
  ) {}

  async process(trigger: MergeGroupTrigger): Promise<MergeGroupResult> {
    if (!this.policy.allowedRepositories.includes(trigger.repository)) {
      return { state: "ignored", reason: "Repository is not enabled for MergeProof." };
    }
    if (!this.policy.autoMergeEnabled || this.policy.mergeStrategy !== "merge_queue") {
      return { state: "ignored", reason: "Merge-queue verification is not enabled by policy." };
    }
    // Do not create a new merge-group success signal while the durable
    // emergency stop is active. An already-queued PR must still be removed
    // from GitHub's queue by the documented emergency procedure.
    if (this.ledger.automationControl().paused) {
      return { state: "ignored", reason: "MergeProof automatic merge is paused by an operator." };
    }

    const revision: PinnedRevision = {
      repository: trigger.repository,
      // GitHub's merge_group payload does not identify one PR; this sentinel
      // makes its receipt unique to the actual base and queue-generated SHA.
      pullRequest: 0,
      baseSha: trigger.baseSha,
      headSha: trigger.headSha,
      mergeSha: trigger.headSha,
      policyHash: policyDigest(this.policy),
      trustedArtifactDigest: trustedArtifactDigestForPolicy(this.policy),
    };
    const now = this.now();
    const runLeaseMs = this.harnesses.verificationLeaseMs ?? DEFAULT_VERIFICATION_RUN_LEASE_MS;
    const claimed = this.ledger.claim(
      revision,
      `delivery:${trigger.deliveryId}`,
      runLeaseMs,
      now.getTime(),
    );
    if (claimed.state !== "claimed") {
      return claimed;
    }
    const heartbeat = startLeaseHeartbeat(
      `Merge-group verification ${claimed.lease.runKey}`,
      () => this.ledger.renewRunLease(claimed.lease, runLeaseMs, this.now().getTime()),
      runLeaseMs,
    );

    try {
      const liveReadToken = await this.tokens.mint({
        installationId: trigger.installationId,
        repository: trigger.repository,
        permissions: mergeGroupReadPermissions(this.policy),
      });
      const eligibilityReason = await this.revalidateMergeGroupParticipants(
        trigger,
        this.reads.create(liveReadToken.token),
      );
      heartbeat.assertHealthy();
      const sourceToken = await this.tokens.mint({
        installationId: trigger.installationId,
        repository: trigger.repository,
        permissions: sourcePermissions,
      });
      const receipt = await new VerificationEngine(
        this.harnesses.create({ revision, githubReadToken: sourceToken.token }),
        // Merge groups have no individual PR or issue content. The original
        // PR receipt already performed Issue-to-Proof; this final pass is
        // deterministic evidence over the actual queue-generated revision.
      ).verify(revision, this.policy.verification, now, {
        title: "GitHub merge group",
        description: "Queue-generated revision; no individual PR content is trusted here.",
        diff: "",
      });
      heartbeat.assertHealthy();
      // Queue eligibility may have changed while the exact merge-group SHA
      // was being tested. Re-read every participant and the branch's
      // source-pinned required Check Run immediately before publishing the
      // only success signal GitHub's merge queue consumes.
      const finalEligibilityReason = eligibilityReason ?? await this.revalidateMergeGroupParticipants(
        trigger,
        this.reads.create(liveReadToken.token),
      );
      heartbeat.assertHealthy();
      this.ledger.recordReceipt(claimed.lease, receipt, this.now().getTime());
      // A pause can be requested while the exact queue revision is being
      // measured. Preserve the sealed observation for operators, but never
      // create the final success/failure Check Run from work that crossed the
      // emergency-stop fence.
      if (this.ledger.automationControl().paused) {
        heartbeat.assertHealthy();
        this.ledger.markNotEligible(
          claimed.lease,
          "MergeProof automatic merge is paused by an operator.",
          this.now().getTime(),
        );
        return { state: "completed" };
      }
      heartbeat.assertHealthy();
      this.ledger.beginPublication(claimed.lease, this.now().getTime());
      const conclusion =
        receipt.verdict === "LOW_OBSERVED_RISK" && !finalEligibilityReason ? "success" : "failure";
      const operationId = `check_run_publish:${claimed.lease.runKey}`;
      const prepared = this.ledger.prepareExternalOperation(
        claimed.lease,
        {
          operationId,
          kind: "check_run_publish",
          installationId: trigger.installationId,
          target: {
            repository: trigger.repository,
            // GitHub merge_group payloads deliberately omit an individual PR.
            pullRequest: 0,
            expectedHeadSha: trigger.headSha,
            checkName: this.checkName,
          },
          expectation: {
            checkRunExternalId: operationId,
            expectedCheckConclusion: conclusion,
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
      const checkGateway = this.checks.create(checkToken.token);
      heartbeat.assertHealthy();
      const checkRun = await checkGateway.createInProgress({
        repository: trigger.repository,
        headSha: trigger.headSha,
        name: this.checkName,
        externalId: operationId,
      });
      heartbeat.assertHealthy();
      this.ledger.bindCheckRunToOperation(claimed.lease, operationId, checkRun.id, this.now().getTime());
      heartbeat.assertHealthy();
      await checkGateway.complete({
        repository: trigger.repository,
        checkRunId: checkRun.id,
        receipt,
        conclusion,
        ...(finalEligibilityReason ? { summaryNote: finalEligibilityReason } : {}),
      });
      heartbeat.assertHealthy();
      this.ledger.confirmCheckRunCompletion(
        claimed.lease,
        operationId,
        checkRun.id,
        this.now().getTime(),
      );
      heartbeat.assertHealthy();
      this.ledger.markReported(
        claimed.lease,
        this.now().getTime(),
        receipt.verdict === "LOW_OBSERVED_RISK" && !finalEligibilityReason ? "READY" : "NOT_ELIGIBLE",
      );
      return { state: "reported", receipt };
    } finally {
      heartbeat.stop();
    }
  }

  /**
   * GitHub sends a merge-group SHA, not a PR number. Resolve every PR GitHub
   * associates with that SHA and require a still-queued, sealed PR receipt
   * whose live approvals, labels, CI, heads, test merge, and issue digest are
   * all still current. An ambiguous association blocks the final Check Run.
   */
  private async revalidateMergeGroupParticipants(
    trigger: MergeGroupTrigger,
    gateway: MergeGroupReadGateway,
  ): Promise<string | undefined> {
    const pullRequests = await gateway.getPullRequestsForCommit(trigger.repository, trigger.headSha);
    if (pullRequests.length === 0) {
      return "GitHub did not associate the merge-group revision with any pull request.";
    }
    const baseBranches = new Set<string>();
    for (const pullRequest of [...new Set(pullRequests)].sort((left, right) => left - right)) {
      const run = this.ledger.findQueuedRunForPullRequest(trigger.repository, pullRequest);
      if (!run?.receipt) {
        return `Merge-group pull request #${pullRequest} lacks a currently queued MergeProof receipt.`;
      }
      if (!verifyReceipt(run.receipt)) {
        return `Merge-group pull request #${pullRequest} has an invalid sealed MergeProof receipt.`;
      }
      const live = await gateway.getPullRequest(trigger.repository, pullRequest);
      if (live.baseRef) {
        baseBranches.add(live.baseRef);
      }
      const failure = preflight(run.receipt.revision, run.receipt, this.policy.merge, live);
      if (failure) {
        return `Merge-group pull request #${pullRequest} is no longer eligible: ${failure}`;
      }
      const issueFailure = await this.currentIssueContextFailure(
        trigger.repository,
        live,
        run.receipt,
        gateway,
      );
      if (issueFailure) {
        return `Merge-group pull request #${pullRequest} is no longer eligible: ${issueFailure}`;
      }
    }
    return this.requiredEvidenceCheckFailure(trigger.repository, baseBranches, gateway);
  }

  /**
   * The success Check Run only gates a merge when GitHub's live protection
   * requires this exact Check Run from this exact App. This is deliberately
   * rechecked at the final merge-group boundary, not trusted from enqueue.
   */
  private async requiredEvidenceCheckFailure(
    repository: string,
    baseBranches: ReadonlySet<string>,
    gateway: MergeGroupReadGateway,
  ): Promise<string | undefined> {
    if (!this.policy.requiredEvidenceCheck) {
      return undefined;
    }
    if (baseBranches.size === 0 || !gateway.getRequiredStatusChecks) {
      return "Cannot verify that GitHub requires the final MergeProof merge-group Check Run.";
    }
    try {
      for (const branch of [...baseBranches].sort()) {
        const requiredChecks = await gateway.getRequiredStatusChecks(repository, branch);
        const failure = sourcePinnedBranchProtectionFailure(this.policy, requiredChecks);
        if (failure) {
          return failure;
        }
      }
      return undefined;
    } catch {
      return "Cannot verify that GitHub requires the final MergeProof merge-group Check Run.";
    }
  }

  private async currentIssueContextFailure(
    repository: string,
    live: LivePullRequest,
    receipt: EvidenceReceipt,
    gateway: MergeGroupReadGateway,
  ): Promise<string | undefined> {
    if (!this.policy.verification.issueToProof?.requireLinkedIssue) {
      return undefined;
    }
    const reference = extractLinkedIssue(live.description);
    if (!reference || !receipt.revision.issueContextDigest || !gateway.getIssue) {
      return "The canonical Issue-to-Proof binding is missing.";
    }
    try {
      const issue = await gateway.getIssue(repository, reference.number);
      const context = !issue.isPullRequest
        ? plannerLinkedIssueContext(reference, issue)
        : null;
      if (!context || context.contentDigest !== receipt.revision.issueContextDigest) {
        return "The canonical Issue-to-Proof content changed after queueing.";
      }
      return undefined;
    } catch {
      return "The canonical Issue-to-Proof binding could not be reloaded.";
    }
  }
}
