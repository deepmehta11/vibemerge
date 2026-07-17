import assert from "node:assert/strict";
import test from "node:test";

import {
  type ClaimContractCandidate,
  type SanitizedClaimCompilerInput,
} from "../src/claim-compiler.js";
import {
  ClaimProofCoordinator,
  ClaimProofPreparationInputError,
  type PrepareClaimProofInput,
} from "../src/claim-proof-coordinator.js";
import { sha256 } from "../src/crypto.js";
import { ProofPlanStore } from "../src/proof-plan-store.js";
import { parseTrustedReplayProfile } from "../src/replay-profile.js";
import type {
  RepositorySnapshotProvider,
  RepositorySnapshotRequest,
} from "../src/repository-snapshot.js";

const authority = {
  class: "REPOSITORY_POLICY",
  reference: "policy:retry-proof-v1",
} as const;
const baseSha = "a".repeat(40);
const headSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
const diff = [
  "diff --git a/src/jobs.ts b/src/jobs.ts",
  "--- a/src/jobs.ts",
  "+++ b/src/jobs.ts",
  "@@ -1,3 +1,4 @@",
  " export function retryJob(seen: boolean) {",
  "+  if (seen) return 'existing';",
  "   return 'new';",
  " }",
  "",
].join("\n");
const repositoryFiles = [
  {
    path: "src/jobs.ts",
    content: [
      "export function retryJob(seen: boolean) {",
      "  if (seen) return 'existing';",
      "  return 'new';",
      "}",
      "",
    ].join("\n"),
  },
  {
    path: "src/server.ts",
    content: [
      "import { retryJob } from './jobs.js';",
      "export function retryRoute() {",
      "  return retryJob(true);",
      "}",
      "",
    ].join("\n"),
  },
];

function replay(id: string, fixtureId: string) {
  return {
    id,
    claimIds: ["retry-idempotent"],
    setup: { fixtures: [{ name: "job", fixtureId }] },
    requests: [{ id: "retry", method: "POST" as const, path: "/jobs/job-42/retry", query: [] }],
    assertions: [{
      id: "image-count",
      kind: "state" as const,
      fixture: "job",
      path: "/imageCount",
      predicate: { operator: "equals" as const, expected: 1 },
    }],
  };
}

function candidate(input: SanitizedClaimCompilerInput): ClaimContractCandidate {
  return {
    schemaVersion: 1,
    revision: input.revision,
    expectedBehaviors: [{
      id: "retry-idempotent",
      when: "the same image job is retried",
      then: "one image and one charge exist",
      authority,
      supportingAuthorities: [],
      mandatory: true,
    }],
    invariants: [],
    failureSignatures: [],
    positiveControls: [{
      id: "single-submit",
      description: "one submission succeeds",
      claimIds: ["retry-idempotent"],
      replayPlanId: "positive",
      authority,
      supportingAuthorities: [],
      mandatory: true,
    }],
    negativeControls: [{
      id: "duplicate-detector",
      description: "duplicates are detected",
      claimIds: ["retry-idempotent"],
      replayPlanId: "negative",
      authority,
      supportingAuthorities: [],
      mandatory: true,
    }],
    ambiguities: [],
    replayPlans: [
      replay("primary", "empty"),
      replay("positive", "single"),
      replay("negative", "duplicate"),
    ],
  };
}

function profile(version = "retry-v1") {
  const fixture = (id: string) => ({
    id,
    setupEndpoint: { method: "POST" as const, path: `/__proof/setup/${id}`, expectedStatus: 204 },
    stateEndpoint: { method: "GET" as const, path: `/__proof/state/${id}`, expectedStatus: 200 },
  });
  return parseTrustedReplayProfile({
    schemaVersion: 1,
    version,
    application: {
      runtime: "node",
      cwd: ".",
      executable: "node",
      args: ["src/server.mjs"],
      env: { NODE_ENV: "test" },
      port: 4_321,
      health: {
        method: "GET",
        path: "/healthz",
        expectedStatus: 200,
        timeoutMs: 5_000,
        intervalMs: 50,
      },
      shutdownGraceMs: 500,
    },
    operations: [{ id: "retry-job", method: "POST", pathTemplate: "/jobs/job-42/retry", allowedQueryKeys: [], allowedBodyKeys: [], maxInvocations: 1 }],
    fixtures: [fixture("empty"), fixture("single"), fixture("duplicate")],
  });
}

function preparationInput(overrides: Partial<PrepareClaimProofInput> = {}): PrepareClaimProofInput {
  return {
    repository: "mergeproof/demo",
    pullRequest: 42,
    baseSha,
    headSha,
    mergeSha,
    title: "Fix duplicate image generation on retry",
    description: "Retrying the same job must create only one image and charge.",
    diff,
    githubReadToken: "github-installation-read-token",
    trustedAuthorityReferences: [authority],
    baseContractDigest: sha256("base-contract"),
    policyHash: sha256("policy"),
    trustedArtifactDigest: sha256("trusted-artifacts"),
    compiler: {
      model: "gpt-5.4",
      schemaVersion: 1,
      toolVersion: "claim-compiler-v1",
    },
    replayProfile: profile(),
    workerId: "planner-a",
    leaseMs: 60_000,
    ...overrides,
  };
}

test("claims before model use, snapshots the exact merge SHA, seals evidence, and reuses it", async () => {
  const store = new ProofPlanStore();
  const snapshotRequests: RepositorySnapshotRequest[] = [];
  const compilerInputs: SanitizedClaimCompilerInput[] = [];
  const snapshotProvider: RepositorySnapshotProvider = {
    async fetchFiles(input) {
      snapshotRequests.push(input);
      return repositoryFiles;
    },
  };
  const coordinator = new ClaimProofCoordinator({
    proofPlanStore: store,
    repositorySnapshotProvider: snapshotProvider,
    claimCompilerProvider: {
      async compile(input) {
        compilerInputs.push(input);
        return candidate(input);
      },
    },
    clock: () => 1_000,
  });

  try {
    const input = preparationInput();
    const first = await coordinator.prepare(input);
    assert.equal(first.state, "prepared");
    if (first.state !== "prepared") return;
    assert.equal(first.source, "created");
    assert.equal(first.record.bundle.evidenceKey, first.evidenceKey);
    assert.equal(first.record.bundle.analysisKey, first.analysisKey);
    assert.match(first.analysisKey, /^[a-f0-9]{64}$/);
    assert.match(first.evidenceKey, /^[a-f0-9]{64}$/);
    assert.equal(first.record.bundle.proofPlan.plan.revision.headSha, headSha);
    assert.equal(first.record.bundle.impactMap.status, "complete");
    assert.ok(first.record.bundle.impactMap.changedSymbols.some(({ name }) => name === "retryJob"));
    assert.deepEqual(snapshotRequests, [{
      repository: "mergeproof/demo",
      sha: mergeSha,
      githubReadToken: input.githubReadToken,
    }]);
    assert.equal(compilerInputs.length, 1);
    const serializedCompilerInput = JSON.stringify(compilerInputs[0]);
    assert.ok(serializedCompilerInput.includes(input.title));
    assert.ok(serializedCompilerInput.includes("/jobs/job-42/retry"));
    assert.ok(serializedCompilerInput.includes("empty"));
    assert.ok(!serializedCompilerInput.includes(input.githubReadToken));
    assert.ok(!serializedCompilerInput.includes("diff --git"));

    const retry = await coordinator.prepare({ ...input, workerId: "planner-b" });
    assert.equal(retry.state, "prepared");
    if (retry.state !== "prepared") return;
    assert.equal(retry.source, "reused");
    assert.deepEqual(retry.record, first.record);
    assert.equal(snapshotRequests.length, 1, "sealed retries must not fetch source again");
    assert.equal(compilerInputs.length, 1, "sealed retries must not invoke the compiler again");
  } finally {
    store.close();
  }
});

test("returns a deterministic busy result while the winning planning lease is active", async () => {
  const store = new ProofPlanStore();
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => {
    releaseSnapshot = resolve;
  });
  let compilerCalls = 0;
  const coordinator = new ClaimProofCoordinator({
    proofPlanStore: store,
    repositorySnapshotProvider: {
      async fetchFiles() {
        await snapshotGate;
        return repositoryFiles;
      },
    },
    claimCompilerProvider: {
      async compile(input) {
        compilerCalls += 1;
        return candidate(input);
      },
    },
    clock: () => 5_000,
  });

  try {
    const input = preparationInput({ leaseMs: 30_000 });
    const winningPreparation = coordinator.prepare(input);
    const busy = await coordinator.prepare({ ...input, workerId: "planner-b" });
    assert.deepEqual(busy, {
      state: "busy",
      analysisKey: busy.analysisKey,
      retryAt: 35_000,
    });
    assert.match(busy.analysisKey, /^[a-f0-9]{64}$/);
    assert.equal(compilerCalls, 0, "the busy worker must not invoke the compiler");

    releaseSnapshot();
    const winner = await winningPreparation;
    assert.equal(winner.state, "prepared");
    assert.equal(compilerCalls, 1);
  } finally {
    releaseSnapshot();
    store.close();
  }
});

test("compiler and replay-profile identities are part of the durable planning key", async () => {
  const store = new ProofPlanStore();
  let compilerCalls = 0;
  const coordinator = new ClaimProofCoordinator({
    proofPlanStore: store,
    repositorySnapshotProvider: { async fetchFiles() { return repositoryFiles; } },
    claimCompilerProvider: {
      async compile(input) {
        compilerCalls += 1;
        return candidate(input);
      },
    },
    clock: () => 10_000,
  });
  try {
    const first = await coordinator.prepare(preparationInput());
    const changedCompiler = await coordinator.prepare(preparationInput({
      compiler: { model: "gpt-5.4-mini", schemaVersion: 1, toolVersion: "claim-compiler-v1" },
    }));
    const changedProfile = await coordinator.prepare(preparationInput({ replayProfile: profile("retry-v2") }));
    assert.equal(first.state, "prepared");
    assert.equal(changedCompiler.state, "prepared");
    assert.equal(changedProfile.state, "prepared");
    assert.notEqual(changedCompiler.analysisKey, first.analysisKey);
    assert.notEqual(changedProfile.analysisKey, first.analysisKey);
    assert.equal(compilerCalls, 3);
  } finally {
    store.close();
  }
});

test("rejects non-exact revisions before snapshot or compiler work", async () => {
  const store = new ProofPlanStore();
  let calls = 0;
  const coordinator = new ClaimProofCoordinator({
    proofPlanStore: store,
    repositorySnapshotProvider: { async fetchFiles() { calls += 1; return repositoryFiles; } },
    claimCompilerProvider: { async compile(input) { calls += 1; return candidate(input); } },
  });
  try {
    await assert.rejects(
      () => coordinator.prepare(preparationInput({ mergeSha: "main" })),
      ClaimProofPreparationInputError,
    );
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});
