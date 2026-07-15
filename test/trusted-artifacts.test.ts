import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { policyDigest, trustedArtifactDigestForPolicy } from "../src/controller.js";
import { revisionRunKey } from "../src/crypto.js";
import { demoMergePolicy, demoVerificationPolicy } from "../src/fixtures.js";
import {
  assertImmutableE2BTemplate,
  trustedArtifactDigest,
} from "../src/trusted-artifacts.js";
import { createRuntime, loadTrustedArtifactBundle } from "../src/runtime.js";

const template = "mergeproof/verification:9da75bfa-9c4f-4d72-8777-2ad37dd881b5";

test("trusted artifact digest is sorted, byte-exact, and includes the pinned E2B build", () => {
  const files = {
    "/workspace/probes/regression.mjs": Buffer.from("export const probe = 'v1';\n"),
    "/workspace/mergeproof-harness.json": Buffer.from('{"version":"v1"}\n'),
    "/workspace/mergeproof-harness.mjs": Buffer.from("export {};\n"),
  };
  const first = trustedArtifactDigest({
    template,
    command: "node /workspace/mergeproof-harness.mjs",
    workspaceFiles: files,
  });
  const reordered = trustedArtifactDigest({
    template,
    command: "node /workspace/mergeproof-harness.mjs",
    workspaceFiles: {
      "/workspace/mergeproof-harness.mjs": files["/workspace/mergeproof-harness.mjs"]!,
      "/workspace/probes/regression.mjs": files["/workspace/probes/regression.mjs"]!,
      "/workspace/mergeproof-harness.json": files["/workspace/mergeproof-harness.json"]!,
    },
  });
  const changedProbe = trustedArtifactDigest({
    template,
    command: "node /workspace/mergeproof-harness.mjs",
    workspaceFiles: {
      ...files,
      "/workspace/probes/regression.mjs": Buffer.from("export const probe = 'v2';\n"),
    },
  });
  const changedTemplate = trustedArtifactDigest({
    template: "mergeproof/verification:1a565e23-6e84-477d-ac39-5cd2ad03c1d3",
    command: "node /workspace/mergeproof-harness.mjs",
    workspaceFiles: files,
  });

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(first, reordered);
  assert.notEqual(first, changedProbe);
  assert.notEqual(first, changedTemplate);
});

test("runtime bundle changes identity when a mounted trusted artifact changes", () => {
  const directory = mkdtempSync(join(tmpdir(), "mergeproof-trusted-artifacts-"));
  try {
    const probes = join(directory, "probes");
    const harness = join(directory, "mergeproof-harness.mjs");
    const spec = join(directory, "mergeproof-harness.json");
    mkdirSync(probes);
    writeFileSync(harness, "export {};\n");
    writeFileSync(
      spec,
      JSON.stringify({
        version: "runtime-timeout-budget-v1",
        checks: Array.from({ length: 5 }, (_, index) => ({
          id: `check-${index}`,
          kind: "deterministic_gate",
          required: true,
          probe: "regression.mjs",
          detail: "A trusted check.",
          timeoutMs: 60_000,
        })),
        metrics: ["p95_latency_ms", "peak_memory_mb"].map((name) => ({
          name,
          required: true,
          probe: "regression.mjs",
          detail: "A trusted metric.",
          timeoutMs: 60_000,
          workloadProfile: { repetitions: 5, aggregation: "max" },
        })),
      }),
    );
    writeFileSync(join(probes, "regression.mjs"), "export const expected = 'one';\n");

    const input = {
      template,
      command: "node /workspace/mergeproof-harness.mjs",
      trustedHarnessPath: harness,
      harnessSpecPath: spec,
      trustedProbeDirectory: probes,
    };
    const first = loadTrustedArtifactBundle(input);
    writeFileSync(join(probes, "regression.mjs"), "export const expected = 'two';\n");
    const second = loadTrustedArtifactBundle(input);

    assert.notEqual(first.digest, second.digest);
    assert.equal(first.workspaceFiles["/workspace/probes/regression.mjs"] instanceof Uint8Array, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime injects the mounted artifact digest into its controller policy identity", () => {
  const directory = mkdtempSync(join(tmpdir(), "mergeproof-runtime-artifacts-"));
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "fixture-openai-key";
  try {
    const probes = join(directory, "probes");
    const harness = join(directory, "mergeproof-harness.mjs");
    const spec = join(directory, "mergeproof-harness.json");
    const policyPath = join(directory, "mergeproof-policy.json");
    mkdirSync(probes);
    writeFileSync(harness, "export {};\n");
    writeFileSync(
      spec,
      JSON.stringify({
        version: "runtime-timeout-budget-v1",
        checks: Array.from({ length: 5 }, (_, index) => ({
          id: `check-${index}`,
          kind: "deterministic_gate",
          required: true,
          probe: "regression.mjs",
          detail: "A trusted check.",
          timeoutMs: 60_000,
        })),
        metrics: ["p95_latency_ms", "peak_memory_mb"].map((name) => ({
          name,
          required: true,
          probe: "regression.mjs",
          detail: "A trusted metric.",
          timeoutMs: 60_000,
          workloadProfile: { repetitions: 5, aggregation: "max" },
        })),
      }),
    );
    writeFileSync(join(probes, "regression.mjs"), "export const expected = 'one';\n");
    writeFileSync(
      policyPath,
      JSON.stringify({
        allowedRepositories: ["acme/checkout-service"],
        autoMergeEnabled: false,
        mergeStrategy: "merge_queue",
        verification: demoVerificationPolicy,
        merge: demoMergePolicy,
      }),
    );
    const env = {
      MERGEPROOF_POLICY_PATH: policyPath,
      MERGEPROOF_E2B_TEMPLATE: template,
      MERGEPROOF_HARNESS_COMMAND: "node /workspace/mergeproof-harness.mjs",
      MERGEPROOF_TRUSTED_HARNESS_PATH: harness,
      MERGEPROOF_TRUSTED_PROBES_DIR: probes,
      MERGEPROOF_HARNESS_SPEC_PATH: spec,
      MERGEPROOF_DB_PATH: ":memory:",
      MERGEPROOF_RECONCILIATION_CONCURRENCY: "3",
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY: "fixture-private-key",
      GITHUB_WEBHOOK_SECRET: "fixture-webhook-secret",
      PORT: "3000",
    };
    const expected = loadTrustedArtifactBundle({
      template,
      command: env.MERGEPROOF_HARNESS_COMMAND,
      trustedHarnessPath: harness,
      trustedProbeDirectory: probes,
      harnessSpecPath: spec,
    }).digest;
    const runtime = createRuntime(env);
    try {
      assert.equal(runtime.trustedArtifactDigest, expected);
      assert.equal(runtime.verificationLeaseMs, 1_470_000);
      assert.equal(runtime.reconciliationConcurrency, 3);
      assert.equal(runtime.reconcilers.length, 3);
      assert.equal(new Set(runtime.reconcilers.map((worker) => worker.workerId)).size, 3);
    } finally {
      runtime.ledger.close();
    }
  } finally {
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("template aliases and tags are rejected before production runtime starts", () => {
  assert.equal(assertImmutableE2BTemplate(template), template);
  for (const mutable of ["base", "mergeproof/verification", "mergeproof/verification:latest", "mergeproof/verification:v1"]) {
    assert.throws(() => assertImmutableE2BTemplate(mutable), /immutable E2B build/i);
  }
});

test("trusted artifact digest changes both controller policy and evidence run identity", () => {
  const policy = {
    allowedRepositories: ["acme/checkout-service"],
    autoMergeEnabled: false,
    mergeStrategy: "merge_queue" as const,
    verification: demoVerificationPolicy,
    merge: demoMergePolicy,
  };
  const before = { ...policy, trustedArtifactDigest: "a".repeat(64) };
  const after = { ...policy, trustedArtifactDigest: "b".repeat(64) };
  const baseRevision = {
    repository: "acme/checkout-service",
    pullRequest: 42,
    baseSha: "base",
    headSha: "head",
    mergeSha: "merge",
  };

  assert.notEqual(policyDigest(before), policyDigest(after));
  assert.notEqual(
    revisionRunKey({
      ...baseRevision,
      policyHash: policyDigest(before),
      trustedArtifactDigest: trustedArtifactDigestForPolicy(before),
    }),
    revisionRunKey({
      ...baseRevision,
      policyHash: policyDigest(after),
      trustedArtifactDigest: trustedArtifactDigestForPolicy(after),
    }),
  );
});
