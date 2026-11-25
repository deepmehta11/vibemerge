import { DatabaseSync } from "node:sqlite";

import {
  normalizedClaimContractSchema,
  type CompiledClaimContract,
} from "./claim-compiler.js";
import { canonicalJson, sha256 } from "./crypto.js";
import type { ImpactMap } from "./impact-mapper.js";
import { evidenceIdentity } from "./proof-identity.js";
import type { CompiledProofPlan } from "./proof-plan.js";
import {
  parseTrustedReplayProfile,
  trustedReplayProfileDigest,
  type TrustedReplayProfile,
} from "./replay-profile.js";

const digestPattern = /^[a-f0-9]{64}$/;
const workerIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const defaultMaxBundleBytes = 2 * 1024 * 1024;

export interface ProofPlanningArtifacts {
  claimContract: CompiledClaimContract;
  impactMap: ImpactMap;
  proofPlan: CompiledProofPlan;
  replayProfile: TrustedReplayProfile;
}

/**
 * The immutable, normalized output of one planning identity. `evidenceKey`
 * binds every dynamic planning digest and is suitable for the execution ledger.
 */
export interface SealedProofPlanningBundle extends ProofPlanningArtifacts {
  schemaVersion: 1;
  analysisKey: string;
  evidenceKey: string;
}

export interface SealedProofPlanningRecord {
  analysisKey: string;
  bundle: SealedProofPlanningBundle;
  /** SHA-256 over canonical JSON of `bundle`. */
  bundleDigest: string;
  sealedAt: number;
}

export interface ProofPlanningLease {
  analysisKey: string;
  workerId: string;
  fenceToken: number;
  expiresAt: number;
}

export type ProofPlanningClaim =
  | { state: "claimed"; lease: ProofPlanningLease }
  | { state: "busy"; retryAt: number }
  | { state: "sealed"; record: SealedProofPlanningRecord };

export interface ProofPlanStoreOptions {
  maxBundleBytes?: number;
}

interface PlanningRow {
  analysis_key: string;
  status: "planning" | "sealed";
  fence_token: number;
  lease_owner: string | null;
  lease_until: number | null;
  bundle_json: string | null;
  bundle_digest: string | null;
  created_at: number;
  updated_at: number;
  sealed_at: number | null;
}

export class ProofPlanStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProofPlanStoreError";
  }
}

export class StaleProofPlanningLeaseError extends ProofPlanStoreError {
  constructor() {
    super("Proof planning lease is stale, expired, or owned by another worker.");
    this.name = "StaleProofPlanningLeaseError";
  }
}

export class ProofPlanningBundleTooLargeError extends ProofPlanStoreError {
  readonly actualBytes: number;
  readonly maxBytes: number;

  constructor(actualBytes: number, maxBytes: number) {
    super(`Proof planning bundle is ${actualBytes} bytes; maximum is ${maxBytes} bytes.`);
    this.name = "ProofPlanningBundleTooLargeError";
    this.actualBytes = actualBytes;
    this.maxBytes = maxBytes;
  }
}

export class ProofPlanStoreCorruptionError extends ProofPlanStoreError {
  constructor(message: string) {
    super(`Proof plan store is corrupt: ${message}`);
    this.name = "ProofPlanStoreCorruptionError";
  }
}

function assertDigest(value: string, label: string): string {
  if (!digestPattern.test(value)) {
    throw new ProofPlanStoreError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function assertWorkerId(value: string): string {
  if (!workerIdPattern.test(value) || value.includes("..") || /[\r\n\0]/.test(value)) {
    throw new ProofPlanStoreError("workerId must be a bounded stable identifier.");
  }
  return value;
}

function assertPositiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new ProofPlanStoreError(`${label} must be a positive safe integer.`);
  }
  return value;
}

function assertTimestamp(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProofPlanStoreError(`${label} must be a non-negative safe integer.`);
  }
  return value;
}

function expiresAt(now: number, leaseMs: number): number {
  assertTimestamp(now, "now");
  assertPositiveSafeInteger(leaseMs, "leaseMs");
  const expiration = now + leaseMs;
  if (!Number.isSafeInteger(expiration)) {
    throw new ProofPlanStoreError("Planning lease expiration exceeds the safe integer range.");
  }
  return expiration;
}

function cloneCanonical<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

function normalizedBundle(
  analysisKey: string,
  artifacts: ProofPlanningArtifacts,
): SealedProofPlanningBundle {
  const claimContract = normalizedClaimContractSchema.parse(artifacts.claimContract.contract);
  const claimContractDigest = sha256(canonicalJson(claimContract));
  if (claimContractDigest !== assertDigest(artifacts.claimContract.digest, "claimContract.digest")) {
    throw new ProofPlanStoreError("Claim contract digest does not match its normalized contents.");
  }

  const impactMap = cloneCanonical(artifacts.impactMap);
  if (
    impactMap.schemaVersion !== 1 ||
    (impactMap.status !== "complete" && impactMap.status !== "blocked")
  ) {
    throw new ProofPlanStoreError("Impact map is not a supported normalized report.");
  }
  const impactMapDigest = sha256(canonicalJson(impactMap));

  const proofPlan = cloneCanonical(artifacts.proofPlan.plan);
  const proofPlanDigest = sha256(canonicalJson(proofPlan));
  if (proofPlanDigest !== assertDigest(artifacts.proofPlan.digest, "proofPlan.digest")) {
    throw new ProofPlanStoreError("Proof plan digest does not match its normalized contents.");
  }

  const replayProfile = parseTrustedReplayProfile(artifacts.replayProfile);
  const replayProfileDigest = trustedReplayProfileDigest(replayProfile);
  const inputs = proofPlan.inputs;
  if (
    inputs.claimContractDigest !== claimContractDigest ||
    inputs.impactMapDigest !== impactMapDigest ||
    inputs.replayProfileDigest !== replayProfileDigest
  ) {
    throw new ProofPlanStoreError("Proof plan inputs do not match the artifacts being sealed.");
  }
  if (canonicalJson(proofPlan.revision) !== canonicalJson(claimContract.revision)) {
    throw new ProofPlanStoreError("Proof plan revision does not match the claim contract revision.");
  }

  const evidenceKey = evidenceIdentity({
    analysisKey,
    claimContractDigest,
    impactMapDigest,
    proofPlanDigest,
    replayProfileDigest,
  });
  return cloneCanonical({
    schemaVersion: 1,
    analysisKey,
    evidenceKey,
    claimContract: { contract: claimContract, digest: claimContractDigest },
    impactMap,
    proofPlan: { plan: proofPlan, digest: proofPlanDigest },
    replayProfile,
  });
}

/**
 * SQLite-backed coordination boundary for stochastic planning. Callers claim
 * an `analysisKey` before invoking a model, then seal one normalized bundle.
 * A sealed row is immutable and is returned by every later claim.
 */
export class ProofPlanStore {
  private readonly database: DatabaseSync;
  private readonly maxBundleBytes: number;

  constructor(path = ":memory:", options: ProofPlanStoreOptions = {}) {
    this.maxBundleBytes = options.maxBundleBytes ?? defaultMaxBundleBytes;
    assertPositiveSafeInteger(this.maxBundleBytes, "maxBundleBytes");
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA journal_mode = WAL;");
    this.database.exec("PRAGMA busy_timeout = 5000;");
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS proof_planning (
        analysis_key TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('planning', 'sealed')),
        fence_token INTEGER NOT NULL,
        lease_owner TEXT,
        lease_until INTEGER,
        bundle_json TEXT,
        bundle_digest TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        sealed_at INTEGER,
        CHECK (
          (status = 'planning' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL
            AND bundle_json IS NULL AND bundle_digest IS NULL AND sealed_at IS NULL)
          OR
          (status = 'sealed' AND lease_owner IS NOT NULL AND lease_until IS NULL
            AND bundle_json IS NOT NULL AND bundle_digest IS NOT NULL AND sealed_at IS NOT NULL)
        )
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_proof_planning_status_lease
        ON proof_planning(status, lease_until);
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

  private row(analysisKey: string): PlanningRow | undefined {
    return this.database
      .prepare("SELECT * FROM proof_planning WHERE analysis_key = ?")
      .get(analysisKey) as PlanningRow | undefined;
  }

  private sealedRecord(row: PlanningRow): SealedProofPlanningRecord {
    if (
      row.status !== "sealed" ||
      row.bundle_json === null ||
      row.bundle_digest === null ||
      row.sealed_at === null
    ) {
      throw new ProofPlanStoreCorruptionError(`sealed row ${row.analysis_key} is incomplete.`);
    }
    const bytes = Buffer.byteLength(row.bundle_json, "utf8");
    if (bytes > this.maxBundleBytes) {
      throw new ProofPlanStoreCorruptionError(
        `sealed row ${row.analysis_key} exceeds the configured JSON limit.`,
      );
    }
    const actualDigest = sha256(row.bundle_json);
    if (!digestPattern.test(row.bundle_digest) || actualDigest !== row.bundle_digest) {
      throw new ProofPlanStoreCorruptionError(`sealed row ${row.analysis_key} failed its digest.`);
    }
    let bundle: SealedProofPlanningBundle;
    try {
      bundle = JSON.parse(row.bundle_json) as SealedProofPlanningBundle;
    } catch {
      throw new ProofPlanStoreCorruptionError(`sealed row ${row.analysis_key} contains invalid JSON.`);
    }
    if (bundle.schemaVersion !== 1 || bundle.analysisKey !== row.analysis_key) {
      throw new ProofPlanStoreCorruptionError(`sealed row ${row.analysis_key} is not canonical.`);
    }
    let revalidated: SealedProofPlanningBundle;
    try {
      revalidated = normalizedBundle(row.analysis_key, bundle);
    } catch {
      throw new ProofPlanStoreCorruptionError(
        `sealed row ${row.analysis_key} contains inconsistent planning artifacts.`,
      );
    }
    if (canonicalJson(revalidated) !== row.bundle_json) {
      throw new ProofPlanStoreCorruptionError(`sealed row ${row.analysis_key} is not canonical.`);
    }
    return {
      analysisKey: row.analysis_key,
      bundle: revalidated,
      bundleDigest: row.bundle_digest,
      sealedAt: row.sealed_at,
    };
  }

  claim(
    analysisKey: string,
    workerId: string,
    leaseMs: number,
    now = Date.now(),
  ): ProofPlanningClaim {
    assertDigest(analysisKey, "analysisKey");
    assertWorkerId(workerId);
    const expiration = expiresAt(now, leaseMs);
    return this.transaction(() => {
      const current = this.row(analysisKey);
      if (current?.status === "sealed") {
        return { state: "sealed", record: this.sealedRecord(current) };
      }
      if (
        current?.status === "planning" &&
        current.lease_until !== null &&
        current.lease_until > now
      ) {
        return { state: "busy", retryAt: current.lease_until };
      }

      const fenceToken = (current?.fence_token ?? 0) + 1;
      this.database.prepare(`
        INSERT INTO proof_planning (
          analysis_key, status, fence_token, lease_owner, lease_until,
          bundle_json, bundle_digest, created_at, updated_at, sealed_at
        ) VALUES (?, 'planning', ?, ?, ?, NULL, NULL, ?, ?, NULL)
        ON CONFLICT(analysis_key) DO UPDATE SET
          status = 'planning',
          fence_token = excluded.fence_token,
          lease_owner = excluded.lease_owner,
          lease_until = excluded.lease_until,
          bundle_json = NULL,
          bundle_digest = NULL,
          updated_at = excluded.updated_at,
          sealed_at = NULL
      `).run(analysisKey, fenceToken, workerId, expiration, now, now);
      return {
        state: "claimed",
        lease: { analysisKey, workerId, fenceToken, expiresAt: expiration },
      };
    });
  }

  renew(
    lease: ProofPlanningLease,
    leaseMs: number,
    now = Date.now(),
  ): ProofPlanningLease {
    assertDigest(lease.analysisKey, "lease.analysisKey");
    assertWorkerId(lease.workerId);
    assertPositiveSafeInteger(lease.fenceToken, "lease.fenceToken");
    const requestedExpiration = expiresAt(now, leaseMs);
    return this.transaction(() => {
      const current = this.row(lease.analysisKey);
      if (
        current?.status !== "planning" ||
        current.lease_owner !== lease.workerId ||
        current.fence_token !== lease.fenceToken ||
        current.lease_until === null ||
        current.lease_until <= now
      ) {
        throw new StaleProofPlanningLeaseError();
      }
      const expiration = Math.max(current.lease_until, requestedExpiration);
      this.database.prepare(`
        UPDATE proof_planning SET lease_until = ?, updated_at = ?
        WHERE analysis_key = ?
      `).run(expiration, now, lease.analysisKey);
      return { ...lease, expiresAt: expiration };
    });
  }

  seal(
    lease: ProofPlanningLease,
    artifacts: ProofPlanningArtifacts,
    now = Date.now(),
  ): SealedProofPlanningRecord {
    assertDigest(lease.analysisKey, "lease.analysisKey");
    assertWorkerId(lease.workerId);
    assertPositiveSafeInteger(lease.fenceToken, "lease.fenceToken");
    assertTimestamp(now, "now");
    const bundle = normalizedBundle(lease.analysisKey, artifacts);
    const bundleJson = canonicalJson(bundle);
    const bundleBytes = Buffer.byteLength(bundleJson, "utf8");
    if (bundleBytes > this.maxBundleBytes) {
      throw new ProofPlanningBundleTooLargeError(bundleBytes, this.maxBundleBytes);
    }
    const bundleDigest = sha256(bundleJson);

    return this.transaction(() => {
      const current = this.row(lease.analysisKey);
      if (
        !current ||
        current.lease_owner !== lease.workerId ||
        current.fence_token !== lease.fenceToken
      ) {
        throw new StaleProofPlanningLeaseError();
      }
      if (current.status === "sealed") {
        const record = this.sealedRecord(current);
        if (record.bundleDigest !== bundleDigest) {
          throw new ProofPlanStoreError(
            "The winning planning lease is already sealed with a different bundle.",
          );
        }
        return record;
      }
      if (current.lease_until === null || current.lease_until <= now) {
        throw new StaleProofPlanningLeaseError();
      }

      const result = this.database.prepare(`
        UPDATE proof_planning SET
          status = 'sealed', lease_until = NULL,
          bundle_json = ?, bundle_digest = ?, sealed_at = ?, updated_at = ?
        WHERE analysis_key = ? AND status = 'planning'
          AND lease_owner = ? AND fence_token = ? AND lease_until > ?
      `).run(
        bundleJson,
        bundleDigest,
        now,
        now,
        lease.analysisKey,
        lease.workerId,
        lease.fenceToken,
        now,
      );
      if (result.changes !== 1) throw new StaleProofPlanningLeaseError();
      const sealed = this.row(lease.analysisKey);
      if (!sealed) throw new ProofPlanStoreCorruptionError("sealed row disappeared.");
      return this.sealedRecord(sealed);
    });
  }

  getSealed(analysisKey: string): SealedProofPlanningRecord | null {
    assertDigest(analysisKey, "analysisKey");
    const current = this.row(analysisKey);
    return current?.status === "sealed" ? this.sealedRecord(current) : null;
  }

  close(): void {
    this.database.close();
  }
}
