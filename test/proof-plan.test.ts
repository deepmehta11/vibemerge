import assert from "node:assert/strict";
import test from "node:test";

import {
  validateAndCompileClaimContract,
  type ClaimContractCandidate,
} from "../src/claim-compiler.js";
import { canonicalJson, sha256 } from "../src/crypto.js";
import type { ImpactMap } from "../src/impact-mapper.js";
import { buildProofPlan, ProofPlanInputError } from "../src/proof-plan.js";
import { parseTrustedReplayProfile } from "../src/replay-profile.js";

const revision = {
  repository: "mergeproof/demo",
  pullRequest: 42,
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
};
const policyAuthority = { class: "REPOSITORY_POLICY", reference: "policy:retry-v1" } as const;

function replay(id: string, fixtureId: string, expected: number) {
  return {
    id,
    claimIds: ["retry-idempotent"],
    setup: { fixtures: [{ name: "job", fixtureId, parameters: { jobId: "job-42" } }] },
    requests: [
      { id: "first", method: "POST" as const, path: "/jobs/job-42/generate", query: [] },
      { id: "retry", method: "POST" as const, path: "/jobs/job-42/retry", query: [] },
    ],
    assertions: [
      {
        id: "image-count",
        kind: "state" as const,
        fixture: "job",
        path: "/imageCount",
        predicate: { operator: "equals" as const, expected },
      },
    ],
  };
}

function candidate(): ClaimContractCandidate {
  return {
    schemaVersion: 1,
    revision,
    expectedBehaviors: [
      {
        id: "retry-idempotent",
        when: "the same image job is retried",
        then: "one image and one charge exist",
        authority: policyAuthority,
        supportingAuthorities: [],
        mandatory: true,
      },
    ],
    invariants: [],
    failureSignatures: [],
    positiveControls: [
      {
        id: "single-submit",
        description: "one submission is accepted",
        claimIds: ["retry-idempotent"],
        replayPlanId: "single-control",
        authority: policyAuthority,
        supportingAuthorities: [],
        mandatory: true,
      },
    ],
    negativeControls: [
      {
        id: "duplicate-detector",
        description: "a duplicate fixture trips the assertion",
        claimIds: ["retry-idempotent"],
        replayPlanId: "duplicate-control",
        authority: policyAuthority,
        supportingAuthorities: [],
        mandatory: true,
      },
    ],
    ambiguities: [],
    replayPlans: [
      replay("retry-proof", "empty-job", 1),
      replay("single-control", "single-image", 1),
      replay("duplicate-control", "duplicate-image", 1),
    ],
  };
}

function contract() {
  return validateAndCompileClaimContract(candidate(), {
    revision,
    trustedAuthorityReferences: [policyAuthority],
  });
}

function profile() {
  const fixture = (id: string) => ({
    id,
    setupEndpoint: { method: "POST" as const, path: `/__proof/setup/${id}`, expectedStatus: 204 },
    stateEndpoint: { method: "GET" as const, path: `/__proof/state/${id}`, expectedStatus: 200 },
  });
  return parseTrustedReplayProfile({
    schemaVersion: 1,
    version: "retry-demo-v1",
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
    operations: [
      { id: "generate-job", method: "POST", pathTemplate: "/jobs/job-42/generate", allowedQueryKeys: [], allowedBodyKeys: [], maxInvocations: 1 },
      { id: "retry-job", method: "POST", pathTemplate: "/jobs/job-42/retry", allowedQueryKeys: [], allowedBodyKeys: [], maxInvocations: 1 },
    ],
    fixtures: [fixture("empty-job"), fixture("single-image"), fixture("duplicate-image")],
  });
}

function impact(status: "complete" | "blocked" = "complete"): ImpactMap {
  return {
    schemaVersion: 1,
    status,
    diffFiles: [
      {
        oldPath: "src/jobs.ts",
        newPath: "src/jobs.ts",
        change: "modified",
        classifications: ["source"],
        hunks: [
          {
            oldStart: 10,
            oldCount: 1,
            newStart: 10,
            newCount: 2,
            section: "retryJob",
            classifications: ["control_flow"],
            changes: [{ kind: "added", line: 10, content: "if (seen) return existing;" }],
          },
        ],
      },
    ],
    changedSymbols: [
      {
        id: "src/jobs.ts#retryJob@9",
        path: "src/jobs.ts",
        name: "retryJob",
        line: 9,
        kind: "function",
        exported: true,
        defaultExport: false,
        startLine: 9,
        endLine: 18,
        changedLines: [10],
        changeKinds: ["control_flow"],
        importers: ["src/server.ts"],
        callers: [],
      },
    ],
    affectedFiles: [{ path: "src/server.ts", reasons: ["imports src/jobs.ts"] }],
    workflows: [
      {
        id: "src/server.ts#retryRoute@20",
        path: "src/server.ts",
        name: "retryRoute",
        line: 20,
        kind: "route",
        reason: "route reaches changed symbol",
        distance: 1,
      },
    ],
    unresolvedPaths: status === "blocked"
      ? [{ kind: "dynamic_import", path: "src/jobs.ts", line: 15, expression: "import(name)", reason: "dynamic target" }]
      : [],
    stats: {
      repositoryFiles: 2,
      repositoryBytes: 100,
      diffFiles: 1,
      hunks: 1,
      changedLines: 1,
      parsedSourceFiles: 2,
      analyzedSymbols: 2,
    },
  };
}

test("builds and seals primary, positive-control, and negative-control experiments", () => {
  const compiled = buildProofPlan({ claimContract: contract(), impactMap: impact(), replayProfile: profile() });
  assert.equal(compiled.plan.status, "ready");
  assert.equal(compiled.digest, sha256(canonicalJson(compiled.plan)));
  assert.deepEqual(compiled.plan.experiments.map(({ kind }) => kind), [
    "negative_control",
    "positive_control",
    "primary",
  ]);
  const primary = compiled.plan.experiments.find(({ kind }) => kind === "primary");
  assert.deepEqual(primary?.expected, { base: "fail", candidate: "pass", ablation: "fail" });
  assert.equal(primary?.fixtures[0]?.setupEndpoint.path, "/__proof/setup/empty-job");
  assert.deepEqual(compiled.plan.coverage.unmappedMandatoryClaimIds, []);
  assert.ok(compiled.plan.impactTargets.some(({ kind }) => kind === "hunk"));
});

test("same normalized inputs produce the same plan and digest", () => {
  const first = buildProofPlan({ claimContract: contract(), impactMap: impact(), replayProfile: profile() });
  const second = buildProofPlan({ claimContract: contract(), impactMap: structuredClone(impact()), replayProfile: profile() });
  assert.deepEqual(second, first);
});

test("missing trusted fixtures and incomplete impact fail closed", () => {
  const missingFixtureProfile = profile();
  missingFixtureProfile.fixtures.splice(0, 1);
  const compiled = buildProofPlan({
    claimContract: contract(),
    impactMap: impact("blocked"),
    replayProfile: missingFixtureProfile,
  });
  assert.equal(compiled.plan.status, "blocked");
  assert.ok(compiled.plan.blockingReasons.includes("impact-map-incomplete"));
  assert.ok(compiled.plan.blockingReasons.some((reason) => reason.startsWith("missing-trusted-fixture:")));
  assert.ok(compiled.plan.blockingReasons.some((reason) => reason.startsWith("unresolved-impact:")));
});

test("changed source without resolved symbols or workflows blocks automation", () => {
  const unresolvedSurface = impact();
  unresolvedSurface.changedSymbols = [];
  unresolvedSurface.workflows = [];
  const compiled = buildProofPlan({
    claimContract: contract(),
    impactMap: unresolvedSurface,
    replayProfile: profile(),
  });

  assert.equal(compiled.plan.status, "blocked");
  assert.ok(compiled.plan.blockingReasons.includes("no-changed-symbols-resolved"));
  assert.ok(compiled.plan.blockingReasons.includes("no-workflow-entrypoints-resolved"));
});

test("model-selected endpoints outside the controller operation registry block execution", () => {
  const value = candidate();
  value.replayPlans[0]!.requests[0]!.path = "/admin/delete-everything";
  const untrustedOperation = validateAndCompileClaimContract(value, {
    revision,
    trustedAuthorityReferences: [policyAuthority],
  });
  const compiled = buildProofPlan({
    claimContract: untrustedOperation,
    impactMap: impact(),
    replayProfile: profile(),
  });

  assert.equal(compiled.plan.status, "blocked");
  assert.ok(compiled.plan.blockingReasons.some((reason) => reason.startsWith("untrusted-operation:")));
});

test("controls cannot substitute for a mandatory primary proof", () => {
  const value = candidate();
  value.replayPlans = value.replayPlans.filter(({ id }) => id !== "retry-proof");
  const onlyControls = validateAndCompileClaimContract(value, {
    revision,
    trustedAuthorityReferences: [policyAuthority],
  });
  const compiled = buildProofPlan({ claimContract: onlyControls, impactMap: impact(), replayProfile: profile() });
  assert.equal(compiled.plan.status, "blocked");
  assert.ok(compiled.plan.blockingReasons.includes("missing-primary-experiment"));
  assert.ok(compiled.plan.blockingReasons.includes("missing-mandatory-primary-experiment"));
});

test("a changed contract cannot reuse a stale digest", () => {
  const stale = contract();
  stale.contract.expectedBehaviors[0]!.then = "two images exist";
  assert.throws(
    () => buildProofPlan({ claimContract: stale, impactMap: impact(), replayProfile: profile() }),
    ProofPlanInputError,
  );
});
