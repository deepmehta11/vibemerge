/**
 * Time limits owned by the controller rather than a checked-out repository.
 * The shell harness mirrors these bounds so a mounted specification cannot
 * reserve more E2B lifetime than the runtime has leased.
 */
export const DEFAULT_TRUSTED_PROBE_TIMEOUT_MS = 60_000;
export const MAX_TRUSTED_PROBE_TIMEOUT_MS = 5 * 60_000;
export const MAX_TRUSTED_HARNESS_CHECKS = 32;
export const MAX_TRUSTED_HARNESS_METRICS = 32;
export const MAX_TRUSTED_WORKLOAD_REPETITIONS = 10;
export const MAX_TRUSTED_WORKLOAD_PROFILE_BUDGET_MS = 5 * 60_000;
/** Four bounded archive operations in the trusted harness: 30s + 30s + 60s + 30s. */
export const TRUSTED_ARCHIVE_PREPARATION_BUDGET_MS = 150_000;
/** Accounts for E2B creation plus controller-mounted archive, harness, and probe uploads. */
export const TRUSTED_SANDBOX_SETUP_ALLOWANCE_MS = 2 * 60_000;
/** Prevents a trusted but accidentally expansive specification from monopolizing a worker. */
export const MAX_TRUSTED_PROBE_BUDGET_MS = 20 * 60_000;
export const MAX_TRUSTED_SANDBOX_TIMEOUT_MS =
  TRUSTED_ARCHIVE_PREPARATION_BUDGET_MS +
  MAX_TRUSTED_PROBE_BUDGET_MS +
  TRUSTED_SANDBOX_SETUP_ALLOWANCE_MS;
/** Covers the planner, token minting, and durable receipt/check publication around E2B. */
export const TRUSTED_VERIFICATION_CONTROLLER_ALLOWANCE_MS = 5 * 60_000;

export interface TrustedHarnessBudget {
  /** Sum of all trusted probe deadlines for one base or candidate phase. */
  probeBudgetMs: number;
  /** Archive preparation plus the complete trusted probe schedule. */
  commandBudgetMs: number;
  /** E2B lifetime from creation through controller uploads and command completion. */
  sandboxTimeoutMs: number;
  /** Durable run lease that remains valid through the sandbox and controller work. */
  verificationLeaseMs: number;
}

type JsonRecord = Record<string, unknown>;

function assertRecord(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as JsonRecord;
}

function assertBoundedArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must contain at most ${maximum} entries.`);
  }
  return value;
}

function probeTimeout(value: unknown, label: string): number {
  if (value === undefined) {
    return DEFAULT_TRUSTED_PROBE_TIMEOUT_MS;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TRUSTED_PROBE_TIMEOUT_MS
  ) {
    throw new Error(
      `${label} must be an integer from 1 through ${MAX_TRUSTED_PROBE_TIMEOUT_MS} milliseconds.`,
    );
  }
  return value;
}

function metricRepetitions(value: unknown, timeoutMs: number, label: string): number {
  if (value === undefined) {
    return 1;
  }
  const profile = assertRecord(value, label);
  const repetitions = profile.repetitions;
  if (
    typeof repetitions !== "number" ||
    !Number.isSafeInteger(repetitions) ||
    repetitions < 2 ||
    repetitions > MAX_TRUSTED_WORKLOAD_REPETITIONS
  ) {
    throw new Error(
      `${label}.repetitions must be a fixed integer from 2 through ${MAX_TRUSTED_WORKLOAD_REPETITIONS}.`,
    );
  }
  if (profile.aggregation !== "max") {
    throw new Error(`${label}.aggregation must be the conservative value "max".`);
  }
  if (timeoutMs * repetitions > MAX_TRUSTED_WORKLOAD_PROFILE_BUDGET_MS) {
    throw new Error(
      `${label} exceeds the ${MAX_TRUSTED_WORKLOAD_PROFILE_BUDGET_MS}ms bounded profile budget.`,
    );
  }
  return repetitions;
}

function addProbeBudget(current: number, addition: number): number {
  const next = current + addition;
  if (!Number.isSafeInteger(next) || next > MAX_TRUSTED_PROBE_BUDGET_MS) {
    throw new Error(
      `Harness specification exceeds the ${MAX_TRUSTED_PROBE_BUDGET_MS}ms total trusted probe budget.`,
    );
  }
  return next;
}

/**
 * Parses only controller-owned timeout semantics from the mounted spec. The
 * regular trusted harness still validates probes and result shape, but both
 * surfaces deliberately share the same timing bounds.
 */
export function deriveTrustedHarnessBudget(raw: Uint8Array | string): TrustedHarnessBudget {
  let decoded: unknown;
  try {
    decoded = JSON.parse(
      typeof raw === "string" ? raw : new TextDecoder().decode(raw),
    ) as unknown;
  } catch {
    throw new Error("Harness specification must be valid JSON before E2B starts.");
  }

  const spec = assertRecord(decoded, "Harness specification");
  const checks = assertBoundedArray(
    spec.checks,
    "Harness specification checks",
    MAX_TRUSTED_HARNESS_CHECKS,
  );
  const metrics = assertBoundedArray(
    spec.metrics,
    "Harness specification metrics",
    MAX_TRUSTED_HARNESS_METRICS,
  );

  let probeBudgetMs = 0;
  for (const [index, item] of checks.entries()) {
    const check = assertRecord(item, `checks[${index}]`);
    probeBudgetMs = addProbeBudget(
      probeBudgetMs,
      probeTimeout(check.timeoutMs, `checks[${index}].timeoutMs`),
    );
  }
  for (const [index, item] of metrics.entries()) {
    const metric = assertRecord(item, `metrics[${index}]`);
    const timeoutMs = probeTimeout(metric.timeoutMs, `metrics[${index}].timeoutMs`);
    probeBudgetMs = addProbeBudget(
      probeBudgetMs,
      timeoutMs * metricRepetitions(
        metric.workloadProfile,
        timeoutMs,
        `metrics[${index}].workloadProfile`,
      ),
    );
  }

  const commandBudgetMs = TRUSTED_ARCHIVE_PREPARATION_BUDGET_MS + probeBudgetMs;
  const sandboxTimeoutMs = commandBudgetMs + TRUSTED_SANDBOX_SETUP_ALLOWANCE_MS;
  if (sandboxTimeoutMs > MAX_TRUSTED_SANDBOX_TIMEOUT_MS) {
    throw new Error(
      `Harness specification exceeds the ${MAX_TRUSTED_SANDBOX_TIMEOUT_MS}ms total sandbox budget.`,
    );
  }
  return {
    probeBudgetMs,
    commandBudgetMs,
    sandboxTimeoutMs,
    verificationLeaseMs:
      sandboxTimeoutMs + TRUSTED_VERIFICATION_CONTROLLER_ALLOWANCE_MS,
  };
}

/** Ensures a configured lease cannot expire before its corresponding E2B lifetime. */
export function assertVerificationLeaseCoversSandbox(
  sandboxTimeoutMs: number,
  verificationLeaseMs: number,
): void {
  if (
    !Number.isSafeInteger(sandboxTimeoutMs) ||
    sandboxTimeoutMs < 1 ||
    sandboxTimeoutMs > MAX_TRUSTED_SANDBOX_TIMEOUT_MS
  ) {
    throw new Error(
      `E2B sandbox timeout must be an integer from 1 through ${MAX_TRUSTED_SANDBOX_TIMEOUT_MS} milliseconds.`,
    );
  }
  if (
    !Number.isSafeInteger(verificationLeaseMs) ||
    verificationLeaseMs < sandboxTimeoutMs + TRUSTED_VERIFICATION_CONTROLLER_ALLOWANCE_MS
  ) {
    throw new Error(
      "Verification lease must cover the full E2B sandbox timeout plus the controller allowance.",
    );
  }
}
