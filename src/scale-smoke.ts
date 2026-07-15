import { RunLedger } from "./ledger.js";

const defaultEvents = 1_000;
const defaultRepositories = 10;
const defaultWorkers = 32;

function boundedInteger(value: string | undefined, fallback: number, name: string, maximum: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}.`);
  }
  return parsed;
}

/**
 * Deterministic per-replica capacity drill. It intentionally exercises only
 * the durable webhook queue, lease fencing, completion, and repository-fair
 * scheduler. It does not contact GitHub or E2B, so it cannot be mistaken for
 * a live 1,000-PR verification benchmark.
 */
const events = boundedInteger(process.env.MERGEPROOF_SCALE_EVENTS, defaultEvents, "MERGEPROOF_SCALE_EVENTS", 10_000);
const repositories = boundedInteger(
  process.env.MERGEPROOF_SCALE_REPOSITORIES,
  defaultRepositories,
  "MERGEPROOF_SCALE_REPOSITORIES",
  events,
);
const workers = boundedInteger(
  process.env.MERGEPROOF_SCALE_WORKERS,
  defaultWorkers,
  "MERGEPROOF_SCALE_WORKERS",
  32,
);
const body = (repository: string) => JSON.stringify({ repository: { full_name: repository } });
const bytesPerEvent = Buffer.byteLength(body("acme/scale-0000"), "utf8");
const ledger = new RunLedger(":memory:", events, events * bytesPerEvent + 1);
const claimed = new Set<string>();
const startedAt = Date.now();

try {
  for (let event = 0; event < events; event += 1) {
    const repository = `acme/scale-${String(event % repositories).padStart(4, "0")}`;
    const accepted = ledger.enqueueWebhook(`scale-${event}`, "pull_request", body(repository), startedAt);
    if (accepted !== true) {
      throw new Error(`Scale event ${event} was not accepted: ${accepted}.`);
    }
  }

  for (let event = 0; event < events; event += 1) {
    const job = ledger.claimWebhook(`scale-worker:${event % workers}`, 60_000, startedAt + event);
    if (!job || claimed.has(job.deliveryId)) {
      throw new Error(`Scale event ${event} was not uniquely claimed.`);
    }
    claimed.add(job.deliveryId);
    ledger.completeWebhook(job.lease, startedAt + event);
  }

  const stats = ledger.operatorStats();
  if (claimed.size !== events || stats.inbox.queued !== 0 || stats.inbox.running !== 0 || stats.inbox.completed !== events) {
    throw new Error("Scale drill did not drain exactly the accepted webhook set.");
  }
  console.log(JSON.stringify({
    service: "mergeproof",
    event: "single_replica_inbox_scale_verified",
    acceptedEvents: events,
    completedEvents: stats.inbox.completed,
    repositories,
    workers,
    elapsedMs: Date.now() - startedAt,
    scope: "durable inbox, lease fencing, and fair scheduling only; no GitHub or E2B calls",
  }));
} finally {
  ledger.close();
}
