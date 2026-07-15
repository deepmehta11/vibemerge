export interface QueueWorkerResult {
  state: "idle" | "processed" | "retried" | "failed";
  deliveryId?: string;
  detail?: string;
}

export interface QueueWorker {
  processNext(): Promise<QueueWorkerResult>;
}

/**
 * Keeps a bounded number of expensive verification jobs active. The ledger
 * remains the cross-worker arbiter; this class only prevents one Node process
 * from serializing an entire webhook backlog behind one E2B run.
 */
export class WebhookWorkerPool {
  private active = 0;
  private stopped = false;
  private readonly idleWaiters = new Set<() => void>();

  constructor(
    private readonly worker: QueueWorker,
    private readonly concurrency: number,
    private readonly onResult: (result: QueueWorkerResult) => void = () => undefined,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {
    if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) {
      throw new Error("Worker concurrency must be an integer from 1 through 32.");
    }
  }

  poll(): void {
    if (!this.stopped) {
      this.fill();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.active === 0) {
      return;
    }
    await new Promise<void>((resolve) => this.idleWaiters.add(resolve));
  }

  private fill(): void {
    while (!this.stopped && this.active < this.concurrency) {
      this.active += 1;
      void this.runOne();
    }
  }

  private async runOne(): Promise<void> {
    let result: QueueWorkerResult | undefined;
    try {
      result = await this.worker.processNext();
      if (result.state !== "idle") {
        this.onResult(result);
      }
    } catch (error) {
      this.onError(error);
    } finally {
      this.active -= 1;
      if (!this.stopped && result?.state !== "idle") {
        this.fill();
      }
      if (this.active === 0) {
        for (const resolve of this.idleWaiters) {
          resolve();
        }
        this.idleWaiters.clear();
      }
    }
  }
}

export function workerConcurrency(value: string | undefined): number {
  if (value === undefined || value === "") {
    return 2;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 32) {
    throw new Error("MERGEPROOF_WORKER_CONCURRENCY must be an integer from 1 through 32.");
  }
  return parsed;
}
