import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const probePath = join(process.cwd(), "harness", "probes", "http-replay.mjs");

async function freePort(): Promise<number> {
  return await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address === "object");
      const port = address.port;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

function serverSource(fixed: boolean): string {
  return `import { createServer } from "node:http";
const stores = new Map();
const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
};
createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1");
  if (url.pathname === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
    return;
  }
  if (url.pathname === "/__proof/setup/job") {
    const body = await readBody(request);
    stores.set(body.name, { imageCount: body.parameters.seedCount ?? 0, chargeCount: body.parameters.seedCount ?? 0 });
    response.writeHead(204);
    response.end();
    return;
  }
  if (url.pathname === "/__proof/state/job") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(stores.get(url.searchParams.get("name")) ?? null));
    return;
  }
  if (/^\\/jobs\\/[^/]+\\/generate$/.test(url.pathname)) {
    const state = stores.get("job");
    if (!${String(fixed)} || state.imageCount === 0) {
      state.imageCount += 1;
      state.chargeCount += 1;
    }
    response.writeHead(200, { "content-type": "application/json", "x-idempotent-replay": state.imageCount === 1 ? "true" : "false" });
    response.end(JSON.stringify({ imageId: "image-42" }));
    return;
  }
  response.writeHead(404);
  response.end();
}).listen(Number(process.env.PORT), "127.0.0.1");
`;
}

test("trusted HTTP replay observes base red, candidate green, and a working negative control", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "mergeproof-http-replay-"));
  try {
    const base = join(fixtureRoot, "base");
    const candidate = join(fixtureRoot, "candidate");
    mkdirSync(base);
    mkdirSync(candidate);
    writeFileSync(join(base, "server.mjs"), serverSource(false));
    writeFileSync(join(candidate, "server.mjs"), serverSource(true));
    const port = await freePort();
    const endpoint = (path: string, expectedStatus: number) => ({ method: "POST", path, expectedStatus });
    const setupEndpoint = endpoint("/__proof/setup/job", 204);
    const stateEndpoint = { method: "GET", path: "/__proof/state/job", expectedStatus: 200 };
    const profilePath = join(fixtureRoot, "profile.json");
    writeFileSync(profilePath, JSON.stringify({
      schemaVersion: 1,
      version: "retry-demo-v1",
      application: {
        runtime: "node",
        cwd: ".",
        executable: "node",
        args: ["server.mjs"],
        env: {},
        port,
        health: { method: "GET", path: "/healthz", expectedStatus: 200, timeoutMs: 3_000, intervalMs: 25 },
        shutdownGraceMs: 500,
      },
      fixtures: [{ id: "job", setupEndpoint, stateEndpoint }],
    }));

    const experiment = (id: string, kind: "primary" | "negative_control", seedCount: number) => ({
      id,
      kind,
      sourcePlanId: id,
      claimIds: ["retry-idempotent"],
      mandatory: true,
      fixtures: [{ name: "job", fixtureId: "job", parameters: { job_id: "job-42", seedCount }, setupEndpoint, stateEndpoint }],
      requests: [
        { id: "first", method: "POST", path: "/jobs/{job_id}/generate", query: [] },
        { id: "retry", method: "POST", path: "/jobs/{job_id}/generate", query: [] },
      ],
      assertions: [
        { id: "one-image", kind: "state", fixture: "job", path: "/imageCount", predicate: { operator: "equals", expected: 1 } },
        { id: "one-charge", kind: "state", fixture: "job", path: "/chargeCount", predicate: { operator: "equals", expected: 1 } },
      ],
      expected: kind === "primary"
        ? { base: "fail", candidate: "pass", ablation: "fail" }
        : { base: "fail", candidate: "fail", ablation: "fail" },
    });
    const planPath = join(fixtureRoot, "plan.json");
    writeFileSync(planPath, JSON.stringify({
      schemaVersion: 1,
      status: "ready",
      inputs: {
        claimContractDigest: "a".repeat(64),
        impactMapDigest: "b".repeat(64),
        replayProfileDigest: "c".repeat(64),
      },
      experiments: [experiment("primary-retry", "primary", 0), experiment("negative-duplicate", "negative_control", 2)],
    }));

    const run = (source: string, phase: "base" | "candidate", selector: "primary" | "negative_control") =>
      spawnSync(process.execPath, [probePath, selector], {
        env: {
          ...process.env,
          MERGEPROOF_SOURCE_DIR: source,
          MERGEPROOF_PHASE: phase,
          MERGEPROOF_PROOF_PLAN_PATH: planPath,
          MERGEPROOF_REPLAY_PROFILE_PATH: profilePath,
        },
        encoding: "utf8",
        timeout: 10_000,
      });

    const baseResult = run(base, "base", "primary");
    assert.equal(baseResult.status, 1, baseResult.stderr);
    assert.match(baseResult.stdout, /"observed":"fail"/);
    assert.match(baseResult.stdout, /one-image/);

    const candidateResult = run(candidate, "candidate", "primary");
    assert.equal(candidateResult.status, 0, candidateResult.stderr);
    assert.match(candidateResult.stdout, /"observed":"pass"/);

    const negativeResult = run(candidate, "candidate", "negative_control");
    assert.equal(negativeResult.status, 0, negativeResult.stderr);
    assert.match(negativeResult.stdout, /"observed":"fail"/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
