import type {
  HarnessResult,
  MergePolicy,
  PinnedRevision,
  VerificationPolicy,
} from "./domain.js";
import type { FixtureScenario } from "./harness.js";

export const demoRevision: PinnedRevision = {
  repository: "acme/checkout-service",
  pullRequest: 42,
  baseSha: "base-7b7e1c2",
  headSha: "head-9e4ab31",
  mergeSha: "merge-9912df0",
  policyHash: "policy-2026-07-14",
  trustedArtifactDigest: "fixture-artifacts",
};

export const demoVerificationPolicy: VerificationPolicy = {
  version: "2026-07-14",
  requiredCheckIds: [
    "ci",
    "issue-reproduction",
    "checkout-invariants",
    "duplicate-race",
    "changed-hunks",
  ],
  requiredMetricNames: ["p95_latency_ms", "peak_memory_mb"],
  requireBugReproduction: true,
  requireAdversarialChecks: true,
  requireHunkClosure: true,
  metricThresholds: {
    p95_latency_ms: { maxRatio: 1.15, maxAbsolute: 120 },
    peak_memory_mb: { maxRatio: 1.2, maxAbsolute: 256 },
    cpu_ms: { maxRatio: 1.2, maxAbsolute: 200 },
    error_rate: { maxRatio: 1.05, maxAbsolute: 0.01 },
  },
};

export const demoMergePolicy: MergePolicy = {
  requiredApprovals: 1,
  requiredLabels: ["mergeproof:auto"],
  requiredChecks: ["ci / test", "ci / security"],
  mergeMethod: "squash",
};

function result(
  phase: "base" | "candidate",
  overrides: Partial<HarnessResult> = {},
): Omit<HarnessResult, "phase" | "sandboxId"> {
  const isBase = phase === "base";
  return {
    harnessVersion: "fixture-v1",
    checks: [
      {
        id: "ci",
        kind: "deterministic_gate",
        required: true,
        status: "pass",
        detail: "Build, typecheck, protected tests, and security checks passed.",
      },
      {
        id: "issue-reproduction",
        kind: "bug_reproduction",
        required: true,
        status: isBase ? "fail" : "pass",
        detail: "Duplicate checkout request must be rejected after one accepted payment.",
      },
      {
        id: "checkout-invariants",
        kind: "protected_behavior",
        required: true,
        status: "pass",
        detail: "Existing authorization, retry, and audit invariants hold.",
      },
      {
        id: "duplicate-race",
        kind: "adversarial",
        required: true,
        status: "pass",
        detail: "Parallel duplicate requests leave exactly one settled payment.",
      },
      {
        id: "changed-hunks",
        kind: "hunk_closure",
        required: true,
        status: "pass",
        detail: "Every high-risk changed hunk is covered by an observed obligation.",
      },
    ],
    metrics: [
      {
        name: "p95_latency_ms",
        required: true,
        value: isBase ? 90 : 94,
        detail: "100 concurrent checkout requests, five repetitions.",
      },
      {
        name: "peak_memory_mb",
        required: true,
        value: isBase ? 120 : 128,
        detail: "Peak resident memory under the same profile.",
      },
    ],
    ...overrides,
  };
}

export function safeFixture(): FixtureScenario {
  return { base: result("base"), candidate: result("candidate") };
}

export function incompleteFixture(): FixtureScenario {
  const candidate = result("candidate");
  candidate.checks = candidate.checks.map((check) =>
    check.id === "issue-reproduction" ? { ...check, status: "unknown" } : check,
  );
  return { base: result("base"), candidate };
}

export function resourceRegressionFixture(): FixtureScenario {
  const candidate = result("candidate");
  candidate.metrics = candidate.metrics.map((metric) =>
    metric.name === "p95_latency_ms" ? { ...metric, value: 140 } : metric,
  );
  return { base: result("base"), candidate };
}
