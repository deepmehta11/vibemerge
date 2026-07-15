import { DatabaseSync } from "node:sqlite";

import { revisionRunKey } from "./crypto.js";
import type {
  EvidenceReceipt,
  MergeAttempt,
  MergeOutcome,
  PinnedRevision,
} from "./domain.js";

const CHECK_RUN_CONCLUSIONS = new Set<CheckRunConclusion>([
  "success",
  "failure",
  "neutral",
  "cancelled",
  "skipped",
  "timed_out",
  "action_required",
]);

export type RunStatus =
  | "running"
  | "verified"
  | "publishing"
  | "queued"
  | "reported"
  | "stale"
  | "merging"
  | "merged"
  | "merge_failed"
  | "merge_unknown";

export interface RunLease {
  runKey: string;
  workerId: string;
  fenceToken: number;
  expiresAt: number;
}

export type ClaimResult =
  | { state: "claimed"; lease: RunLease }
  | { state: "busy"; retryAt: number }
  | { state: "completed" }
  | { state: "reconciliation_required" };

export interface LedgerRun {
  runKey: string;
  status: RunStatus;
  outcome: MergeOutcome | null;
  decision: RunDecision | null;
  fenceToken: number;
  receipt: EvidenceReceipt | null;
  updatedAt: number;
}

export interface RunDecision {
  stage: "evidence" | "live_policy" | "publication" | "merge";
  state:
    | "eligible"
    | "not_eligible"
    | "queued"
    | "reported"
    | "stale"
    | "reconciliation_required"
    | "merged"
    | "merge_failed";
  outcome: MergeOutcome;
  reason: string;
  decidedAt: string;
}

export interface RunListCursor {
  updatedAt: number;
  runKey: string;
}

export interface RunListPage {
  runs: LedgerRun[];
  nextCursor?: RunListCursor;
}

export interface OperatorLedgerStats {
  runs: Record<RunStatus, number>;
  inbox: {
    queued: number;
    running: number;
    completed: number;
    failed: number;
    deadLetter: number;
    pendingBytes: number;
    maxPendingEvents: number;
    maxPendingBytes: number;
  };
}

/**
 * A durable, fail-closed operator control. It is separate from policy so an
 * emergency stop survives process restarts without silently changing policy.
 */
export interface AutomationControl {
  paused: boolean;
  updatedAt: number;
}

export type WebhookEventStatus = "queued" | "running" | "completed" | "dead_letter" | "failed";

export interface WebhookLease {
  deliveryId: string;
  workerId: string;
  fenceToken: number;
  expiresAt: number;
}

export interface WebhookJob {
  deliveryId: string;
  eventName: string;
  body: string;
  attempt: number;
  lease: WebhookLease;
}

export interface WebhookEventMetadata {
  status: WebhookEventStatus;
  bodyRetained: boolean;
  bodyBytes: number;
  attemptCount: number;
  deadLetterReplayCount: number;
}

/**
 * A narrow, durable description of an outbound GitHub write.  It deliberately
 * contains only the exact identity needed to read the result back later—never
 * a token, body, command, or arbitrary request payload.
 */
export type ExternalOperationKind =
  | "merge_queue_enqueue"
  | "direct_merge"
  | "check_run_publish";

export interface ExternalOperationTarget {
  repository: string;
  pullRequest: number;
  expectedHeadSha: string;
  /** Required only for a Check Run publication. */
  checkName?: string;
}

export interface ExternalOperationIntent {
  /** Stable caller-generated idempotency key for precisely one external write. */
  operationId: string;
  kind: ExternalOperationKind;
  /** GitHub App installation used to mint a scoped read token during recovery. */
  installationId: number;
  target: ExternalOperationTarget;
  /**
   * Safe IDs and deterministic expectations used to distinguish this write
   * from another PR operation with the same human-readable check name.
   */
  expectation: ExternalOperationExpectation;
}

export type CheckRunConclusion =
  | "success"
  | "failure"
  | "neutral"
  | "cancelled"
  | "skipped"
  | "timed_out"
  | "action_required";

export interface ExternalOperationExpectation {
  /** Known before enqueue/merge when the GitHub PR node has been read. */
  pullRequestNodeId?: string;
  /** Known when resuming a specific merge-queue entry. */
  queueEntryId?: string;
  /** Known when updating an existing Check Run. */
  checkRunId?: number;
  /** Deterministic external id set on newly created Check Runs. */
  checkRunExternalId?: string;
  /** Required for Check Run publication; ignored by non-Check-Run operations. */
  expectedCheckConclusion?: CheckRunConclusion;
}

export type ExternalOperationState =
  | "intent_recorded"
  | "ambiguous"
  | "observed_applied"
  | "observed_not_applied";

export interface ExternalOperation {
  operationId: string;
  runKey: string;
  kind: ExternalOperationKind;
  installationId: number;
  target: ExternalOperationTarget;
  expectation: ExternalOperationExpectation;
  state: ExternalOperationState;
  intentFenceToken: number;
  reconciliationFenceToken: number;
  createdAt: number;
  updatedAt: number;
  resolvedAt: number | null;
  /** Controller-generated, bounded explanation—not raw provider output. */
  evidence: string | null;
}

/**
 * A caller may perform the write only for `prepared`.  `already_recorded`
 * means a prior process may have crossed the external side-effect boundary,
 * so the only safe next step is read-only reconciliation.
 */
export type ExternalOperationPreparation =
  | { state: "prepared"; operation: ExternalOperation }
  | { state: "already_recorded"; operation: ExternalOperation };

export interface ReconciliationLease {
  operationId: string;
  workerId: string;
  fenceToken: number;
  expiresAt: number;
}

export interface ReconciliationCandidate {
  operation: ExternalOperation;
  lease: ReconciliationLease;
}

/**
 * A Check Run remains owned by its original publisher until that publisher's
 * run lease expires. Only then may a recovery worker settle it.
 */
export type CheckRunRecoveryState = "active" | "eligible" | "terminal";

/**
 * A merge-queue or direct-fixture write remains owned by its original
 * publisher until that publisher's run lease expires. Read-only observation
 * may prove its outcome, but only an expired publisher lease permits a
 * reconciler to advance the run itself.
 */
export type ExternalOperationRecoveryState = "active" | "eligible" | "terminal";

/**
 * A resolution is the outcome of a read-only observation.  It cannot express
 * an instruction to retry or replay the original write.
 */
export type ReconciliationResolution =
  | { state: "observed_applied"; evidence: string; checkRunId?: number }
  | { state: "observed_not_applied"; evidence: string; checkRunId?: number }
  | { state: "ambiguous"; evidence: string; retryAfterMs?: number }
  /** Intercepted by ReconciliationWorker; never persisted directly. */
  | { state: "check_run_in_progress"; evidence: string; checkRunId: number };

type RunRow = {
  run_key: string;
  status: RunStatus;
  outcome: MergeOutcome | null;
  fence_token: number;
  lease_owner: string | null;
  lease_until: number | null;
  receipt_json: string | null;
  decision_json: string | null;
  updated_at: number;
};

type WebhookRow = {
  delivery_id: string;
  event_name: string;
  body: string;
  repository_key: string;
  status: WebhookEventStatus;
  attempt_count: number;
  dead_letter_replay_count: number;
  fence_token: number;
  lease_owner: string | null;
  lease_until: number | null;
  available_at: number;
  body_bytes: number;
};

type ExternalOperationRow = {
  operation_id: string;
  run_key: string;
  kind: ExternalOperationKind;
  installation_id: number;
  repository: string;
  pull_request: number;
  expected_head_sha: string;
  check_name: string | null;
  pull_request_node_id: string | null;
  queue_entry_id: string | null;
  check_run_id: number | null;
  check_run_external_id: string | null;
  expected_check_conclusion: CheckRunConclusion | null;
  state: ExternalOperationState;
  intent_fence_token: number;
  reconciliation_fence_token: number;
  reconciliation_lease_owner: string | null;
  reconciliation_lease_until: number | null;
  next_reconcile_at: number;
  evidence: string | null;
  created_at: number;
  resolved_at: number | null;
  updated_at: number;
};

type SqlInputValue = string | number | bigint | null | NodeJS.ArrayBufferView;

/**
 * The raw body is already signature-verified before it reaches the ledger.
 * This bounded key is only a scheduling hint; controller decisions always
 * reload signed live GitHub state and never trust the retained webhook body.
 */
function repositorySchedulingKey(body: string, deliveryId: string): string {
  try {
    const parsed = JSON.parse(body) as { repository?: { full_name?: unknown } };
    const repository = parsed.repository?.full_name;
    if (typeof repository === "string" && /^[^/\s]{1,128}\/[^/\s]{1,128}$/.test(repository)) {
      return repository.toLowerCase();
    }
  } catch {
    // A malformed body is retained for the worker to fail durably. It must not
    // share a scheduler lane with arbitrary valid repositories in the meantime.
  }
  return `delivery:${deliveryId}`;
}

function runFromRow(row: RunRow): LedgerRun {
  return {
    runKey: row.run_key,
    status: row.status,
    outcome: row.outcome,
    decision: row.decision_json ? (JSON.parse(row.decision_json) as RunDecision) : null,
    fenceToken: row.fence_token,
    receipt: row.receipt_json ? (JSON.parse(row.receipt_json) as EvidenceReceipt) : null,
    updatedAt: row.updated_at,
  };
}

function externalOperationFromRow(row: ExternalOperationRow): ExternalOperation {
  return {
    operationId: row.operation_id,
    runKey: row.run_key,
    kind: row.kind,
    installationId: row.installation_id,
    target: {
      repository: row.repository,
      pullRequest: row.pull_request,
      expectedHeadSha: row.expected_head_sha,
      ...(row.check_name ? { checkName: row.check_name } : {}),
    },
    expectation: {
      ...(row.pull_request_node_id ? { pullRequestNodeId: row.pull_request_node_id } : {}),
      ...(row.queue_entry_id ? { queueEntryId: row.queue_entry_id } : {}),
      ...(row.check_run_id !== null ? { checkRunId: row.check_run_id } : {}),
      ...(row.check_run_external_id ? { checkRunExternalId: row.check_run_external_id } : {}),
      ...(row.expected_check_conclusion
        ? { expectedCheckConclusion: row.expected_check_conclusion }
        : {}),
    },
    state: row.state,
    intentFenceToken: row.intent_fence_token,
    reconciliationFenceToken: row.reconciliation_fence_token,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    evidence: row.evidence,
  };
}

/**
 * Local durable ledger. In production this same interface belongs behind a
 * managed transactional database; the fencing semantics are the important bit.
 */
export class RunLedger {
  private readonly database: DatabaseSync;

  constructor(
    path = ":memory:",
    private readonly maxPendingWebhookEvents = 10_000,
    private readonly maxPendingWebhookBytes = 256 * 1024 * 1024,
  ) {
    if (!Number.isInteger(maxPendingWebhookEvents) || maxPendingWebhookEvents < 1) {
      throw new Error("maxPendingWebhookEvents must be a positive integer.");
    }
    if (!Number.isSafeInteger(maxPendingWebhookBytes) || maxPendingWebhookBytes < 1) {
      throw new Error("maxPendingWebhookBytes must be a positive integer.");
    }
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_key TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        outcome TEXT,
        fence_token INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        receipt_json TEXT,
        decision_json TEXT,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS deliveries (
        delivery_id TEXT PRIMARY KEY,
        received_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS merge_attempts (
        attempt_id TEXT PRIMARY KEY,
        run_key TEXT NOT NULL,
        expected_head_sha TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at TEXT NOT NULL,
        message TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS external_operations (
        operation_id TEXT PRIMARY KEY,
        run_key TEXT NOT NULL,
        kind TEXT NOT NULL,
        installation_id INTEGER NOT NULL,
        repository TEXT NOT NULL,
        pull_request INTEGER NOT NULL,
        expected_head_sha TEXT NOT NULL,
        check_name TEXT,
        pull_request_node_id TEXT,
        queue_entry_id TEXT,
        check_run_id INTEGER,
        check_run_external_id TEXT,
        expected_check_conclusion TEXT,
        state TEXT NOT NULL,
        intent_fence_token INTEGER NOT NULL,
        reconciliation_fence_token INTEGER NOT NULL,
        reconciliation_lease_owner TEXT,
        reconciliation_lease_until INTEGER,
        next_reconcile_at INTEGER NOT NULL,
        evidence TEXT,
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS webhook_events (
        delivery_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        body TEXT NOT NULL,
        repository_key TEXT NOT NULL,
        body_bytes INTEGER NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL,
        dead_letter_replay_count INTEGER NOT NULL DEFAULT 0,
        fence_token INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        last_error TEXT,
        received_at INTEGER NOT NULL,
        available_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS repository_schedule (
        repository_key TEXT PRIMARY KEY,
        last_claim_sequence INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS automation_control (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        paused INTEGER NOT NULL CHECK (paused IN (0, 1)),
        updated_at INTEGER NOT NULL
      ) STRICT;
      INSERT OR IGNORE INTO automation_control (id, paused, updated_at)
        VALUES (1, 0, 0);
    `);
    this.migrateWebhookAvailability();
    this.migrateRunDecision();
    this.migrateWebhookBodyBytes();
    this.migrateWebhookRepositoryKey();
    this.migrateWebhookDeadLetter();
    this.migrateExternalOperationExpectations();
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS idx_runs_updated ON runs(updated_at DESC, run_key DESC);
      CREATE INDEX IF NOT EXISTS idx_webhook_events_pending ON webhook_events(status, available_at, received_at);
      CREATE INDEX IF NOT EXISTS idx_webhook_events_fair_pending ON webhook_events(repository_key, status, available_at, received_at);
      CREATE INDEX IF NOT EXISTS idx_repository_schedule_fair ON repository_schedule(last_claim_sequence, repository_key);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_external_operations_run_kind
        ON external_operations(run_key, kind);
      CREATE INDEX IF NOT EXISTS idx_external_operations_reconciliation
        ON external_operations(state, next_reconcile_at, created_at);
    `);
  }

  private transaction<T>(work: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = work();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK;");
      throw error;
    }
  }

  claim(
    revision: PinnedRevision,
    workerId: string,
    leaseMs: number,
    now = Date.now(),
  ): ClaimResult {
    const runKey = revisionRunKey(revision);
    return this.transaction(() => {
      const row = this.database
        .prepare("SELECT * FROM runs WHERE run_key = ?")
        .get(runKey) as RunRow | undefined;
      if (row?.status === "merged" || row?.status === "queued" || row?.status === "reported") {
        return { state: "completed" };
      }
      // A merge-side-effect may already be in flight (or have an unknown
      // outcome). Never allow a duplicate webhook to reset that state and
      // replay a potentially non-idempotent GitHub write.
      if (
        row?.status === "merge_unknown" ||
        row?.status === "publishing" ||
        row?.status === "merging"
      ) {
        return { state: "reconciliation_required" };
      }
      if (
        (row?.status === "running" || row?.status === "verified") &&
        row.lease_owner !== workerId &&
        row.lease_until !== null &&
        row.lease_until > now
      ) {
        return { state: "busy", retryAt: row.lease_until };
      }

      const fenceToken = (row?.fence_token ?? 0) + 1;
      const expiresAt = now + leaseMs;
      this.database
        .prepare(`
          INSERT INTO runs (run_key, status, outcome, fence_token, lease_owner, lease_until, updated_at)
          VALUES (?, 'running', NULL, ?, ?, ?, ?)
          ON CONFLICT(run_key) DO UPDATE SET
            status = 'running', outcome = NULL, receipt_json = NULL, decision_json = NULL,
            fence_token = excluded.fence_token,
            lease_owner = excluded.lease_owner, lease_until = excluded.lease_until,
            updated_at = excluded.updated_at
        `)
        .run(runKey, fenceToken, workerId, expiresAt, now);

      return {
        state: "claimed",
        lease: { runKey, workerId, fenceToken, expiresAt },
      };
    });
  }

  /**
   * Extends an active verification lease without changing its fencing token.
   * A caller that lost ownership is rejected rather than allowed to publish
   * evidence or a merge action after another worker takes over.
   */
  renewRunLease(lease: RunLease, leaseMs: number, now = Date.now()): RunLease {
    this.assertLeaseDuration(leaseMs);
    return this.transaction(() => {
      const current = this.database
        .prepare("SELECT * FROM runs WHERE run_key = ?")
        .get(lease.runKey) as RunRow | undefined;
      if (
        !current ||
        !["running", "verified", "publishing", "merging"].includes(current.status) ||
        current.lease_owner !== lease.workerId ||
        current.fence_token !== lease.fenceToken ||
        current.lease_until === null ||
        current.lease_until < now
      ) {
        throw new Error("Run lease is stale or owned by another worker.");
      }
      const expiresAt = Math.max(current.lease_until, now + leaseMs);
      this.database
        .prepare("UPDATE runs SET lease_until = ?, updated_at = ? WHERE run_key = ?")
        .run(expiresAt, now, lease.runKey);
      lease.expiresAt = expiresAt;
      return lease;
    });
  }

  registerDelivery(deliveryId: string, now = Date.now()): boolean {
    const result = this.database
      .prepare("INSERT OR IGNORE INTO deliveries (delivery_id, received_at) VALUES (?, ?)")
      .run(deliveryId, now);
    return result.changes === 1;
  }

  /** Atomically deduplicates and queues an authenticated raw webhook delivery. */
  enqueueWebhook(
    deliveryId: string,
    eventName: string,
    body: string,
    now = Date.now(),
  ): boolean | "inbox_full" {
    return this.transaction(() => {
      const bodyBytes = Buffer.byteLength(body, "utf8");
      const pending = this.database
        .prepare(`
          SELECT COUNT(*) AS count, COALESCE(SUM(body_bytes), 0) AS bytes
          FROM webhook_events
          WHERE status IN ('queued', 'running', 'dead_letter')
        `)
        .get() as { count: number | bigint; bytes: number | bigint };
      if (
        Number(pending.count) >= this.maxPendingWebhookEvents ||
        Number(pending.bytes) + bodyBytes > this.maxPendingWebhookBytes
      ) {
        return "inbox_full";
      }
      const inserted = this.database
        .prepare("INSERT OR IGNORE INTO deliveries (delivery_id, received_at) VALUES (?, ?)")
        .run(deliveryId, now);
      if (inserted.changes !== 1) {
        return false;
      }
      this.database
        .prepare(`
          INSERT INTO webhook_events (
            delivery_id, event_name, body, repository_key, body_bytes, status, attempt_count, fence_token,
            received_at, available_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'queued', 0, 0, ?, ?, ?)
        `)
        .run(
          deliveryId,
          eventName,
          body,
          repositorySchedulingKey(body, deliveryId),
          bodyBytes,
          now,
          now,
          now,
        );
      return true;
    });
  }

  claimWebhook(
    workerId: string,
    leaseMs: number,
    now = Date.now(),
  ): WebhookJob | null {
    return this.transaction(() => {
      const row = this.database
        .prepare(`
          WITH repository_heads AS (
            SELECT event.*
            FROM webhook_events AS event
            WHERE ((event.status = 'queued' AND event.available_at <= ?)
                OR (event.status = 'running' AND event.lease_until IS NOT NULL AND event.lease_until < ?)
                OR (event.status = 'dead_letter' AND event.available_at <= ? AND event.dead_letter_replay_count < 1))
              AND event.delivery_id = (
                SELECT peer.delivery_id
                FROM webhook_events AS peer
                WHERE peer.repository_key = event.repository_key
                  AND ((peer.status = 'queued' AND peer.available_at <= ?)
                    OR (peer.status = 'running' AND peer.lease_until IS NOT NULL AND peer.lease_until < ?)
                    OR (peer.status = 'dead_letter' AND peer.available_at <= ? AND peer.dead_letter_replay_count < 1))
                ORDER BY peer.available_at ASC, peer.received_at ASC, peer.delivery_id ASC
                LIMIT 1
              )
          )
          SELECT head.*
          FROM repository_heads AS head
          LEFT JOIN repository_schedule AS schedule
            ON schedule.repository_key = head.repository_key
          ORDER BY COALESCE(schedule.last_claim_sequence, 0) ASC,
                   head.available_at ASC, head.received_at ASC, head.delivery_id ASC
          LIMIT 1
        `)
        .get(now, now, now, now, now, now) as WebhookRow | undefined;
      if (!row) {
        return null;
      }
      const fenceToken = row.fence_token + 1;
      const expiresAt = now + leaseMs;
      const redrivingDeadLetter = row.status === "dead_letter";
      const attempt = redrivingDeadLetter ? 1 : row.attempt_count + 1;
      const deadLetterReplayCount = row.dead_letter_replay_count + (redrivingDeadLetter ? 1 : 0);
      const schedulingSequence = Number(
        (this.database
          .prepare("SELECT COALESCE(MAX(last_claim_sequence), 0) + 1 AS value FROM repository_schedule")
          .get() as { value: number | bigint }).value,
      );
      this.database
        .prepare(`
          INSERT INTO repository_schedule (repository_key, last_claim_sequence)
          VALUES (?, ?)
          ON CONFLICT(repository_key) DO UPDATE SET last_claim_sequence = excluded.last_claim_sequence
        `)
        .run(row.repository_key, schedulingSequence);
      this.database
        .prepare(`
          UPDATE webhook_events SET
            status = 'running', attempt_count = ?, fence_token = ?,
            dead_letter_replay_count = ?, lease_owner = ?, lease_until = ?, updated_at = ?, last_error = NULL
          WHERE delivery_id = ?
        `)
        .run(attempt, fenceToken, deadLetterReplayCount, workerId, expiresAt, now, row.delivery_id);
      return {
        deliveryId: row.delivery_id,
        eventName: row.event_name,
        body: row.body,
        attempt,
        lease: { deliveryId: row.delivery_id, workerId, fenceToken, expiresAt },
      };
    });
  }

  /** Extends ownership of an in-flight webhook without changing its fence. */
  renewWebhookLease(lease: WebhookLease, leaseMs: number, now = Date.now()): WebhookLease {
    this.assertLeaseDuration(leaseMs);
    return this.transaction(() => {
      const current = this.database
        .prepare("SELECT * FROM webhook_events WHERE delivery_id = ?")
        .get(lease.deliveryId) as WebhookRow | undefined;
      if (
        !current ||
        current.status !== "running" ||
        current.lease_owner !== lease.workerId ||
        current.fence_token !== lease.fenceToken ||
        current.lease_until === null ||
        current.lease_until < now
      ) {
        throw new Error("Webhook lease is stale or owned by another worker.");
      }
      const expiresAt = Math.max(current.lease_until, now + leaseMs);
      this.database
        .prepare("UPDATE webhook_events SET lease_until = ?, updated_at = ? WHERE delivery_id = ?")
        .run(expiresAt, now, lease.deliveryId);
      lease.expiresAt = expiresAt;
      return lease;
    });
  }

  completeWebhook(lease: WebhookLease, now = Date.now()): void {
    this.transitionWebhook(lease, "completed", null, now);
  }

  retryWebhook(lease: WebhookLease, error: string, now = Date.now()): void {
    this.transitionWebhook(lease, "queued", error.slice(0, 1_000), now, false, true);
  }

  /** Re-queue a non-error wait state without consuming a retry budget. */
  deferWebhook(lease: WebhookLease, reason: string, now = Date.now()): void {
    this.transitionWebhook(lease, "queued", reason.slice(0, 1_000), now, true, false, 5_000);
  }

  failWebhook(lease: WebhookLease, error: string, now = Date.now()): void {
    this.transaction(() => {
      const current = this.getWebhookRowForOwnedLease(lease, now);
      const scheduleOneReplay = current.dead_letter_replay_count < 1;
      this.database
        .prepare(`
          UPDATE webhook_events SET
            status = ?, lease_owner = NULL, lease_until = NULL, last_error = ?,
            body = CASE WHEN ? THEN body ELSE '' END,
            body_bytes = CASE WHEN ? THEN body_bytes ELSE 0 END,
            available_at = ?, updated_at = ?
          WHERE delivery_id = ?
        `)
        .run(
          scheduleOneReplay ? "dead_letter" : "failed",
          error.slice(0, 1_000),
          scheduleOneReplay ? 1 : 0,
          scheduleOneReplay ? 1 : 0,
          scheduleOneReplay ? now + 5 * 60_000 : now,
          now,
          lease.deliveryId,
        );
    });
  }

  recordReceipt(lease: RunLease, receipt: EvidenceReceipt, now = Date.now()): void {
    if (lease.runKey !== receipt.runKey) {
      throw new Error("Receipt belongs to a different exact revision.");
    }
    const outcome: MergeOutcome =
      receipt.verdict === "LOW_OBSERVED_RISK" ? "READY" : "NOT_ELIGIBLE";
    const decision: RunDecision = {
      stage: "evidence",
      state: receipt.verdict === "LOW_OBSERVED_RISK" ? "eligible" : "not_eligible",
      outcome,
      reason:
        receipt.reasons[0]?.detail ??
        (receipt.verdict === "LOW_OBSERVED_RISK"
          ? "All configured deterministic obligations passed."
          : `Evidence verdict: ${receipt.verdict}.`),
      decidedAt: new Date(now).toISOString(),
    };
    this.transition(
      lease,
      "verified",
      now,
      "UPDATE runs SET status = ?, outcome = ?, receipt_json = ?, decision_json = ?, updated_at = ? WHERE run_key = ?",
      ["verified", outcome, JSON.stringify(receipt), JSON.stringify(decision), now, lease.runKey],
    );
  }

  /** Records that GitHub accepted an exact-head enqueue; GitHub owns the merge. */
  markQueued(lease: RunLease, now = Date.now()): void {
    const decision = this.decision("publication", "queued", "QUEUED", "GitHub accepted the exact head into its merge queue.", now);
    this.transition(
      lease,
      "queued",
      now,
      "UPDATE runs SET status = ?, outcome = ?, decision_json = ?, updated_at = ? WHERE run_key = ?",
      ["queued", "QUEUED", JSON.stringify(decision), now, lease.runKey],
    );
  }

  /**
   * A later authenticated trigger proved that a previously queued exact
   * revision no longer meets live policy. The controller has already asked
   * GitHub to dequeue it; clearing the terminal queue state lets a later
   * eligible trigger collect fresh evidence instead of reusing this receipt.
   */
  revokeQueuedRevision(revision: PinnedRevision, reason: string, now = Date.now()): boolean {
    const runKey = revisionRunKey(revision);
    if (!this.isBoundedPlainText(reason, 1_000)) {
      throw new Error("Queued-run revocation reason must be bounded plain text.");
    }
    return this.transaction(() => {
      const decision = this.decision("live_policy", "not_eligible", "NOT_ELIGIBLE", reason, now);
      const result = this.database
        .prepare(`
          UPDATE runs SET
            status = 'verified', outcome = 'NOT_ELIGIBLE', decision_json = ?,
            lease_owner = NULL, lease_until = NULL, updated_at = ?
          WHERE run_key = ? AND status = 'queued'
        `)
        .run(JSON.stringify(decision), now, runKey);
      return result.changes === 1;
    });
  }

  /**
   * Persists an intent before a success signal can enter GitHub's merge queue.
   * An interrupted process must reconcile this state instead of replaying an
   * external write whose outcome is unknown.
   */
  beginPublication(lease: RunLease, now = Date.now()): void {
    const decision = this.decision("publication", "eligible", "READY", "Final live merge policy passed; publication is being recorded.", now);
    this.transition(
      lease,
      "publishing",
      now,
      "UPDATE runs SET status = ?, decision_json = ?, updated_at = ? WHERE run_key = ?",
      ["publishing", JSON.stringify(decision), now, lease.runKey],
    );
  }

  /** Prevents duplicate publication of a completed merge-group check run. */
  markReported(lease: RunLease, now = Date.now(), outcome: MergeOutcome = "READY"): void {
    const decision = this.decision(
      "publication",
      "reported",
      outcome,
      outcome === "READY"
        ? "Final merge-group Check Run was reported to GitHub."
        : "A non-low-risk final merge-group receipt was reported to GitHub.",
      now,
    );
    this.transition(
      lease,
      "reported",
      now,
      "UPDATE runs SET status = ?, outcome = ?, decision_json = ?, updated_at = ? WHERE run_key = ?",
      ["reported", outcome, JSON.stringify(decision), now, lease.runKey],
    );
  }

  markStale(lease: RunLease, reason: string, now = Date.now()): void {
    const decision = this.decision("live_policy", "stale", "STALE", reason, now);
    this.transition(
      lease,
      "stale",
      now,
      "UPDATE runs SET status = ?, outcome = ?, decision_json = ?, updated_at = ? WHERE run_key = ?",
      ["stale", "STALE", JSON.stringify(decision), now, lease.runKey],
    );
    this.recordAttempt({
      attemptId: `${lease.runKey}:${lease.fenceToken}:stale`,
      runKey: lease.runKey,
      expectedHeadSha: "unknown",
      state: "stale",
      createdAt: new Date(now).toISOString(),
      message: reason,
    });
  }

  /** Records a final live-policy rejection after deterministic evidence passed. */
  markNotEligible(lease: RunLease, reason: string, now = Date.now()): void {
    const decision = this.decision("live_policy", "not_eligible", "NOT_ELIGIBLE", reason, now);
    this.transition(
      lease,
      "verified",
      now,
      "UPDATE runs SET outcome = ?, decision_json = ?, updated_at = ? WHERE run_key = ?",
      ["NOT_ELIGIBLE", JSON.stringify(decision), now, lease.runKey],
      true,
    );
  }

  /**
   * Completes a non-eligible PR-head Check Run publication. The Check Run
   * write has already been durably journaled and acknowledged, so returning
   * the run to verified makes the rejection inspectable and lets a later
   * authenticated revision trigger start fresh evidence.
   */
  markNotEligibleAfterPublication(lease: RunLease, reason: string, now = Date.now()): void {
    const decision = this.decision("live_policy", "not_eligible", "NOT_ELIGIBLE", reason, now);
    this.transaction(() => {
      const current = this.getRunRowForOwnedLease(lease, now);
      if (current.status !== "publishing") {
        throw new Error("Only a published Check Run may finalize a live-policy rejection.");
      }
      this.database
        .prepare(`
          UPDATE runs SET
            status = 'verified', outcome = 'NOT_ELIGIBLE', decision_json = ?,
            lease_owner = NULL, lease_until = NULL, updated_at = ?
          WHERE run_key = ?
        `)
        .run(JSON.stringify(decision), now, lease.runKey);
    });
  }

  beginMerge(lease: RunLease, attempt: MergeAttempt, now = Date.now()): void {
    const decision = this.decision("merge", "eligible", "MERGING", "A direct fixture merge is in progress.", now);
    this.transition(
      lease,
      "merging",
      now,
      "UPDATE runs SET status = ?, outcome = ?, decision_json = ?, updated_at = ? WHERE run_key = ?",
      ["merging", "MERGING", JSON.stringify(decision), now, lease.runKey],
    );
    this.recordAttempt(attempt);
  }

  finishMerge(
    lease: RunLease,
    attempt: MergeAttempt,
    merged: boolean,
    message: string,
    now = Date.now(),
  ): void {
    const status: RunStatus = merged ? "merged" : "merge_failed";
    const outcome: MergeOutcome = merged ? "MERGED" : "MERGE_FAILED";
    const decision = this.decision(
      "merge",
      merged ? "merged" : "merge_failed",
      outcome,
      message,
      now,
    );
    this.transition(
      lease,
      status,
      now,
      "UPDATE runs SET status = ?, outcome = ?, decision_json = ?, updated_at = ? WHERE run_key = ?",
      [status, outcome, JSON.stringify(decision), now, lease.runKey],
    );
    this.recordAttempt({
      ...attempt,
      state: merged ? "merged" : "failed",
      message,
    });
  }

  markMergeUnknown(
    lease: RunLease,
    attempt: MergeAttempt,
    message: string,
    now = Date.now(),
  ): void {
    const decision = this.decision("merge", "reconciliation_required", "MERGE_UNKNOWN", message, now);
    this.transition(
      lease,
      "merge_unknown",
      now,
      "UPDATE runs SET status = ?, outcome = ?, decision_json = ?, updated_at = ? WHERE run_key = ?",
      ["merge_unknown", "MERGE_UNKNOWN", JSON.stringify(decision), now, lease.runKey],
    );
    this.recordAttempt({ ...attempt, state: "unknown", message });
  }

  get(revision: PinnedRevision): LedgerRun | null {
    const row = this.database
      .prepare("SELECT * FROM runs WHERE run_key = ?")
      .get(revisionRunKey(revision)) as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  getByRunKey(runKey: string): LedgerRun | null {
    const row = this.database
      .prepare("SELECT * FROM runs WHERE run_key = ?")
      .get(runKey) as RunRow | undefined;
    return row ? runFromRow(row) : null;
  }

  /**
   * Finds the one queue-owned receipt for a live pull request even when the
   * current webhook represents a newer head, merge candidate, or linked-issue
   * digest. This lets the controller revoke stale queue membership before it
   * starts fresh evidence for the newer revision.
   */
  findQueuedRunForPullRequest(repository: string, pullRequest: number): LedgerRun | null {
    if (!this.isBoundedPlainText(repository, 256) || !repository.includes("/")) {
      throw new Error("Queued-run lookup requires an owner/repository identifier.");
    }
    if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) {
      throw new Error("Queued-run lookup requires a positive pull request number.");
    }
    const rows = this.database
      .prepare("SELECT * FROM runs WHERE status = 'queued' AND receipt_json IS NOT NULL ORDER BY updated_at DESC, run_key DESC")
      .all() as RunRow[];
    for (const row of rows) {
      try {
        const run = runFromRow(row);
        if (
          run.receipt?.revision.repository === repository &&
          run.receipt.revision.pullRequest === pullRequest
        ) {
          return run;
        }
      } catch {
        // A malformed historic receipt cannot be treated as a safe queue
        // identity. It remains visible to the operator but never authorizes a
        // new automatic action.
      }
    }
    return null;
  }

  /**
   * Resolves a signed issue edit only to receipts that are currently queued
   * and explicitly sealed that same canonical issue. This deliberately reads
   * no GitHub content; the controller reloads the PR and canonical issue
   * before it can take any further action.
   */
  findQueuedRunsForLinkedIssue(repository: string, issueNumber: number): LedgerRun[] {
    if (!this.isBoundedPlainText(repository, 256) || !repository.includes("/")) {
      throw new Error("Queued issue lookup requires an owner/repository identifier.");
    }
    if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
      throw new Error("Queued issue lookup requires a positive issue number.");
    }
    const rows = this.database
      .prepare("SELECT * FROM runs WHERE status = 'queued' AND receipt_json IS NOT NULL ORDER BY updated_at DESC, run_key DESC")
      .all() as RunRow[];
    const matches: LedgerRun[] = [];
    for (const row of rows) {
      try {
        const run = runFromRow(row);
        if (
          run.receipt?.revision.repository === repository &&
          run.receipt.issueToProof.linkedIssue?.number === issueNumber
        ) {
          matches.push(run);
        }
      } catch {
        // A malformed historic receipt can never authorize a new action.
      }
    }
    return matches;
  }

  listRuns(input: { limit?: number; cursor?: RunListCursor } = {}): RunListPage {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
      throw new Error("Run list limit must be an integer from 1 through 50.");
    }
    const rows = input.cursor
      ? (this.database
          .prepare(`
            SELECT * FROM runs
            WHERE updated_at < ? OR (updated_at = ? AND run_key < ?)
            ORDER BY updated_at DESC, run_key DESC
            LIMIT ?
          `)
          .all(input.cursor.updatedAt, input.cursor.updatedAt, input.cursor.runKey, limit + 1) as RunRow[])
      : (this.database
          .prepare("SELECT * FROM runs ORDER BY updated_at DESC, run_key DESC LIMIT ?")
          .all(limit + 1) as RunRow[]);
    const hasNext = rows.length > limit;
    const pageRows = hasNext ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return {
      runs: pageRows.map(runFromRow),
      ...(hasNext && last ? { nextCursor: { updatedAt: last.updated_at, runKey: last.run_key } } : {}),
    };
  }

  operatorStats(): OperatorLedgerStats {
    const runCounts = Object.fromEntries(
      (this.database.prepare("SELECT status, COUNT(*) AS count FROM runs GROUP BY status").all() as Array<{
        status: RunStatus;
        count: number | bigint;
      }>).map((row) => [row.status, Number(row.count)]),
    ) as Partial<Record<RunStatus, number>>;
    const runs: Record<RunStatus, number> = {
      running: 0,
      verified: 0,
      publishing: 0,
      queued: 0,
      reported: 0,
      stale: 0,
      merging: 0,
      merged: 0,
      merge_failed: 0,
      merge_unknown: 0,
      ...runCounts,
    };
    const inboxRows = this.database
      .prepare("SELECT status, COUNT(*) AS count FROM webhook_events GROUP BY status")
      .all() as Array<{ status: WebhookEventStatus; count: number | bigint }>;
    const inboxCounts = Object.fromEntries(inboxRows.map((row) => [row.status, Number(row.count)])) as Partial<
      Record<WebhookEventStatus, number>
    >;
    const pending = this.database
      .prepare("SELECT COALESCE(SUM(body_bytes), 0) AS bytes FROM webhook_events WHERE status IN ('queued', 'running', 'dead_letter')")
      .get() as { bytes: number | bigint };
    return {
      runs,
      inbox: {
        queued: inboxCounts.queued ?? 0,
        running: inboxCounts.running ?? 0,
        completed: inboxCounts.completed ?? 0,
        failed: inboxCounts.failed ?? 0,
        deadLetter: inboxCounts.dead_letter ?? 0,
        pendingBytes: Number(pending.bytes),
        maxPendingEvents: this.maxPendingWebhookEvents,
        maxPendingBytes: this.maxPendingWebhookBytes,
      },
    };
  }

  /** Reads the durable emergency-stop state without granting any merge authority. */
  automationControl(): AutomationControl {
    const row = this.database
      .prepare("SELECT paused, updated_at FROM automation_control WHERE id = 1")
      .get() as { paused: number; updated_at: number } | undefined;
    if (!row || (row.paused !== 0 && row.paused !== 1) || !Number.isSafeInteger(row.updated_at)) {
      throw new Error("Automation control record is unavailable or invalid.");
    }
    return { paused: row.paused === 1, updatedAt: row.updated_at };
  }

  /**
   * Changes only the emergency-stop bit. Resuming does not recreate a queue
   * entry or reuse old evidence; a normal new GitHub trigger must evaluate it.
   */
  setAutomationPaused(paused: boolean, now = Date.now()): AutomationControl {
    if (typeof paused !== "boolean" || !Number.isSafeInteger(now) || now < 0) {
      throw new Error("Automation control requires a boolean state and a valid timestamp.");
    }
    return this.transaction(() => {
      this.database
        .prepare("UPDATE automation_control SET paused = ?, updated_at = ? WHERE id = 1")
        .run(paused ? 1 : 0, now);
      return this.automationControl();
    });
  }

  getAttempt(attemptId: string): MergeAttempt | null {
    const row = this.database
      .prepare("SELECT * FROM merge_attempts WHERE attempt_id = ?")
      .get(attemptId) as
      | {
          attempt_id: string;
          run_key: string;
          expected_head_sha: string;
          state: MergeAttempt["state"];
          created_at: string;
          message: string | null;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      attemptId: row.attempt_id,
      runKey: row.run_key,
      expectedHeadSha: row.expected_head_sha,
      state: row.state,
      createdAt: row.created_at,
      ...(row.message ? { message: row.message } : {}),
    };
  }

  /**
   * Durably records the exact external intent while the caller still owns the
   * run lease.  The caller must issue the external write only after receiving
   * `prepared`; an existing record deliberately fails closed into
   * reconciliation rather than permitting a replay.
   */
  prepareExternalOperation(
    lease: RunLease,
    intent: ExternalOperationIntent,
    now = Date.now(),
  ): ExternalOperationPreparation {
    this.assertExternalOperationIntent(intent);
    return this.transaction(() => {
      const current = this.getRunRowForOwnedLease(lease, now);
      if (!this.statusAllowsExternalOperation(current.status, intent.kind)) {
        throw new Error(
          `Run status ${current.status} does not permit external operation ${intent.kind}.`,
        );
      }

      const existingById = this.database
        .prepare("SELECT * FROM external_operations WHERE operation_id = ?")
        .get(intent.operationId) as ExternalOperationRow | undefined;
      if (existingById) {
        this.assertMatchingExternalOperation(existingById, lease.runKey, intent);
        return { state: "already_recorded", operation: externalOperationFromRow(existingById) };
      }

      // A different idempotency key for the same run/action is also unsafe:
      // a prior process may already have emitted the write after persisting it.
      const existingByRunAndKind = this.database
        .prepare("SELECT * FROM external_operations WHERE run_key = ? AND kind = ?")
        .get(lease.runKey, intent.kind) as ExternalOperationRow | undefined;
      if (existingByRunAndKind) {
        this.assertMatchingExternalOperation(existingByRunAndKind, lease.runKey, intent, false);
        return { state: "already_recorded", operation: externalOperationFromRow(existingByRunAndKind) };
      }

      this.database
        .prepare(`
          INSERT INTO external_operations (
            operation_id, run_key, kind, installation_id,
            repository, pull_request, expected_head_sha, check_name,
            pull_request_node_id, queue_entry_id, check_run_id, check_run_external_id,
            expected_check_conclusion,
            state, intent_fence_token, reconciliation_fence_token, next_reconcile_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent_recorded', ?, 0, ?, ?, ?)
        `)
        .run(
          intent.operationId,
          lease.runKey,
          intent.kind,
          intent.installationId,
          intent.target.repository,
          intent.target.pullRequest,
          intent.target.expectedHeadSha,
          intent.target.checkName ?? null,
          intent.expectation.pullRequestNodeId ?? null,
          intent.expectation.queueEntryId ?? null,
          intent.expectation.checkRunId ?? null,
          intent.expectation.checkRunExternalId ?? null,
          intent.expectation.expectedCheckConclusion ?? null,
          lease.fenceToken,
          now,
          now,
          now,
        );
      const operation = this.getExternalOperationRow(intent.operationId);
      if (!operation) {
        throw new Error("External operation journal write did not persist.");
      }
      return { state: "prepared", operation: externalOperationFromRow(operation) };
    });
  }

  getExternalOperation(operationId: string): ExternalOperation | null {
    const row = this.getExternalOperationRow(operationId);
    return row ? externalOperationFromRow(row) : null;
  }

  /**
   * Persist the GitHub-generated Check Run id immediately after creation.
   * The deterministic external id remains a fallback for a crash between the
   * POST response and this durable binding.
   */
  bindCheckRunToOperation(
    lease: RunLease,
    operationId: string,
    checkRunId: number,
    now = Date.now(),
  ): ExternalOperation {
    if (!Number.isSafeInteger(checkRunId) || checkRunId < 1) {
      throw new Error("Check Run id must be a positive integer.");
    }
    return this.transaction(() => {
      this.getRunRowForOwnedLease(lease, now);
      const operation = this.getExternalOperationRow(operationId);
      if (
        !operation ||
        operation.run_key !== lease.runKey ||
        operation.kind !== "check_run_publish" ||
        operation.intent_fence_token !== lease.fenceToken
      ) {
        throw new Error("Check Run binding does not match the active publication operation.");
      }
      if (operation.check_run_id !== null && operation.check_run_id !== checkRunId) {
        throw new Error("Check Run binding conflicts with the durable publication operation.");
      }
      this.database
        .prepare("UPDATE external_operations SET check_run_id = ?, updated_at = ? WHERE operation_id = ?")
        .run(checkRunId, now, operationId);
      const bound = this.getExternalOperationRow(operationId);
      if (!bound) {
        throw new Error("Check Run binding disappeared after persistence.");
      }
      return externalOperationFromRow(bound);
    });
  }

  /**
   * Records GitHub's acknowledged completion after the Check Run PATCH
   * returns. This is a local acknowledgement, never a recovery read or a
   * retry; a crash before it leaves the exact operation for read-only
   * reconciliation.
   */
  confirmCheckRunCompletion(
    lease: RunLease,
    operationId: string,
    checkRunId: number,
    now = Date.now(),
  ): ExternalOperation {
    if (!Number.isSafeInteger(checkRunId) || checkRunId < 1) {
      throw new Error("Confirmed Check Run id must be a positive integer.");
    }
    return this.transaction(() => {
      const current = this.getRunRowForOwnedLease(lease, now);
      if (current.status !== "publishing") {
        throw new Error("Only an active publication may confirm a Check Run completion.");
      }
      const operation = this.getExternalOperationRow(operationId);
      if (
        !operation ||
        operation.run_key !== lease.runKey ||
        operation.kind !== "check_run_publish" ||
        operation.intent_fence_token !== lease.fenceToken ||
        operation.check_run_id !== checkRunId ||
        operation.state !== "intent_recorded"
      ) {
        throw new Error("Check Run completion does not match the active publication operation.");
      }
      this.database
        .prepare(`
          UPDATE external_operations SET
            state = 'observed_applied',
            evidence = 'Exact Check Run completion was acknowledged by GitHub.',
            resolved_at = ?, next_reconcile_at = ?,
            reconciliation_lease_owner = NULL, reconciliation_lease_until = NULL,
            updated_at = ?
          WHERE operation_id = ?
        `)
        .run(now, now, now, operationId);
      const confirmed = this.getExternalOperationRow(operationId);
      if (!confirmed) {
        throw new Error("Confirmed Check Run operation disappeared after completion.");
      }
      return externalOperationFromRow(confirmed);
    });
  }

  /**
   * Prevent a reconciler from racing a still-live publisher. A Check Run can
   * be failed closed only after the original publication lease has expired.
   */
  checkRunRecoveryState(lease: ReconciliationLease, now = Date.now()): CheckRunRecoveryState {
    return this.transaction(() => {
      const operation = this.getExternalOperationRow(lease.operationId);
      this.assertCurrentReconciliationLease(operation, lease, now);
      if (operation.kind !== "check_run_publish") {
        throw new Error("Check Run recovery requires a Check Run publication operation.");
      }
      const run = this.database
        .prepare("SELECT * FROM runs WHERE run_key = ?")
        .get(operation.run_key) as RunRow | undefined;
      if (!run || run.status !== "publishing") {
        return "terminal";
      }
      return run.lease_until === null || run.lease_until < now ? "eligible" : "active";
    });
  }

  /**
   * Checks whether a non-Check-Run operation can advance its owning run.
   * This deliberately does not settle an operation while its original
   * publisher lease remains valid: a live publisher may still record the
   * result of the same GitHub write itself.
   */
  externalOperationRecoveryState(
    lease: ReconciliationLease,
    now = Date.now(),
  ): ExternalOperationRecoveryState {
    return this.transaction(() => {
      const operation = this.getExternalOperationRow(lease.operationId);
      this.assertCurrentReconciliationLease(operation, lease, now);
      if (operation.kind === "check_run_publish") {
        throw new Error("Check Run publication uses its dedicated recovery state.");
      }
      const run = this.database
        .prepare("SELECT * FROM runs WHERE run_key = ?")
        .get(operation.run_key) as RunRow | undefined;
      const isRecoverable =
        (operation.kind === "merge_queue_enqueue" && run?.status === "publishing") ||
        (operation.kind === "direct_merge" && (run?.status === "merging" || run?.status === "merge_unknown"));
      if (!isRecoverable) {
        return "terminal";
      }
      return run.lease_until === null || run.lease_until < now ? "eligible" : "active";
    });
  }

  /**
   * Atomically settles a non-Check-Run operation and its owning run after an
   * exact read-only observation. It is intentionally narrower than generic
   * reconciliation: only an expired publisher lease may produce queue or
   * direct-merge terminal state, and it never performs a GitHub write.
   */
  finalizeReconciledExternalOperation(
    lease: ReconciliationLease,
    input: {
      operationState: Extract<ExternalOperationState, "observed_applied" | "observed_not_applied">;
      evidence: string;
    },
    now = Date.now(),
  ): ExternalOperation {
    if (!this.isBoundedPlainText(input.evidence, 1_000)) {
      throw new Error("Recovered external-operation evidence must be bounded plain text.");
    }
    return this.transaction(() => {
      const operation = this.getExternalOperationRow(lease.operationId);
      this.assertCurrentReconciliationLease(operation, lease, now);
      if (operation.kind === "check_run_publish") {
        throw new Error("Check Run operations must use dedicated recovery finalization.");
      }
      const run = this.database
        .prepare("SELECT * FROM runs WHERE run_key = ?")
        .get(operation.run_key) as RunRow | undefined;
      if (!run) {
        throw new Error("Recovered external operation has no owning run.");
      }
      const runLeaseExpired = run.lease_until === null || run.lease_until < now;
      const expectedRunStatus = operation.kind === "merge_queue_enqueue"
        ? run.status === "publishing"
        : run.status === "merging" || run.status === "merge_unknown";
      if (!expectedRunStatus || !runLeaseExpired) {
        throw new Error("External operation recovery may finalize only an expired in-flight run.");
      }
      if (operation.kind === "merge_queue_enqueue" && input.operationState !== "observed_applied") {
        throw new Error("A merge queue run may be finalized only by an exact queued observation.");
      }

      const merged = operation.kind === "direct_merge" && input.operationState === "observed_applied";
      const status: RunStatus = operation.kind === "merge_queue_enqueue"
        ? "queued"
        : merged
          ? "merged"
          : "merge_failed";
      const outcome: MergeOutcome = operation.kind === "merge_queue_enqueue"
        ? "QUEUED"
        : merged
          ? "MERGED"
          : "MERGE_FAILED";
      const decision = this.decision(
        operation.kind === "merge_queue_enqueue" ? "publication" : "merge",
        operation.kind === "merge_queue_enqueue"
          ? "queued"
          : merged
            ? "merged"
            : "merge_failed",
        outcome,
        input.evidence,
        now,
      );
      this.database
        .prepare(`
          UPDATE external_operations SET
            state = ?, evidence = ?, resolved_at = ?, next_reconcile_at = ?,
            reconciliation_lease_owner = NULL, reconciliation_lease_until = NULL,
            updated_at = ?
          WHERE operation_id = ?
        `)
        .run(
          input.operationState,
          input.evidence,
          now,
          now,
          now,
          lease.operationId,
        );
      this.database
        .prepare(`
          UPDATE runs SET
            status = ?, outcome = ?, decision_json = ?,
            lease_owner = NULL, lease_until = NULL, updated_at = ?
          WHERE run_key = ?
        `)
        .run(status, outcome, JSON.stringify(decision), now, operation.run_key);
      if (operation.kind === "direct_merge") {
        this.database
          .prepare(`
            UPDATE merge_attempts SET state = ?, message = ?
            WHERE attempt_id = (
              SELECT attempt_id FROM merge_attempts
              WHERE run_key = ? AND state IN ('started', 'unknown')
              ORDER BY created_at DESC, attempt_id DESC
              LIMIT 1
            )
          `)
          .run(merged ? "merged" : "failed", input.evidence, operation.run_key);
      }
      const finalized = this.getExternalOperationRow(lease.operationId);
      if (!finalized) {
        throw new Error("Recovered external operation disappeared after finalization.");
      }
      return externalOperationFromRow(finalized);
    });
  }

  /**
   * Atomically records a terminal Check Run observation and moves the exact
   * run out of publishing. A final merge-group Check Run remains terminal,
   * while a PR-head Check Run returns to verified: recovery proves only that
   * one publication completed, not that the interrupted controller reached
   * its later queue decision. This is intentionally available only to a
   * fenced reconciliation lease, never to a fresh webhook worker.
   */
  finalizeReconciledCheckRun(
    lease: ReconciliationLease,
    input: {
      checkRunId?: number;
      operationState: Extract<ExternalOperationState, "observed_applied" | "observed_not_applied">;
      outcome: Extract<MergeOutcome, "READY" | "NOT_ELIGIBLE">;
      evidence: string;
    },
    now = Date.now(),
  ): ExternalOperation {
    if (input.checkRunId !== undefined && (!Number.isSafeInteger(input.checkRunId) || input.checkRunId < 1)) {
      throw new Error("Recovered Check Run id must be a positive integer.");
    }
    if (!this.isBoundedPlainText(input.evidence, 1_000)) {
      throw new Error("Recovered Check Run evidence must be bounded plain text.");
    }
    return this.transaction(() => {
      const operation = this.getExternalOperationRow(lease.operationId);
      this.assertCurrentReconciliationLease(operation, lease, now);
      if (operation.kind !== "check_run_publish") {
        throw new Error("Only Check Run operations may be finalized by Check Run recovery.");
      }
      if (operation.check_run_id !== null && input.checkRunId !== undefined && operation.check_run_id !== input.checkRunId) {
        throw new Error("Recovered Check Run id conflicts with the durable publication operation.");
      }
      const run = this.database
        .prepare("SELECT * FROM runs WHERE run_key = ?")
        .get(operation.run_key) as RunRow | undefined;
      if (!run || run.status !== "publishing" || (run.lease_until !== null && run.lease_until >= now)) {
        throw new Error("Check Run recovery may finalize only an expired publishing run.");
      }
      const isFinalMergeGroupCheck = operation.pull_request === 0;
      const recoveredStatus: RunStatus = isFinalMergeGroupCheck ? "reported" : "verified";
      const decision = this.decision(
        "publication",
        input.outcome === "READY"
          ? isFinalMergeGroupCheck
            ? "reported"
            : "eligible"
          : "not_eligible",
        input.outcome,
        input.evidence,
        now,
      );
      this.database
        .prepare(`
          UPDATE external_operations SET
            check_run_id = COALESCE(check_run_id, ?),
            state = ?, evidence = ?, resolved_at = ?, next_reconcile_at = ?,
            reconciliation_lease_owner = NULL, reconciliation_lease_until = NULL,
            updated_at = ?
          WHERE operation_id = ?
        `)
        .run(
          input.checkRunId ?? null,
          input.operationState,
          input.evidence,
          now,
          now,
          now,
          lease.operationId,
        );
      this.database
        .prepare(`
          UPDATE runs SET
            status = ?, outcome = ?, decision_json = ?,
            lease_owner = NULL, lease_until = NULL, updated_at = ?
          WHERE run_key = ?
        `)
        .run(recoveredStatus, input.outcome, JSON.stringify(decision), now, operation.run_key);
      const finalized = this.getExternalOperationRow(lease.operationId);
      if (!finalized) {
        throw new Error("Recovered Check Run operation disappeared after finalization.");
      }
      return externalOperationFromRow(finalized);
    });
  }

  /**
   * Claims exactly one unresolved external intent for read-only
   * reconciliation.  The operation itself is never reset or replayed.
   */
  claimReconciliationCandidate(
    workerId: string,
    leaseMs: number,
    now = Date.now(),
  ): ReconciliationCandidate | null {
    this.assertLeaseDuration(leaseMs);
    this.assertWorkerId(workerId);
    return this.transaction(() => {
      const row = this.database
        .prepare(`
          SELECT * FROM external_operations
          WHERE state IN ('intent_recorded', 'ambiguous')
            AND next_reconcile_at <= ?
            AND (reconciliation_lease_until IS NULL OR reconciliation_lease_until < ?)
          ORDER BY next_reconcile_at ASC, created_at ASC, operation_id ASC
          LIMIT 1
        `)
        .get(now, now) as ExternalOperationRow | undefined;
      if (!row) {
        return null;
      }
      const fenceToken = row.reconciliation_fence_token + 1;
      const expiresAt = now + leaseMs;
      this.database
        .prepare(`
          UPDATE external_operations SET
            reconciliation_fence_token = ?, reconciliation_lease_owner = ?,
            reconciliation_lease_until = ?, updated_at = ?
          WHERE operation_id = ?
        `)
        .run(fenceToken, workerId, expiresAt, now, row.operation_id);
      const operation = this.getExternalOperationRow(row.operation_id);
      if (!operation) {
        throw new Error("Reconciliation candidate disappeared while being claimed.");
      }
      return {
        operation: externalOperationFromRow(operation),
        lease: { operationId: row.operation_id, workerId, fenceToken, expiresAt },
      };
    });
  }

  renewReconciliationLease(
    lease: ReconciliationLease,
    leaseMs: number,
    now = Date.now(),
  ): ReconciliationLease {
    this.assertLeaseDuration(leaseMs);
    return this.transaction(() => {
      const current = this.getExternalOperationRow(lease.operationId);
      this.assertCurrentReconciliationLease(current, lease, now);
      const expiresAt = Math.max(current.reconciliation_lease_until ?? 0, now + leaseMs);
      this.database
        .prepare("UPDATE external_operations SET reconciliation_lease_until = ?, updated_at = ? WHERE operation_id = ?")
        .run(expiresAt, now, lease.operationId);
      lease.expiresAt = expiresAt;
      return lease;
    });
  }

  /**
   * Commits a read-only reconciliation result with a fenced compare-and-swap.
   * An ambiguous result is retained for another read later; neither result
   * can cause the original GitHub write to be replayed.
   */
  resolveReconciliationCandidate(
    lease: ReconciliationLease,
    resolution: ReconciliationResolution,
    now = Date.now(),
  ): ExternalOperation {
    this.assertReconciliationResolution(resolution);
    return this.transaction(() => {
      const current = this.getExternalOperationRow(lease.operationId);
      this.assertCurrentReconciliationLease(current, lease, now);
      const terminal = resolution.state !== "ambiguous";
      const retryAfterMs =
        resolution.state === "ambiguous" ? resolution.retryAfterMs ?? 30_000 : 0;
      this.database
        .prepare(`
          UPDATE external_operations SET
            state = ?, evidence = ?, resolved_at = ?, next_reconcile_at = ?,
            reconciliation_lease_owner = NULL, reconciliation_lease_until = NULL,
            updated_at = ?
          WHERE operation_id = ?
        `)
        .run(
          resolution.state,
          resolution.evidence,
          terminal ? now : null,
          terminal ? now : now + retryAfterMs,
          now,
          lease.operationId,
        );
      const resolved = this.getExternalOperationRow(lease.operationId);
      if (!resolved) {
        throw new Error("Reconciliation result did not persist.");
      }
      return externalOperationFromRow(resolved);
    });
  }

  getWebhookEventMetadata(deliveryId: string): WebhookEventMetadata | null {
    const row = this.database
      .prepare("SELECT status, body, body_bytes, attempt_count, dead_letter_replay_count FROM webhook_events WHERE delivery_id = ?")
      .get(deliveryId) as
      | {
          status: WebhookEventStatus;
          body: string;
          body_bytes: number;
          attempt_count: number;
          dead_letter_replay_count: number;
        }
      | undefined;
    if (!row) {
      return null;
    }
    return {
      status: row.status,
      bodyRetained: row.body.length > 0,
      bodyBytes: row.body_bytes,
      attemptCount: row.attempt_count,
      deadLetterReplayCount: row.dead_letter_replay_count,
    };
  }

  close(): void {
    this.database.close();
  }

  private transition(
    lease: RunLease,
    expectedStatus: RunStatus,
    now: number,
    statement: string,
    parameters: SqlInputValue[],
    allowExistingVerified = false,
  ): void {
    this.transaction(() => {
      const current = this.database
        .prepare("SELECT * FROM runs WHERE run_key = ?")
        .get(lease.runKey) as RunRow | undefined;
      if (!current) {
        throw new Error("Run lease does not exist.");
      }
      if (
        current.lease_owner !== lease.workerId ||
        current.fence_token !== lease.fenceToken ||
        current.lease_until === null ||
        current.lease_until < now
      ) {
        throw new Error("Run lease is stale or owned by another worker.");
      }
      if (
        expectedStatus === "merging" &&
        current.status !== "verified"
      ) {
        throw new Error("Only a verified exact revision may begin a merge.");
      }
      if (
        expectedStatus === "merged" ||
        expectedStatus === "merge_failed" ||
        expectedStatus === "merge_unknown"
      ) {
        if (current.status !== "merging") {
          throw new Error("Only an in-flight merge may be completed.");
        }
      }
      if (
        expectedStatus === "verified" &&
        current.status !== (allowExistingVerified ? "verified" : "running")
      ) {
        throw new Error("Only an active run may record a receipt.");
      }
      if (expectedStatus === "publishing" && current.status !== "verified") {
        throw new Error("Only a verified exact revision may begin publication.");
      }
      if ((expectedStatus === "queued" || expectedStatus === "reported") && current.status !== "publishing") {
        throw new Error("Only an intended publication may be finalized.");
      }

      this.database.prepare(statement).run(...parameters);
    });
  }

  private recordAttempt(attempt: MergeAttempt): void {
    this.database
      .prepare(`
        INSERT INTO merge_attempts (attempt_id, run_key, expected_head_sha, state, created_at, message)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(attempt_id) DO UPDATE SET state = excluded.state, message = excluded.message
      `)
      .run(
        attempt.attemptId,
        attempt.runKey,
        attempt.expectedHeadSha,
        attempt.state,
        attempt.createdAt,
        attempt.message ?? null,
      );
  }

  private transitionWebhook(
    lease: WebhookLease,
    status: WebhookEventStatus,
    error: string | null,
    now: number,
    preserveAttemptCount = false,
    retryWithBackoff = false,
    delayMs = 0,
  ): void {
    this.transaction(() => {
      const current = this.getWebhookRowForOwnedLease(lease, now);
      this.database
        .prepare(`
          UPDATE webhook_events SET
            status = ?, attempt_count = ?, lease_owner = NULL, lease_until = NULL,
            last_error = ?, body = CASE WHEN ? IN ('completed', 'failed') THEN '' ELSE body END,
            body_bytes = CASE WHEN ? IN ('completed', 'failed') THEN 0 ELSE body_bytes END,
            available_at = ?, updated_at = ?
          WHERE delivery_id = ?
        `)
        .run(
          status,
          preserveAttemptCount ? current.attempt_count - 1 : current.attempt_count,
          error,
          status,
          status,
          status === "queued"
            ? now + (retryWithBackoff ? Math.min(60_000, 1_000 * 2 ** Math.max(0, current.attempt_count - 1)) : delayMs)
            : now,
          now,
          lease.deliveryId,
        );
    });
  }

  private getWebhookRowForOwnedLease(lease: WebhookLease, now: number): WebhookRow {
    const current = this.database
      .prepare("SELECT * FROM webhook_events WHERE delivery_id = ?")
      .get(lease.deliveryId) as WebhookRow | undefined;
    if (
      !current ||
      current.status !== "running" ||
      current.lease_owner !== lease.workerId ||
      current.fence_token !== lease.fenceToken ||
      current.lease_until === null ||
      current.lease_until < now
    ) {
      throw new Error("Webhook lease is stale or owned by another worker.");
    }
    return current;
  }

  /** Adds retry scheduling without breaking ledgers created before this field existed. */
  private migrateWebhookAvailability(): void {
    const columns = this.database.prepare("PRAGMA table_info(webhook_events)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "available_at")) {
      return;
    }
    this.database.exec("ALTER TABLE webhook_events ADD COLUMN available_at INTEGER NOT NULL DEFAULT 0;");
    this.database.exec("UPDATE webhook_events SET available_at = received_at WHERE available_at = 0;");
  }

  private migrateRunDecision(): void {
    const columns = this.database.prepare("PRAGMA table_info(runs)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "decision_json")) {
      this.database.exec("ALTER TABLE runs ADD COLUMN decision_json TEXT;");
    }
  }

  private migrateWebhookBodyBytes(): void {
    const columns = this.database.prepare("PRAGMA table_info(webhook_events)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === "body_bytes")) {
      return;
    }
    this.database.exec("ALTER TABLE webhook_events ADD COLUMN body_bytes INTEGER NOT NULL DEFAULT 0;");
    this.database.exec("UPDATE webhook_events SET body_bytes = length(CAST(body AS BLOB)) WHERE body_bytes = 0;");
  }

  /** Gives ledgers created before fair scheduling a unique, safe fallback lane. */
  private migrateWebhookRepositoryKey(): void {
    const columns = this.database.prepare("PRAGMA table_info(webhook_events)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "repository_key")) {
      this.database.exec("ALTER TABLE webhook_events ADD COLUMN repository_key TEXT;");
    }
    const legacyRows = this.database
      .prepare("SELECT delivery_id, body FROM webhook_events WHERE repository_key IS NULL OR repository_key = ''")
      .all() as Array<{ delivery_id: string; body: string }>;
    const update = this.database.prepare("UPDATE webhook_events SET repository_key = ? WHERE delivery_id = ?");
    for (const row of legacyRows) {
      update.run(repositorySchedulingKey(row.body, row.delivery_id), row.delivery_id);
    }
  }

  /** Adds the bounded automatic dead-letter replay counter to older ledgers. */
  private migrateWebhookDeadLetter(): void {
    const columns = this.database.prepare("PRAGMA table_info(webhook_events)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "dead_letter_replay_count")) {
      this.database.exec(
        "ALTER TABLE webhook_events ADD COLUMN dead_letter_replay_count INTEGER NOT NULL DEFAULT 0;",
      );
    }
  }

  /**
   * Keeps a local development ledger readable across the introduction of the
   * reconciliation journal.  A pre-journal row with installation id 0 cannot
   * be safely reconciled; new intent writes always require a real id.
   */
  private migrateExternalOperationExpectations(): void {
    const columns = this.database.prepare("PRAGMA table_info(external_operations)").all() as Array<{
      name: string;
    }>;
    const names = new Set(columns.map((column) => column.name));
    const add = (name: string, definition: string): void => {
      if (!names.has(name)) {
        this.database.exec(`ALTER TABLE external_operations ADD COLUMN ${definition};`);
      }
    };
    add("installation_id", "installation_id INTEGER NOT NULL DEFAULT 0");
    add("pull_request_node_id", "pull_request_node_id TEXT");
    add("queue_entry_id", "queue_entry_id TEXT");
    add("check_run_id", "check_run_id INTEGER");
    add("check_run_external_id", "check_run_external_id TEXT");
    add("expected_check_conclusion", "expected_check_conclusion TEXT");
  }

  private getRunRowForOwnedLease(lease: RunLease, now: number): RunRow {
    const current = this.database
      .prepare("SELECT * FROM runs WHERE run_key = ?")
      .get(lease.runKey) as RunRow | undefined;
    if (
      !current ||
      current.lease_owner !== lease.workerId ||
      current.fence_token !== lease.fenceToken ||
      current.lease_until === null ||
      current.lease_until < now
    ) {
      throw new Error("Run lease is stale or owned by another worker.");
    }
    return current;
  }

  private getExternalOperationRow(operationId: string): ExternalOperationRow | undefined {
    return this.database
      .prepare("SELECT * FROM external_operations WHERE operation_id = ?")
      .get(operationId) as ExternalOperationRow | undefined;
  }

  private statusAllowsExternalOperation(status: RunStatus, kind: ExternalOperationKind): boolean {
    return kind === "direct_merge" ? status === "merging" : status === "publishing";
  }

  private assertMatchingExternalOperation(
    row: ExternalOperationRow,
    runKey: string,
    intent: ExternalOperationIntent,
    requireSameOperationId = true,
  ): void {
    const matches =
      row.run_key === runKey &&
      row.kind === intent.kind &&
      row.installation_id === intent.installationId &&
      row.repository === intent.target.repository &&
      row.pull_request === intent.target.pullRequest &&
      row.expected_head_sha === intent.target.expectedHeadSha &&
      row.check_name === (intent.target.checkName ?? null) &&
      row.pull_request_node_id === (intent.expectation.pullRequestNodeId ?? null) &&
      row.queue_entry_id === (intent.expectation.queueEntryId ?? null) &&
      row.check_run_id === (intent.expectation.checkRunId ?? null) &&
      row.check_run_external_id === (intent.expectation.checkRunExternalId ?? null) &&
      row.expected_check_conclusion === (intent.expectation.expectedCheckConclusion ?? null) &&
      (!requireSameOperationId || row.operation_id === intent.operationId);
    if (!matches) {
      throw new Error("External operation idempotency key conflicts with an existing journal record.");
    }
  }

  private assertExternalOperationIntent(intent: ExternalOperationIntent): void {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(intent.operationId)) {
      throw new Error("External operation id must be a bounded opaque identifier.");
    }
    if (!Number.isSafeInteger(intent.installationId) || intent.installationId < 1) {
      throw new Error("External operation installation id must be a positive integer.");
    }
    if (!this.isBoundedPlainText(intent.target.repository, 256) || !intent.target.repository.includes("/")) {
      throw new Error("External operation repository must be an owner/repository identifier.");
    }
    if (
      !Number.isSafeInteger(intent.target.pullRequest) ||
      intent.target.pullRequest < 0 ||
      (intent.kind !== "check_run_publish" && intent.target.pullRequest < 1)
    ) {
      throw new Error("External operation pull request must be positive except for a merge-group Check Run.");
    }
    if (!/^[A-Za-z0-9._-]{1,200}$/.test(intent.target.expectedHeadSha)) {
      throw new Error("External operation expected head SHA must be a bounded revision identifier.");
    }
    const hasCheckName = intent.target.checkName !== undefined;
    if (intent.kind === "check_run_publish" && !hasCheckName) {
      throw new Error("Check Run publication requires an exact Check Run name.");
    }
    if (intent.kind !== "check_run_publish" && hasCheckName) {
      throw new Error("Only Check Run publication may include a Check Run name.");
    }
    if (hasCheckName && !this.isBoundedPlainText(intent.target.checkName, 200)) {
      throw new Error("Check Run name must be bounded plain text.");
    }
    const expectation = intent.expectation;
    if (!expectation || typeof expectation !== "object") {
      throw new Error("External operation requires safe reconciliation expectations.");
    }
    if (
      expectation.pullRequestNodeId !== undefined &&
      !this.isBoundedOpaqueReference(expectation.pullRequestNodeId)
    ) {
      throw new Error("Pull request node id must be a bounded opaque reference.");
    }
    if (expectation.queueEntryId !== undefined && !this.isBoundedOpaqueReference(expectation.queueEntryId)) {
      throw new Error("Merge queue entry id must be a bounded opaque reference.");
    }
    if (
      expectation.checkRunExternalId !== undefined &&
      !this.isBoundedOpaqueReference(expectation.checkRunExternalId)
    ) {
      throw new Error("Check Run external id must be a bounded opaque reference.");
    }
    if (
      expectation.checkRunId !== undefined &&
      (!Number.isSafeInteger(expectation.checkRunId) || expectation.checkRunId < 1)
    ) {
      throw new Error("Check Run id must be a positive integer.");
    }
    if (
      expectation.expectedCheckConclusion !== undefined &&
      !CHECK_RUN_CONCLUSIONS.has(expectation.expectedCheckConclusion)
    ) {
      throw new Error("Check Run expectation must use a known GitHub conclusion.");
    }
    if (intent.kind === "merge_queue_enqueue" && !expectation.pullRequestNodeId && !expectation.queueEntryId) {
      throw new Error("Merge queue reconciliation requires a pull request node id or queue entry id.");
    }
    if (intent.kind === "direct_merge" && !expectation.pullRequestNodeId) {
      throw new Error("Direct merge reconciliation requires the exact pull request node id.");
    }
    if (
      intent.kind === "check_run_publish" &&
      (!expectation.checkRunId || !expectation.expectedCheckConclusion) &&
      !expectation.checkRunExternalId
    ) {
      throw new Error(
        "Check Run reconciliation requires an id or deterministic external id and an expected conclusion.",
      );
    }
    if (intent.kind === "check_run_publish" && !expectation.expectedCheckConclusion) {
      throw new Error("Check Run reconciliation requires an expected conclusion.");
    }
    if (
      intent.kind !== "check_run_publish" &&
      (expectation.checkRunId !== undefined ||
        expectation.checkRunExternalId !== undefined ||
        expectation.expectedCheckConclusion !== undefined)
    ) {
      throw new Error("Only Check Run publication may include Check Run expectations.");
    }
  }

  private assertCurrentReconciliationLease(
    current: ExternalOperationRow | undefined,
    lease: ReconciliationLease,
    now: number,
  ): asserts current is ExternalOperationRow {
    if (
      !current ||
      !["intent_recorded", "ambiguous"].includes(current.state) ||
      current.reconciliation_lease_owner !== lease.workerId ||
      current.reconciliation_fence_token !== lease.fenceToken ||
      current.reconciliation_lease_until === null ||
      current.reconciliation_lease_until < now
    ) {
      throw new Error("Reconciliation lease is stale or owned by another worker.");
    }
  }

  private assertReconciliationResolution(resolution: ReconciliationResolution): void {
    if (resolution.state === "check_run_in_progress") {
      throw new Error("An in-progress Check Run observation must be handled by the recovery worker.");
    }
    if (!this.isBoundedPlainText(resolution.evidence, 1_000)) {
      throw new Error("Reconciliation evidence must be bounded plain text.");
    }
    if (resolution.state === "observed_applied" || resolution.state === "observed_not_applied") {
      if (
        resolution.checkRunId !== undefined &&
        (!Number.isSafeInteger(resolution.checkRunId) || resolution.checkRunId < 1)
      ) {
        throw new Error("Observed Check Run id must be a positive integer.");
      }
    }
    if (resolution.state === "ambiguous" && resolution.retryAfterMs !== undefined) {
      if (
        !Number.isSafeInteger(resolution.retryAfterMs) ||
        resolution.retryAfterMs < 1_000 ||
        resolution.retryAfterMs > 24 * 60 * 60 * 1_000
      ) {
        throw new Error("Ambiguous reconciliation retry delay must be from 1000 ms through 24 hours.");
      }
    }
  }

  private assertWorkerId(workerId: string): void {
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(workerId)) {
      throw new Error("Worker id must be a bounded opaque identifier.");
    }
  }

  private isBoundedPlainText(value: string | undefined, maxLength: number): value is string {
    return (
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= maxLength &&
      !/[\u0000-\u001f\u007f]/.test(value)
    );
  }

  private isBoundedOpaqueReference(value: string): boolean {
    return /^[A-Za-z0-9._:-]{1,300}$/.test(value);
  }

  private decision(
    stage: RunDecision["stage"],
    state: RunDecision["state"],
    outcome: MergeOutcome,
    reason: string,
    now: number,
  ): RunDecision {
    return {
      stage,
      state,
      outcome,
      reason: reason.slice(0, 1_000),
      decidedAt: new Date(now).toISOString(),
    };
  }

  private assertLeaseDuration(leaseMs: number): void {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 3_000) {
      throw new Error("Lease duration must be an integer of at least 3000 milliseconds.");
    }
  }
}
