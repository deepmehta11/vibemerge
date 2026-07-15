import type {
  ExternalOperation,
  ExternalOperationExpectation,
  ExternalOperationTarget,
  ReconciliationResolution,
} from "./ledger.js";

/**
 * These are intentionally read-only interfaces.  A reconciler may inspect
 * GitHub's current state, but it has no method capable of retrying a merge,
 * queue enqueue, or Check Run publication.
 */
export interface ReadOnlyReconciliationReader {
  observeMergeQueue(input: ReconciliationReadRequest): Promise<MergeQueueObservation>;
  observeDirectMerge(input: ReconciliationReadRequest): Promise<DirectMergeObservation>;
  observeCheckRun(input: ReconciliationReadRequest): Promise<CheckRunObservation>;
}

/**
 * The installation id is retained so a deployment can mint a fresh scoped
 * read token after the webhook payload has been erased.  No credential is
 * stored in the journal or passed through this interface.
 */
export interface ReconciliationReadRequest {
  installationId: number;
  target: ExternalOperationTarget;
  expectation: ExternalOperationExpectation;
}

interface ExactObservation<K extends ExternalOperation["kind"], S extends string> {
  kind: K;
  target: ExternalOperationTarget;
  expectation: ExternalOperationExpectation;
  state: S;
}

export type MergeQueueObservation = ExactObservation<
  "merge_queue_enqueue",
  "queued" | "not_queued" | "unknown"
>;

export type DirectMergeObservation = ExactObservation<
  "direct_merge",
  "merged" | "not_merged" | "unknown"
>;

export type CheckRunObservation = ExactObservation<
  "check_run_publish",
  "published" | "completed_other" | "in_progress" | "unknown"
> & {
  /** Present only for an exact Check Run, including an interrupted one. */
  checkRunId?: number;
};

/**
 * Resolves only a direct, exact observation of the already-journaled intent.
 * A mismatch, absence, transport error, or unknown state returns ambiguous.
 * This function never writes and never asks the reader to replay an action.
 */
export async function resolveExternalOperationReadOnly(
  operation: ExternalOperation,
  reader: ReadOnlyReconciliationReader,
): Promise<ReconciliationResolution> {
  const target: ExternalOperationTarget = { ...operation.target };
  const request: ReconciliationReadRequest = {
    installationId: operation.installationId,
    target,
    expectation: { ...operation.expectation },
  };
  try {
    switch (operation.kind) {
      case "merge_queue_enqueue": {
        const observation = await reader.observeMergeQueue(request);
        if (!matchesExactOperation(operation, observation)) {
          return ambiguous("Merge queue readback did not exactly match the journaled operation.");
        }
        // GitHub can remove an entry after a successful enqueue for reasons
        // unrelated to this operation (conflict, failed check, an operator
        // action, etc.). Absence therefore cannot prove the original write
        // did not happen; preserve the ambiguity and never re-enqueue.
        return observation.state === "queued"
          ? { state: "observed_applied", evidence: "Exact merge queue state was observed as queued." }
          : ambiguous("Merge queue entry is absent or its state is not provably exact.");
      }
      case "direct_merge": {
        const observation = await reader.observeDirectMerge(request);
        if (!matchesExactOperation(operation, observation)) {
          return ambiguous("Direct merge readback did not exactly match the journaled operation.");
        }
        return resolveObservation(
          observation.state,
          "merged",
          "not_merged",
          "Exact merge state was observed as merged.",
          "Exact merge state was observed as not merged.",
        );
      }
      case "check_run_publish": {
        const observation = await reader.observeCheckRun(request);
        if (!matchesExactOperation(operation, observation)) {
          return ambiguous("Check Run readback did not exactly match the journaled operation.");
        }
        if (observation.state === "published") {
          return {
            state: "observed_applied",
            evidence: "Exact Check Run state was observed as published.",
            ...(observation.checkRunId !== undefined ? { checkRunId: observation.checkRunId } : {}),
          };
        }
        if (observation.state === "completed_other") {
          return {
            state: "observed_not_applied",
            evidence: "Exact Check Run completed with a different conclusion.",
            ...(observation.checkRunId !== undefined ? { checkRunId: observation.checkRunId } : {}),
          };
        }
        if (observation.state === "in_progress" && observation.checkRunId !== undefined) {
          return {
            state: "check_run_in_progress",
            checkRunId: observation.checkRunId,
            evidence: "Exact Check Run remains in progress.",
          };
        }
        return ambiguous("Exact Check Run state remains unknown.");
      }
    }
  } catch {
    return ambiguous("Read-only reconciliation observation was unavailable.");
  }
}

function matchesExactOperation(
  operation: ExternalOperation,
  observation:
    | MergeQueueObservation
    | DirectMergeObservation
    | CheckRunObservation,
): boolean {
  return (
    operation.kind === observation.kind &&
    operation.target.repository === observation.target.repository &&
    operation.target.pullRequest === observation.target.pullRequest &&
    operation.target.expectedHeadSha === observation.target.expectedHeadSha &&
    operation.target.checkName === observation.target.checkName &&
    operation.expectation.pullRequestNodeId === observation.expectation.pullRequestNodeId &&
    operation.expectation.queueEntryId === observation.expectation.queueEntryId &&
    operation.expectation.checkRunId === observation.expectation.checkRunId &&
    operation.expectation.checkRunExternalId === observation.expectation.checkRunExternalId &&
    operation.expectation.expectedCheckConclusion === observation.expectation.expectedCheckConclusion
  );
}

function resolveObservation(
  state: string,
  applied: string,
  notApplied: string,
  appliedEvidence: string,
  notAppliedEvidence: string,
): ReconciliationResolution {
  if (state === applied) {
    return { state: "observed_applied", evidence: appliedEvidence };
  }
  if (state === notApplied) {
    return { state: "observed_not_applied", evidence: notAppliedEvidence };
  }
  return ambiguous("Exact external operation state remains unknown.");
}

function ambiguous(evidence: string): ReconciliationResolution {
  return { state: "ambiguous", evidence, retryAfterMs: 30_000 };
}
