import type { ReconciliationWorkerResult } from "./reconciliation-worker.js";

/** One independently fenced reconciliation slot. */
export interface ReconciliationProcessor {
  /** Must stay stable and unique for the process lifetime. */
  readonly workerId: string;
  processNext(): Promise<ReconciliationWorkerResult>;
}

/**
 * Bounds concurrent readback/recovery work without ever sharing a
 * reconciliation lease owner between slots. The ledger still decides which
 * operation each slot may own; this pool only manages one Node process.
 */
export class ReconciliationWorkerPool {
  private readonly activeSlots = new Set<number>();
  private readonly idleWaiters = new Set<() => void>();
  private stopped = false;

  constructor(
    private readonly workers: readonly ReconciliationProcessor[],
    private readonly onResult: (result: ReconciliationWorkerResult) => void = () => undefined,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    if (workers.length < 1 || workers.length > 16) {
      throw new Error("Reconciliation concurrency must be an integer from 1 through 16.");
    }
    const workerIds = workers.map((worker) => worker.workerId);
    if (workerIds.some((workerId) => !workerId) || new Set(workerIds).size !== workerIds.length) {
      throw new Error("Every reconciliation slot must use a unique worker id.");
    }
  }

  /** Starts every idle slot. Repeated calls are safe while work is active. */
  poll(): void {
    if (!this.stopped) {
      this.fill();
    }
  }

  /** Stops admitting new reads and waits for every already-owned lease to settle. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.activeSlots.size === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private fill(): void {
    for (let slot = 0; slot < this.workers.length; slot += 1) {
      if (this.stopped || this.activeSlots.has(slot)) {
        continue;
      }
      this.activeSlots.add(slot);
      void this.runSlot(slot);
    }
  }

  private async runSlot(slot: number): Promise<void> {
    let result: ReconciliationWorkerResult | undefined;
    try {
      result = await this.workers[slot]!.processNext();
      if (result.state !== "idle") {
        this.onResult(result);
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.activeSlots.delete(slot);
      // Continue draining only after a real operation. An idle read means the
      // slot saw no currently eligible journal row; the periodic poll will
      // wake it after a delayed ambiguous retry becomes eligible.
      if (!this.stopped && result?.state !== "idle") {
        this.fill();
      }
      if (this.activeSlots.size === 0) {
        for (const resolve of this.idleWaiters) {
          resolve();
        }
        this.idleWaiters.clear();
      }
    }
  }
}

/** Parsed in createRuntime too, so config:check rejects bad deployment values. */
export function reconciliationConcurrency(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 2;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 16) {
    throw new Error("MERGEPROOF_RECONCILIATION_CONCURRENCY must be an integer from 1 through 16.");
  }
  return parsed;
}
