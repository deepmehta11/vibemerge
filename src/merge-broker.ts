import { randomUUID } from "node:crypto";

import type {
  EvidenceReceipt,
  LivePullRequest,
  MergeAttempt,
  MergeDecision,
  MergePolicy,
  PinnedRevision,
} from "./domain.js";
import type { RunLease } from "./ledger.js";
import { RunLedger } from "./ledger.js";

export interface MergeGateway {
  getPullRequest(repository: string, pullRequest: number): Promise<LivePullRequest>;
  merge(input: {
    repository: string;
    pullRequest: number;
    expectedHeadSha: string;
    method: MergePolicy["mergeMethod"];
  }): Promise<{ merged: boolean; message: string }>;
}

function findCheck(
  live: LivePullRequest,
  name: string,
  requiredAppId?: number,
): "pending" | "pass" | "fail" {
  const matches = live.checks.filter(
    (check) => check.name === name && (requiredAppId === undefined || check.appId === requiredAppId),
  );
  if (matches.length === 0) {
    return "pending";
  }
  if (matches.some((check) => check.status === "fail")) {
    return "fail";
  }
  if (matches.some((check) => check.status === "pending")) {
    return "pending";
  }
  return "pass";
}

export function preflight(
  revision: PinnedRevision,
  receipt: EvidenceReceipt,
  policy: MergePolicy,
  live: LivePullRequest,
  requiredEvidenceCheck?: { name: string; appId: number },
): string | null {
  if (receipt.verdict !== "LOW_OBSERVED_RISK") {
    return `Verification verdict ${receipt.verdict} is not eligible for automatic merging.`;
  }
  if (live.repository !== revision.repository || live.pullRequest !== revision.pullRequest) {
    return "Live pull request identity does not match the pinned receipt.";
  }
  if (live.state !== "open" || live.draft) {
    return "Pull request is closed or draft.";
  }
  if (live.baseSha !== revision.baseSha) {
    return "Base SHA changed after verification.";
  }
  if (live.headSha !== revision.headSha) {
    return "Head SHA changed after verification.";
  }
  if (live.mergeSha !== revision.mergeSha) {
    return "Test merge SHA changed after verification.";
  }
  if (live.approvals < policy.requiredApprovals) {
    return "Required approvals are not present.";
  }
  for (const label of policy.requiredLabels) {
    if (!live.labels.includes(label)) {
      return `Required label is missing: ${label}.`;
    }
  }
  for (const check of policy.requiredChecks) {
    const requiredAppId = policy.requiredCheckAppIds?.[check];
    const status = findCheck(live, check, requiredAppId);
    if (status !== "pass") {
      return `Required live check is ${status}: ${check}${requiredAppId ? ` (App ${requiredAppId})` : ""}.`;
    }
  }
  if (requiredEvidenceCheck) {
    const status = findCheck(live, requiredEvidenceCheck.name, requiredEvidenceCheck.appId);
    if (status !== "pass") {
      return `Required VibeMerge evidence check is ${status}: ${requiredEvidenceCheck.name} (App ${requiredEvidenceCheck.appId}).`;
    }
  }
  return null;
}

/**
 * This class contains no model calls. It is the sole place authorized to call
 * the GitHub merge API after an evidence receipt and exact live preflight.
 */
export class MergeBroker {
  constructor(
    private readonly gateway: MergeGateway,
    private readonly ledger: RunLedger,
  ) {}

  async mergeIfEligible(input: {
    revision: PinnedRevision;
    receipt: EvidenceReceipt;
    policy: MergePolicy;
    lease: RunLease;
    /** Retained only in the outbound journal so recovery can mint a read token. */
    installationId: number;
    /** API mode requires this controller-owned evidence Check Run to be green. */
    requiredEvidenceCheck?: { name: string; appId: number };
    now?: Date;
  }): Promise<MergeDecision> {
    const live = await this.gateway.getPullRequest(
      input.revision.repository,
      input.revision.pullRequest,
    );
    const failure = preflight(
      input.revision,
      input.receipt,
      input.policy,
      live,
      input.requiredEvidenceCheck,
    );
    if (failure) {
      if (
        failure.includes("SHA changed") ||
        failure.includes("closed") ||
        failure.includes("identity")
      ) {
        this.ledger.markStale(input.lease, failure, input.now?.getTime());
        return { outcome: "STALE", reason: failure };
      }
      this.ledger.markNotEligible(input.lease, failure, input.now?.getTime());
      return { outcome: "NOT_ELIGIBLE", reason: failure };
    }

    const now = input.now ?? new Date();
    const attempt: MergeAttempt = {
      attemptId: randomUUID(),
      runKey: input.receipt.runKey,
      expectedHeadSha: input.revision.headSha,
      state: "started",
      createdAt: now.toISOString(),
    };
    this.ledger.beginMerge(input.lease, attempt, now.getTime());
    const operation = this.ledger.prepareExternalOperation(
      input.lease,
      {
        operationId: `direct_merge:${input.receipt.runKey}`,
        kind: "direct_merge",
        installationId: input.installationId,
        target: {
          repository: input.revision.repository,
          pullRequest: input.revision.pullRequest,
          expectedHeadSha: input.revision.headSha,
        },
        expectation: { pullRequestNodeId: live.nodeId },
      },
      now.getTime(),
    );
    if (operation.state === "already_recorded") {
      const message = "Direct merge was already journaled and requires read-only reconciliation before any retry.";
      this.ledger.markMergeUnknown(input.lease, attempt, message, now.getTime());
      return {
        outcome: "MERGE_UNKNOWN",
        reason: message,
        attempt: { ...attempt, state: "unknown", message },
      };
    }
    try {
      const result = await this.gateway.merge({
        repository: input.revision.repository,
        pullRequest: input.revision.pullRequest,
        expectedHeadSha: input.revision.headSha,
        method: input.policy.mergeMethod,
      });
      this.ledger.finishMerge(
        input.lease,
        attempt,
        result.merged,
        result.message,
        now.getTime(),
      );
      return {
        outcome: result.merged ? "MERGED" : "MERGE_FAILED",
        reason: result.message,
        attempt: { ...attempt, state: result.merged ? "merged" : "failed", message: result.message },
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Merge gateway returned an unknown failure.";
      this.ledger.markMergeUnknown(input.lease, attempt, message, now.getTime());
      return {
        outcome: "MERGE_UNKNOWN",
        reason: "Merge result is unknown and requires reconciliation before any retry.",
        attempt: { ...attempt, state: "unknown", message },
      };
    }
  }
}

/** Test/demo gateway. It models GitHub's expected-head conflict check. */
export class MemoryMergeGateway implements MergeGateway {
  mergeCalls = 0;

  constructor(
    private readonly pullRequest: LivePullRequest,
    private readonly mergeResult: { merged: boolean; message: string } = {
      merged: true,
      message: "Merged by MergeProof fixture gateway.",
    },
  ) {}

  async getPullRequest(): Promise<LivePullRequest> {
    return structuredClone(this.pullRequest);
  }

  async merge(input: {
    expectedHeadSha: string;
  }): Promise<{ merged: boolean; message: string }> {
    this.mergeCalls += 1;
    if (input.expectedHeadSha !== this.pullRequest.headSha) {
      return { merged: false, message: "Head SHA no longer matches." };
    }
    return this.mergeResult;
  }
}
