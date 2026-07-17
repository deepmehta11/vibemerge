import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  compileClaimContract,
  type ClaimContractCandidate,
  type SanitizedClaimCompilerInput,
} from "./claim-compiler.js";
import { sha256 } from "./crypto.js";
import { judgeClaimProof, type ExperimentObservation } from "./deterministic-judge.js";
import { mapImpact } from "./impact-mapper.js";
import { buildProofPlan } from "./proof-plan.js";
import { parseTrustedReplayProfile } from "./replay-profile.js";

const probePath = join(process.cwd(), "harness", "probes", "http-replay.mjs");
const authority = { class: "REPOSITORY_POLICY", reference: "policy:retry-idempotency-v1" } as const;

async function freePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      server.close((error) => error ? reject(error) : resolvePromise(address.port));
    });
  });
}

const baseJobs = `export function generate(state) {
  state.imageCount += 1;
  state.chargeCount += 1;
  return { imageId: "image-42", replay: false };
}
`;
const candidateJobs = `export function generate(state) {
  if (state.imageCount === 0) {
    state.imageCount += 1;
    state.chargeCount += 1;
  }
  return { imageId: "image-42", replay: state.imageCount === 1 };
}
`;
const serverSource = `import { createServer } from "node:http";
import { generate } from "./jobs.mjs";
const stores = new Map();
const body = async (request) => { const chunks = []; for await (const chunk of request) chunks.push(chunk); return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}; };
createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/healthz") { response.writeHead(200); response.end(); return; }
  if (url.pathname.startsWith("/__proof/setup/")) { const value = await body(request); stores.set(value.name, { imageCount: value.parameters.seedCount ?? 0, chargeCount: value.parameters.seedCount ?? 0 }); response.writeHead(204); response.end(); return; }
  if (url.pathname.startsWith("/__proof/state/")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(stores.get(url.searchParams.get("name")))); return; }
  if (url.pathname === "/jobs/job-42/generate") { const result = generate(stores.get("job")); response.writeHead(200, { "content-type": "application/json", "x-idempotent-replay": String(result.replay) }); response.end(JSON.stringify(result)); return; }
  response.writeHead(404); response.end();
}).listen(Number(process.env.PORT), "127.0.0.1");
`;

function replay(id: string, fixtureId: string, requestCount: number, expectedCount: number) {
  return {
    id,
    claimIds: ["duplicate-side-effects", "retry-idempotent", "single-charge"],
    setup: { fixtures: [{ name: "job", fixtureId, parameters: { job_id: "job-42", seedCount: fixtureId === "duplicate-job" ? 2 : 0 } }] },
    requests: Array.from({ length: requestCount }, (_, index) => ({
      id: `request-${index + 1}`,
      method: "POST" as const,
      path: "/jobs/{job_id}/generate",
      query: [],
    })),
    assertions: [
      { id: "one-image", kind: "state" as const, fixture: "job", path: "/imageCount", predicate: { operator: "equals" as const, expected: expectedCount } },
      { id: "one-charge", kind: "state" as const, fixture: "job", path: "/chargeCount", predicate: { operator: "equals" as const, expected: expectedCount } },
    ],
  };
}

function compiledCandidate(input: SanitizedClaimCompilerInput): ClaimContractCandidate {
  return {
    schemaVersion: 1,
    revision: input.revision,
    expectedBehaviors: [{ id: "retry-idempotent", when: "the same logical image job is submitted twice", then: "exactly one image exists", authority, supportingAuthorities: [], mandatory: true }],
    invariants: [{ id: "single-charge", scope: "billing", statement: "A logical image job is charged at most once.", authority, supportingAuthorities: [], mandatory: true }],
    failureSignatures: [{ id: "duplicate-side-effects", description: "A retry creates a second image or charge.", signals: [{ kind: "state", fixtureId: "empty-job", path: "/imageCount", predicate: { operator: "equals", expected: 2 } }], authority, supportingAuthorities: [], mandatory: true }],
    positiveControls: [{ id: "single-submit", description: "A normal first submission still works.", claimIds: ["retry-idempotent", "single-charge"], replayPlanId: "single-submit-control", authority, supportingAuthorities: [], mandatory: true }],
    negativeControls: [{ id: "duplicate-detector", description: "A seeded duplicate must trip the detector.", claimIds: ["retry-idempotent", "single-charge"], replayPlanId: "duplicate-control", authority, supportingAuthorities: [], mandatory: true }],
    ambiguities: [],
    replayPlans: [replay("retry-proof", "empty-job", 2, 1), replay("single-submit-control", "empty-job", 1, 1), replay("duplicate-control", "duplicate-job", 1, 1)],
  };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mergeproof-golden-demo-"));
  try {
    for (const [name, jobs] of [["base", baseJobs], ["candidate", candidateJobs], ["ablation", baseJobs]] as const) {
      const directory = join(root, name);
      mkdirSync(directory);
      writeFileSync(join(directory, "jobs.mjs"), jobs);
      writeFileSync(join(directory, "server.mjs"), serverSource);
    }
    const revision = { repository: "mergeproof/retry-demo", pullRequest: 42, baseSha: "a".repeat(40), headSha: "b".repeat(40) };
    const contract = await compileClaimContract(
      { compile: async (input) => compiledCandidate(input) },
      { ...revision, title: "Fix duplicate image generation when a job is retried", description: "Retrying a job must not create extra images or charges.", trustedAuthorityReferences: [authority] },
    );
    const diff = `diff --git a/jobs.mjs b/jobs.mjs
--- a/jobs.mjs
+++ b/jobs.mjs
@@ -1,5 +1,7 @@
 export function generate(state) {
-  state.imageCount += 1;
-  state.chargeCount += 1;
-  return { imageId: "image-42", replay: false };
+  if (state.imageCount === 0) {
+    state.imageCount += 1;
+    state.chargeCount += 1;
+  }
+  return { imageId: "image-42", replay: state.imageCount === 1 };
 }
`;
    const impact = mapImpact({ diff, repositoryFiles: [{ path: "jobs.mjs", content: candidateJobs }, { path: "server.mjs", content: serverSource }] });
    const port = await freePort();
    const fixture = (id: string) => ({ id, setupEndpoint: { method: "POST" as const, path: `/__proof/setup/${id}`, expectedStatus: 204 }, stateEndpoint: { method: "GET" as const, path: `/__proof/state/${id}`, expectedStatus: 200 } });
    const profile = parseTrustedReplayProfile({ schemaVersion: 1, version: "retry-demo-v1", application: { runtime: "node", cwd: ".", executable: "node", args: ["server.mjs"], env: {}, port, health: { method: "GET", path: "/healthz", expectedStatus: 200, timeoutMs: 3_000, intervalMs: 25 }, shutdownGraceMs: 500 }, operations: [{ id: "generate-job", method: "POST", pathTemplate: "/jobs/{job_id}/generate", allowedQueryKeys: [], allowedBodyKeys: [], maxInvocations: 2 }], fixtures: [fixture("empty-job"), fixture("duplicate-job")] });
    const compiledPlan = buildProofPlan({ claimContract: contract, impactMap: impact, replayProfile: profile });
    assert.equal(compiledPlan.plan.status, "ready");
    const planPath = join(root, "proof-plan.json");
    const profilePath = join(root, "replay-profile.json");
    writeFileSync(planPath, JSON.stringify(compiledPlan.plan));
    writeFileSync(profilePath, JSON.stringify(profile));

    const observations: ExperimentObservation[] = [];
    for (const phase of ["base", "candidate", "ablation"] as const) {
      for (const selector of ["primary", "positive_control", "negative_control"] as const) {
        const result = spawnSync(process.execPath, [probePath, selector], { env: { ...process.env, MERGEPROOF_SOURCE_DIR: join(root, phase), MERGEPROOF_PHASE: phase, MERGEPROOF_PROOF_PLAN_PATH: planPath, MERGEPROOF_REPLAY_PROFILE_PATH: profilePath }, encoding: "utf8", timeout: 10_000 });
        const marker = "MERGEPROOF_REPLAY=";
        const record = result.stdout.slice(result.stdout.indexOf(marker) + marker.length);
        const parsed = JSON.parse(record) as { experiments: Array<{ id: string; observed: "pass" | "fail" }> };
        observations.push(...parsed.experiments.map((entry) => ({ experimentId: entry.id, phase, observed: entry.observed, artifactDigest: sha256(record) })));
      }
    }
    const primaryIds = compiledPlan.plan.experiments.filter(({ kind }) => kind === "primary").map(({ id }) => id);
    const targetCoverage = Object.fromEntries(primaryIds.map((id) => [id, compiledPlan.plan.impactTargets.map(({ id: targetId }) => targetId)]));
    const judgment = judgeClaimProof({ plan: compiledPlan.plan, observations, targetCoverage });
    const primary = compiledPlan.plan.experiments.find(({ kind }) => kind === "primary")!;
    const observed = (phase: "base" | "candidate" | "ablation") => observations.find((entry) => entry.experimentId === primary.id && entry.phase === phase)?.observed;

    console.log("\nMERGEPROOF — CLAIM-TO-PROOF GOLDEN DEMO");
    console.log("Claim: retries must create exactly one image and one charge");
    console.log(`1. Claim compiler      ${contract.contract.expectedBehaviors.length} behavior + ${contract.contract.invariants.length} invariant (digest ${contract.digest.slice(0, 12)})`);
    console.log(`2. Impact mapper       ${impact.changedSymbols.length} changed symbol, ${impact.workflows.length} affected workflow (status ${impact.status})`);
    console.log(`3. Proof planner       ${compiledPlan.plan.experiments.length} generated experiments (digest ${compiledPlan.digest.slice(0, 12)})`);
    console.log(`4. Base experiment     ${observed("base")?.toUpperCase()} — duplicate image/charge reproduced`);
    console.log(`5. Candidate experiment ${observed("candidate")?.toUpperCase()} — one image/charge remains`);
    console.log(`6. Causality ablation  ${observed("ablation")?.toUpperCase()} — removing the guard restores the bug`);
    console.log(`7. Deterministic judge ${judgment.decision}`);
    console.log(`\nEvidence: ${observations.length} phase-bound observations; ${judgment.uncoveredImpactTargetIds.length} uncovered impact targets.\n`);
    if (judgment.decision !== "MERGE") process.exitCode = 1;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
