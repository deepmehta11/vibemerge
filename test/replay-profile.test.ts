import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { claimCompilerExecutionCatalog } from "../src/claim-compiler.js";
import {
  parseTrustedReplayProfile,
  replayOrigin,
  trustedReplayProfileDigest,
} from "../src/replay-profile.js";

function profile(): unknown {
  return {
    schemaVersion: 1,
    version: "checkout-demo-v1",
    application: {
      runtime: "node",
      cwd: ".",
      executable: "node",
      args: ["src/server.mjs"],
      env: { NODE_ENV: "test", MERGEPROOF_FIXTURES: "enabled" },
      port: 4_321,
      health: {
        method: "GET",
        path: "/healthz",
        expectedStatus: 200,
        timeoutMs: 5_000,
        intervalMs: 50,
      },
      shutdownGraceMs: 1_000,
    },
    operations: [{
      id: "submit-job",
      method: "POST",
      pathTemplate: "/jobs/{job_id}/generate",
      allowedQueryKeys: [],
      allowedBodyKeys: [],
      maxInvocations: 2,
    }],
    fixtures: [
      {
        id: "empty-job-store",
        setupEndpoint: { method: "POST", path: "/__proof/fixtures", expectedStatus: 204 },
        stateEndpoint: { method: "GET", path: "/__proof/state", expectedStatus: 200 },
      },
    ],
  };
}

test("trusted replay profiles normalize controller-owned execution inputs", () => {
  const parsed = parseTrustedReplayProfile(profile());
  assert.equal(replayOrigin(parsed), "http://127.0.0.1:4321");
  assert.match(trustedReplayProfileDigest(parsed), /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(parsed.application.env), ["MERGEPROOF_FIXTURES", "NODE_ENV"]);
});

test("trusted replay profiles allow only the fixed Python 3 runtime pair", () => {
  const value = profile() as any;
  value.application.runtime = "python";
  value.application.executable = "python3";
  value.application.args = ["app.py"];
  const parsed = parseTrustedReplayProfile(value);
  assert.equal(parsed.application.runtime, "python");

  value.application.executable = "python";
  assert.throws(() => parseTrustedReplayProfile(value));
});

test("trusted replay profiles reject commands, remote URLs, traversal, and credential-shaped environment", () => {
  for (const mutate of [
    (value: any) => { value.application.executable = "sh"; },
    (value: any) => { value.application.cwd = "../outside"; },
    (value: any) => { value.application.health.path = "https://attacker.example/health"; },
    (value: any) => { value.application.env.GITHUB_TOKEN = "secret"; },
    (value: any) => { value.fixtures[0].setupEndpoint.path = "//attacker.example/fixture"; },
  ]) {
    const value = profile() as any;
    mutate(value);
    assert.throws(() => parseTrustedReplayProfile(value));
  }
});

test("trusted replay profile digests are independent of map and registry ordering", () => {
  const first = profile() as any;
  first.fixtures.push({
    id: "seed-order",
    setupEndpoint: { method: "POST", path: "/__proof/order", expectedStatus: 201 },
    stateEndpoint: { method: "GET", path: "/__proof/order", expectedStatus: 200 },
  });
  const second = structuredClone(first);
  second.fixtures.reverse();
  second.application.env = { MERGEPROOF_FIXTURES: "enabled", NODE_ENV: "test" };
  assert.equal(
    trustedReplayProfileDigest(parseTrustedReplayProfile(first)),
    trustedReplayProfileDigest(parseTrustedReplayProfile(second)),
  );
});

test("ProductAdKit replay profile gives the compiler controller-owned operation and state semantics", () => {
  const parsed = parseTrustedReplayProfile(
    JSON.parse(readFileSync("config/produactadkit-engine.replay-profile.json", "utf8")),
  );
  const catalog = claimCompilerExecutionCatalog(parsed);

  assert.deepEqual(catalog.operations.map(({ path }) => path), ["/jobs"]);
  assert.deepEqual(catalog.operations[0]?.allowedBodyKeys, ["idempotency_key"]);
  assert.deepEqual(
    catalog.fixtures[0]?.stateFields.map(({ path }) => path),
    ["/generation_calls", "/submissions", "/unique_job_ids"],
  );
});
