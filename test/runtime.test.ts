import assert from "node:assert/strict";
import test from "node:test";

import { assertRuntimePolicySafe, createRuntime, parseControllerPolicy } from "../src/runtime.js";

const policy = {
  allowedRepositories: ["acme/checkout-service"],
  autoMergeEnabled: false,
  mergeStrategy: "merge_queue",
  verification: {
    version: "v1",
    requiredCheckIds: ["unit", "reproduction"],
    requiredMetricNames: ["p95_latency_ms"],
    requireBugReproduction: true,
    requireAdversarialChecks: true,
    requireHunkClosure: true,
    metricThresholds: {
      p95_latency_ms: { maxRatio: 1.1, maxAbsolute: 500 },
    },
  },
  merge: {
    requiredApprovals: 1,
    requiredLabels: ["mergeproof:auto"],
    requiredChecks: ["ci / test"],
    mergeMethod: "squash",
  },
};

test("runtime accepts a complete, explicit controller policy", () => {
  assert.deepEqual(parseControllerPolicy(policy), policy);
  const withIssueToProof = {
    ...policy,
    verification: {
      ...policy.verification,
      issueToProof: {
        requireLinkedIssue: true,
        requiredObligationIds: ["reproduction"],
      },
    },
  };
  assert.deepEqual(parseControllerPolicy(withIssueToProof), withIssueToProof);
});

test("runtime rejects an incomplete or malformed policy", () => {
  assert.throws(
    () =>
      parseControllerPolicy({
        ...policy,
        allowedRepositories: ["not a repository"],
      }),
  );
  assert.throws(
    () =>
      parseControllerPolicy({
        ...policy,
        verification: {
          ...policy.verification,
          requiredMetricNames: ["made_up_metric"],
        },
      }),
  );
  assert.throws(
    () =>
      parseControllerPolicy({
        ...policy,
        verification: {
          ...policy.verification,
          issueToProof: { requireLinkedIssue: true, requiredObligationIds: [] },
        },
      }),
  );
  assert.throws(
    () =>
      parseControllerPolicy({
        ...policy,
        verification: {
          ...policy.verification,
          requiredMetricNames: ["p95_latency_ms", "p95_latency_ms"],
        },
      }),
    /unique/i,
  );
  assert.throws(
    () =>
      parseControllerPolicy({
        ...policy,
        merge: {
          ...policy.merge,
          requiredChecks: [],
        },
      }),
    /at least 1/i,
  );
  assert.throws(
    () =>
      parseControllerPolicy({
        ...policy,
        unexpectedDeploymentSetting: true,
      }),
    /unrecognized key/i,
  );
});

test("runtime requires source-pinned required checks before enabling merge-queue automation", () => {
  assert.throws(
    () =>
      assertRuntimePolicySafe(parseControllerPolicy({
        ...policy,
        autoMergeEnabled: true,
      })),
    /requires an App id for every required check/i,
  );
  assert.doesNotThrow(() =>
    assertRuntimePolicySafe(parseControllerPolicy({
      ...policy,
      autoMergeEnabled: true,
      merge: {
        ...policy.merge,
        requiredCheckAppIds: { "ci / test": 123 },
      },
    })),
  );
});

test("runtime rejects a policy that waits for its own final merge-group Check Run", () => {
  const parsed = parseControllerPolicy(policy);
  assert.throws(
    () =>
      assertRuntimePolicySafe({
        ...parsed,
        merge: {
          ...parsed.merge,
          requiredChecks: ["ci / test", "MergeProof / evidence"],
        },
        requiredEvidenceCheck: { name: "MergeProof / evidence", appId: 777 },
      }),
    /must not be listed in merge.requiredChecks/i,
  );
});

test("runtime never enables the direct fixture merge path", () => {
  assert.throws(
    () =>
      assertRuntimePolicySafe(parseControllerPolicy({
        ...policy,
        autoMergeEnabled: true,
        mergeStrategy: "direct_fixture",
      })),
    /never available in the runtime/i,
  );
});

test("runtime validates reconciliation concurrency before opening a service", () => {
  assert.throws(
    () => createRuntime({ MERGEPROOF_RECONCILIATION_CONCURRENCY: "17" }),
    /RECONCILIATION_CONCURRENCY/,
  );
});
