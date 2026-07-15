import type { CheckRunFailureCloser } from "./check-run.js";
import type { ReconciliationLease, RunLedger } from "./ledger.js";
import {
  resolveExternalOperationReadOnly,
  type ReadOnlyReconciliationReader,
} from "./reconciliation-resolver.js";

export interface ReconciliationWorkerResult {
  state: "idle" | "observed_applied" | "observed_not_applied" | "ambiguous" | "failed_closed";
  operationId?: string;
}

export interface ReconciliationWorkerOptions {
  /** Test-only override; production renews at one third of the lease. */
  heartbeatMs?: number;
}

/**
 * Keeps an externally slow read or failure-only Check Run close fenced to the
 * slot that claimed it. If ownership is lost, no local finalizer runs; a
 * future owner must read the exact external state again.
 */
class ReconciliationLeaseHeartbeat {
  private timer: NodeJS.Timeout | undefined;
  private failure: unknown;

  constructor(
    private readonly ledger: RunLedger,
    private readonly lease: ReconciliationLease,
    private readonly leaseMs: number,
    private readonly now: () => number,
    private readonly heartbeatMs: number,
  ) {}

  start(): void {
    this.assertOwned();
    this.timer = setInterval(() => this.heartbeat(), this.heartbeatMs);
    // A reconciliation heartbeat is not a reason to keep a draining Node
    // process alive. Active work is awaited explicitly by the worker pool.
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  assertOwned(): void {
    if (this.failure) {
      throw this.failure;
    }
    try {
      this.ledger.renewReconciliationLease(this.lease, this.leaseMs, this.now());
    } catch (error) {
      this.failure = error;
      throw error;
    }
  }

  async around<T>(action: () => Promise<T>): Promise<T> {
    this.assertOwned();
    try {
      return await action();
    } finally {
      // If ownership changed while GitHub was slow, the caller must not make
      // a reconciliation decision from that observation or write result.
      this.assertOwned();
    }
  }

  private heartbeat(): void {
    if (this.failure) {
      return;
    }
    try {
      this.ledger.renewReconciliationLease(this.lease, this.leaseMs, this.now());
    } catch (error) {
      this.failure = error;
    }
  }
}

/**
 * Bounded recovery worker. It normally has a read-only GitHub surface. The
 * one explicit exception is an exact Check Run left in_progress after its
 * publisher lease expires: a dedicated closer may only turn that one Check
 * Run into failure. It never retries a merge or re-enqueues a PR.
 */
export class ReconciliationWorker {
  private readonly heartbeatMs: number;

  constructor(
    private readonly ledger: RunLedger,
    private readonly reader: ReadOnlyReconciliationReader,
    readonly workerId: string,
    private readonly now: () => number = () => Date.now(),
    private readonly leaseMs = 2 * 60_000,
    private readonly interruptedCheckRunCloser?: CheckRunFailureCloser,
    options: ReconciliationWorkerOptions = {},
  ) {
    const heartbeatMs = options.heartbeatMs ?? Math.max(1_000, Math.floor(leaseMs / 3));
    if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= leaseMs) {
      throw new Error("Reconciliation heartbeat must be a positive integer shorter than its lease.");
    }
    this.heartbeatMs = heartbeatMs;
  }

  async processNext(): Promise<ReconciliationWorkerResult> {
    const candidate = this.ledger.claimReconciliationCandidate(
      this.workerId,
      this.leaseMs,
      this.now(),
    );
    if (!candidate) {
      return { state: "idle" };
    }
    const heartbeat = new ReconciliationLeaseHeartbeat(
      this.ledger,
      candidate.lease,
      this.leaseMs,
      this.now,
      this.heartbeatMs,
    );
    heartbeat.start();
    try {
      const resolve = (state: Parameters<RunLedger["resolveReconciliationCandidate"]>[1]) => {
        heartbeat.assertOwned();
        return this.ledger.resolveReconciliationCandidate(candidate.lease, state, this.now());
      };
      const resolution = await heartbeat.around(() =>
        resolveExternalOperationReadOnly(candidate.operation, this.reader),
      );
      if (candidate.operation.kind === "check_run_publish") {
        heartbeat.assertOwned();
        const recoveryState = this.ledger.checkRunRecoveryState(candidate.lease, this.now());
        if (recoveryState === "active") {
          const persisted = resolve(
            {
              state: "ambiguous",
              evidence: "Exact Check Run is waiting for its original publisher lease to expire.",
              retryAfterMs: 30_000,
            },
          );
          return { state: "ambiguous", operationId: persisted.operationId };
        }
        if (recoveryState === "eligible" && resolution.state === "check_run_in_progress") {
          if (!this.interruptedCheckRunCloser) {
            const persisted = resolve(
              {
                state: "ambiguous",
                evidence: "Exact interrupted Check Run needs a failure-only recovery capability.",
                retryAfterMs: 30_000,
              },
            );
            return { state: "ambiguous", operationId: persisted.operationId };
          }
          try {
            await heartbeat.around(() =>
              this.interruptedCheckRunCloser!.completeAsFailure({
                operation: candidate.operation,
                checkRunId: resolution.checkRunId,
              }),
            );
          } catch {
            const persisted = resolve(
              {
                state: "ambiguous",
                evidence: "Exact interrupted Check Run failure recovery was unavailable.",
                retryAfterMs: 30_000,
              },
            );
            return { state: "ambiguous", operationId: persisted.operationId };
          }
          const expectedFailure = candidate.operation.expectation.expectedCheckConclusion === "failure";
          heartbeat.assertOwned();
          const persisted = this.ledger.finalizeReconciledCheckRun(
            candidate.lease,
            {
              checkRunId: resolution.checkRunId,
              operationState: expectedFailure ? "observed_applied" : "observed_not_applied",
              outcome: "NOT_ELIGIBLE",
              evidence: "Interrupted exact Check Run was completed as failure after its publisher lease expired.",
            },
            this.now(),
          );
          return { state: "failed_closed", operationId: persisted.operationId };
        }
        if (
          recoveryState === "eligible" &&
          (resolution.state === "observed_applied" || resolution.state === "observed_not_applied")
        ) {
          const expectedSuccess = candidate.operation.expectation.expectedCheckConclusion === "success";
          heartbeat.assertOwned();
          const persisted = this.ledger.finalizeReconciledCheckRun(
            candidate.lease,
            {
              ...(resolution.checkRunId !== undefined ? { checkRunId: resolution.checkRunId } : {}),
              operationState: resolution.state,
              outcome: resolution.state === "observed_applied" && expectedSuccess ? "READY" : "NOT_ELIGIBLE",
              evidence: resolution.evidence,
            },
            this.now(),
          );
          return { state: resolution.state, operationId: persisted.operationId };
        }
        if (resolution.state === "check_run_in_progress") {
          const persisted = resolve(
            {
              state: "ambiguous",
              evidence: "Exact Check Run is still in progress after its run reached a terminal state.",
              retryAfterMs: 30_000,
            },
          );
          return { state: "ambiguous", operationId: persisted.operationId };
        }
      }
      if (
        candidate.operation.kind === "merge_queue_enqueue" ||
        candidate.operation.kind === "direct_merge"
      ) {
        heartbeat.assertOwned();
        const recoveryState = this.ledger.externalOperationRecoveryState(candidate.lease, this.now());
        if (recoveryState === "active") {
          const persisted = resolve(
            {
              state: "ambiguous",
              evidence: "Exact external operation is waiting for its original publisher lease to expire.",
              retryAfterMs: 30_000,
            },
          );
          return { state: "ambiguous", operationId: persisted.operationId };
        }
        if (
          recoveryState === "eligible" &&
          (resolution.state === "observed_applied" || resolution.state === "observed_not_applied")
        ) {
          heartbeat.assertOwned();
          const persisted = this.ledger.finalizeReconciledExternalOperation(
            candidate.lease,
            {
              operationState: resolution.state,
              evidence: resolution.evidence,
            },
            this.now(),
          );
          return { state: resolution.state, operationId: persisted.operationId };
        }
      }
      if (resolution.state === "check_run_in_progress") {
        throw new Error("Only a Check Run publication may report an in-progress Check Run.");
      }
      const persisted = resolve(resolution);
      return { state: resolution.state, operationId: persisted.operationId };
    } finally {
      heartbeat.stop();
    }
  }
}
