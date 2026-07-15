import assert from "node:assert/strict";
import test from "node:test";

import { E2BSourceHarnessFactory } from "../src/e2b-harness.js";
import {
  DEFAULT_E2B_SANDBOX_TIMEOUT_MS,
} from "../src/e2b-harness.js";
import {
  deriveTrustedHarnessBudget,
  MAX_TRUSTED_PROBE_BUDGET_MS,
  TRUSTED_ARCHIVE_PREPARATION_BUDGET_MS,
  TRUSTED_SANDBOX_SETUP_ALLOWANCE_MS,
  TRUSTED_VERIFICATION_CONTROLLER_ALLOWANCE_MS,
} from "../src/harness-budget.js";

const fiveChecksAndTwoProfiles = {
  version: "timeout-budget-v1",
  checks: Array.from({ length: 5 }, (_, index) => ({
    id: `check-${index}`,
    timeoutMs: 60_000,
  })),
  metrics: ["p95_latency_ms", "peak_memory_mb"].map((name) => ({
    name,
    timeoutMs: 60_000,
    workloadProfile: { repetitions: 5, aggregation: "max" },
  })),
};

test("trusted timeout budget gives the complete mounted spec more than the legacy ten-minute sandbox", () => {
  const budget = deriveTrustedHarnessBudget(JSON.stringify(fiveChecksAndTwoProfiles));

  assert.equal(budget.probeBudgetMs, 900_000);
  assert.equal(
    budget.commandBudgetMs,
    TRUSTED_ARCHIVE_PREPARATION_BUDGET_MS + budget.probeBudgetMs,
  );
  assert.equal(
    budget.sandboxTimeoutMs,
    budget.commandBudgetMs + TRUSTED_SANDBOX_SETUP_ALLOWANCE_MS,
  );
  assert.equal(
    budget.verificationLeaseMs,
    budget.sandboxTimeoutMs + TRUSTED_VERIFICATION_CONTROLLER_ALLOWANCE_MS,
  );
  assert.ok(budget.sandboxTimeoutMs > DEFAULT_E2B_SANDBOX_TIMEOUT_MS);
});

test("trusted timeout budget rejects aggregate probe schedules that could monopolize a worker", () => {
  const overBudget = {
    version: "too-slow-v1",
    checks: [],
    metrics: Array.from({ length: 5 }, (_, index) => ({
      name: `metric-${index}`,
      timeoutMs: 60_000,
      workloadProfile: { repetitions: 5, aggregation: "max" },
    })),
  };
  assert.throws(
    () => deriveTrustedHarnessBudget(JSON.stringify(overBudget)),
    new RegExp(`${MAX_TRUSTED_PROBE_BUDGET_MS}ms total trusted probe budget`),
  );
});

test("source harness factories reject a lease that can expire before their sandbox", () => {
  assert.throws(
    () => new E2BSourceHarnessFactory(
      {
        command: "node /workspace/mergeproof-harness.mjs",
        timeoutMs: DEFAULT_E2B_SANDBOX_TIMEOUT_MS,
        verificationLeaseMs: DEFAULT_E2B_SANDBOX_TIMEOUT_MS,
      },
      { fetchArchive: async () => new Uint8Array() },
    ),
    /lease must cover the full E2B sandbox timeout/i,
  );
});
