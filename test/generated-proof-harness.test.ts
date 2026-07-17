import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const harnessPath = join(process.cwd(), "harness", "mergeproof-harness.mjs");
const probesPath = join(process.cwd(), "harness", "probes");
const proofPlanDigest = "c".repeat(64);

interface GeneratedProofExperiment {
  id: string;
  kind: "primary" | "positive_control" | "negative_control";
  observed: "pass" | "fail" | "unsupported";
  assertions: number;
  failedAssertionIds: string[];
  artifactDigest: string;
}

interface HarnessRecord {
  harnessVersion: string;
  checks: Array<{ id: string; status: string; detail: string }>;
  metrics: unknown[];
  generatedProof?: {
    proofPlanDigest: string;
    experiments: GeneratedProofExperiment[];
  };
}

async function freePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not reserve a loopback port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolvePromise(address.port));
    });
  });
}

function stateExperiment(
  id: string,
  kind: GeneratedProofExperiment["kind"],
  fixtureId: "empty-job" | "duplicate-job",
  requestCount: number,
  seedCount: number,
) {
  return {
    id,
    kind,
    sourcePlanId: id,
    claimIds: ["retry-is-idempotent", "single-charge"],
    mandatory: true,
    fixtures: [
      {
        name: "job",
        fixtureId,
        parameters: { seedCount },
        setupEndpoint: { method: "POST", path: "/__proof/setup", expectedStatus: 204 },
        stateEndpoint: { method: "GET", path: "/__proof/state", expectedStatus: 200 },
      },
    ],
    requests: Array.from({ length: requestCount }, (_, index) => ({
      id: `generate-${index + 1}`,
      method: "POST",
      path: "/jobs/job-42/generate",
      query: [],
    })),
    assertions: [
      {
        id: "one-image",
        kind: "state",
        fixture: "job",
        path: "/imageCount",
        predicate: { operator: "equals", expected: 1 },
      },
      {
        id: "one-charge",
        kind: "state",
        fixture: "job",
        path: "/chargeCount",
        predicate: { operator: "equals", expected: 1 },
      },
    ],
    expected: kind === "primary"
      ? { base: "fail", candidate: "pass", ablation: "fail" }
      : kind === "positive_control"
        ? { base: "pass", candidate: "pass", ablation: "pass" }
        : { base: "fail", candidate: "fail", ablation: "fail" },
  };
}

test("generated proof harness proves base red, candidate green, and reverse-diff ablation red", async () => {
  const root = mkdtempSync(join(tmpdir(), "mergeproof-generated-harness-"));
  try {
    const baseSource = join(root, "base-source");
    const candidateSource = join(root, "candidate-source");
    const baseArchive = join(root, "base.tar.gz");
    const candidateArchive = join(root, "candidate.tar.gz");
    const specPath = join(root, "harness.json");
    const planPath = join(root, "proof-plan.json");
    const duplicatePlanPath = join(root, "duplicate-proof-plan.json");
    const escapedPlanPath = join(root, "escaped-proof-plan.json");
    const profilePath = join(root, "replay-profile.json");
    const diffPath = join(root, "candidate.diff");
    mkdirSync(baseSource);
    mkdirSync(candidateSource);

    const baseJobs = `export function generate(state) {
  state.imageCount += 1;
  state.chargeCount += 1;
  return state;
}
`;
    const candidateJobs = `export function generate(state) {
  if (state.imageCount === 0) {
    state.imageCount += 1;
    state.chargeCount += 1;
  }
  return state;
}
`;
    const serverSource = `import { createServer } from "node:http";
import { generate } from "./jobs.mjs";

const stores = new Map();
async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/healthz") {
    response.writeHead(200);
    response.end();
    return;
  }
  if (url.pathname === "/__proof/setup") {
    const value = await readBody(request);
    const seedCount = Number(value.parameters?.seedCount ?? 0);
    stores.set(value.name, { imageCount: seedCount, chargeCount: seedCount });
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/__proof/state") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(stores.get(url.searchParams.get("name"))));
    return;
  }
  if (url.pathname === "/jobs/job-42/generate") {
    const result = generate(stores.get("job"));
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(result));
    return;
  }
  response.writeHead(404);
  response.end();
}).listen(Number(process.env.PORT), "127.0.0.1");
`;
    for (const [directory, jobs] of [[baseSource, baseJobs], [candidateSource, candidateJobs]] as const) {
      writeFileSync(join(directory, "jobs.mjs"), jobs);
      writeFileSync(join(directory, "server.mjs"), serverSource);
    }
    execFileSync("tar", ["-czf", baseArchive, "-C", root, "base-source"]);
    execFileSync("tar", ["-czf", candidateArchive, "-C", root, "candidate-source"]);

    const diff = `diff --git a/jobs.mjs b/jobs.mjs
--- a/jobs.mjs
+++ b/jobs.mjs
@@ -1,5 +1,7 @@
 export function generate(state) {
-  state.imageCount += 1;
-  state.chargeCount += 1;
+  if (state.imageCount === 0) {
+    state.imageCount += 1;
+    state.chargeCount += 1;
+  }
   return state;
 }
`;
    writeFileSync(diffPath, diff);
    writeFileSync(specPath, JSON.stringify({ version: "generated-proof-e2e-v1", checks: [], metrics: [] }));

    const fixtures = ["empty-job", "duplicate-job"].map((id) => ({
      id,
      setupEndpoint: { method: "POST", path: "/__proof/setup", expectedStatus: 204 },
      stateEndpoint: { method: "GET", path: "/__proof/state", expectedStatus: 200 },
    }));
    const profile = {
      schemaVersion: 1,
      version: "retry-proof-v1",
      application: {
        runtime: "node",
        cwd: ".",
        executable: "node",
        args: ["server.mjs"],
        env: {},
        port: await freePort(),
        health: { method: "GET", path: "/healthz", expectedStatus: 200, timeoutMs: 3_000, intervalMs: 25 },
        shutdownGraceMs: 500,
      },
      fixtures,
    };
    const experiments = [
      stateExperiment("primary-retry", "primary", "empty-job", 2, 0),
      stateExperiment("positive-single-submit", "positive_control", "empty-job", 1, 0),
      stateExperiment("negative-duplicate-detector", "negative_control", "duplicate-job", 1, 2),
    ];
    const plan = { schemaVersion: 1, status: "ready", experiments };
    writeFileSync(planPath, JSON.stringify(plan));
    writeFileSync(profilePath, JSON.stringify(profile));

    const runHarness = (
      phase: "base" | "candidate" | "ablation",
      sourceArchive: string,
      selectedPlanPath = planPath,
    ): HarnessRecord => {
      const result = spawnSync(process.execPath, [harnessPath], {
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME ?? root,
          TMPDIR: process.env.TMPDIR ?? tmpdir(),
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          MERGEPROOF_PHASE: phase,
          MERGEPROOF_SOURCE_ARCHIVE: sourceArchive,
          MERGEPROOF_HARNESS_SPEC_PATH: specPath,
          MERGEPROOF_TRUSTED_PROBES_DIR: probesPath,
          MERGEPROOF_PROOF_PLAN_PATH: selectedPlanPath,
          MERGEPROOF_PROOF_PLAN_DIGEST: proofPlanDigest,
          MERGEPROOF_REPLAY_PROFILE_PATH: profilePath,
          ...(phase === "ablation" ? { MERGEPROOF_PR_DIFF_PATH: diffPath } : {}),
        },
        encoding: "utf8",
        timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /^MERGEPROOF_RESULT=/);
      return JSON.parse(result.stdout.trim().slice("MERGEPROOF_RESULT=".length)) as HarnessRecord;
    };

    const records = {
      base: runHarness("base", baseArchive),
      candidate: runHarness("candidate", candidateArchive),
      ablation: runHarness("ablation", candidateArchive),
    };
    const observed = (phase: keyof typeof records, id: string) =>
      records[phase].generatedProof?.experiments.find((experiment) => experiment.id === id);

    for (const record of Object.values(records)) {
      assert.equal(record.harnessVersion, "generated-proof-e2e-v1");
      assert.deepEqual(record.checks, []);
      assert.deepEqual(record.metrics, []);
      assert.equal(record.generatedProof?.proofPlanDigest, proofPlanDigest);
      assert.equal(record.generatedProof?.experiments.length, 3);
      for (const experiment of record.generatedProof?.experiments ?? []) {
        assert.match(experiment.artifactDigest, /^[a-f0-9]{64}$/);
        assert.equal(experiment.assertions, 2);
      }
    }
    assert.equal(observed("base", "primary-retry")?.observed, "fail");
    assert.equal(observed("candidate", "primary-retry")?.observed, "pass");
    assert.equal(observed("ablation", "primary-retry")?.observed, "fail");
    for (const phase of ["base", "candidate", "ablation"] as const) {
      assert.equal(observed(phase, "positive-single-submit")?.observed, "pass");
      assert.equal(observed(phase, "negative-duplicate-detector")?.observed, "fail");
    }
    assert.deepEqual(observed("base", "primary-retry")?.failedAssertionIds, ["one-charge", "one-image"]);
    assert.deepEqual(observed("candidate", "primary-retry")?.failedAssertionIds, []);
    assert.deepEqual(observed("ablation", "primary-retry")?.failedAssertionIds, ["one-charge", "one-image"]);

    writeFileSync(
      duplicatePlanPath,
      JSON.stringify({ ...plan, experiments: [...experiments, experiments[0]] }),
    );
    const duplicateRecord = runHarness("candidate", candidateArchive, duplicatePlanPath);
    assert.equal(duplicateRecord.generatedProof, undefined);
    assert.equal(duplicateRecord.checks[0]?.status, "unsupported");
    assert.match(duplicateRecord.checks[0]?.detail ?? "", /experiment identifiers must be unique/i);

    symlinkSync(join(process.cwd(), "package.json"), escapedPlanPath);
    const escapedPathRecord = runHarness("candidate", candidateArchive, escapedPlanPath);
    assert.equal(escapedPathRecord.generatedProof, undefined);
    assert.equal(escapedPathRecord.checks[0]?.status, "unsupported");
    assert.match(escapedPathRecord.checks[0]?.detail ?? "", /generated proof identity is incomplete/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
