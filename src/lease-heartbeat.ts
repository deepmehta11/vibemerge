/**
 * Keeps a durable lease alive while a bounded-but-slow external operation is
 * in flight. A failed renewal is remembered and surfaced before the holder
 * can commit a state transition or a merge-enabling side effect.
 */
export interface LeaseHeartbeat {
  assertHealthy(): void;
  stop(): void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown lease renewal failure.";
}

export function heartbeatInterval(leaseMs: number): number {
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 3_000) {
    throw new Error("Lease duration must be an integer of at least 3000 milliseconds.");
  }
  // Renew well before expiry but do not create a high-frequency database poll.
  return Math.max(1_000, Math.floor(leaseMs / 3));
}

export function startLeaseHeartbeat(
  label: string,
  renew: () => void,
  leaseMs: number,
): LeaseHeartbeat {
  let failure: string | undefined;
  const timer = setInterval(() => {
    if (failure) {
      return;
    }
    try {
      renew();
    } catch (error) {
      failure = errorMessage(error);
    }
  }, heartbeatInterval(leaseMs));
  // A heartbeat must not keep a process alive after its HTTP server and worker
  // pool have shut down.
  timer.unref();

  return {
    assertHealthy(): void {
      if (failure) {
        throw new Error(`${label} lease renewal failed; abandoning the work: ${failure}`);
      }
    },
    stop(): void {
      clearInterval(timer);
    },
  };
}
