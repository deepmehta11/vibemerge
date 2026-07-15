import { createRuntime } from "./runtime.js";
import { ReconciliationWorkerPool } from "./reconciliation-pool.js";
import { WebhookWorkerPool, workerConcurrency } from "./worker-pool.js";
import { redactSensitiveText } from "./agent-planner.js";

function safeWorkerDetail(detail: string | undefined): string | null {
  return detail ? redactSensitiveText(detail).replace(/\s+/g, " ").slice(0, 1_000) : null;
}

const runtime = createRuntime();
const concurrency = workerConcurrency(process.env.MERGEPROOF_WORKER_CONCURRENCY);
const pool = new WebhookWorkerPool(
  runtime.worker,
  concurrency,
  (outcome) =>
    console.info(
      JSON.stringify({
        service: "mergeproof",
        event: "webhook_processed",
        deliveryId: outcome.deliveryId ?? null,
        state: outcome.state,
        detail: safeWorkerDetail(outcome.detail),
      }),
    ),
  (error) => console.error("[mergeproof] worker failure", error instanceof Error ? error.message : error),
);

runtime.server.listen(runtime.port, "0.0.0.0", () => {
  console.info(
    JSON.stringify({
      service: "mergeproof",
      event: "listening",
      port: runtime.port,
      workerConcurrency: concurrency,
      readinessEndpoint: "/readyz",
      healthEndpoint: "/healthz",
    }),
  );
});
const interval = setInterval(() => pool.poll(), 1_000);
pool.poll();

const reconciliationPool = new ReconciliationWorkerPool(
  runtime.reconcilers,
  (outcome) =>
    console.info(JSON.stringify({
      service: "mergeproof",
      event: "external_operation_reconciled",
      operationId: outcome.operationId ?? null,
      state: outcome.state,
    })),
  (error) =>
    console.error(
      "[mergeproof] reconciliation failure",
      error instanceof Error ? error.name : "unknown",
    ),
);
const reconciliationInterval = setInterval(() => reconciliationPool.poll(), 5_000);
reconciliationPool.poll();

let shutdownPromise: Promise<void> | undefined;

async function shutdown(signal: string): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  runtime.setReady(false);
  clearInterval(interval);
  clearInterval(reconciliationInterval);
  shutdownPromise = (async () => {
    console.info(JSON.stringify({ service: "mergeproof", event: "draining", signal }));
    try {
      await new Promise<void>((resolve, reject) =>
        runtime.server.close((error) => (error ? reject(error) : resolve())),
      );
      await pool.stop();
      await reconciliationPool.stop();
    } finally {
      runtime.ledger.close();
    }
  })();
  return shutdownPromise;
}

function requestShutdown(signal: string, code: number): void {
  void shutdown(signal)
    .then(() => process.exit(code))
    .catch((error) => {
      console.error("[mergeproof] shutdown failure", error instanceof Error ? error.name : "unknown");
      process.exit(1);
    });
}

process.once("SIGINT", () => requestShutdown("SIGINT", 0));
process.once("SIGTERM", () => requestShutdown("SIGTERM", 0));
process.once("uncaughtException", (error) => {
  console.error("[mergeproof] uncaught exception", error.name);
  requestShutdown("uncaughtException", 1);
});
process.once("unhandledRejection", () => {
  console.error("[mergeproof] unhandled rejection");
  requestShutdown("unhandledRejection", 1);
});
