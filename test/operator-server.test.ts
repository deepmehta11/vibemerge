import assert from "node:assert/strict";
import test from "node:test";

import { demoRevision, demoVerificationPolicy, safeFixture } from "../src/fixtures.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import { RunLedger } from "../src/ledger.js";
import { createGitHubWebhookServer } from "../src/webhook-server.js";
import { VerificationEngine } from "../src/verifier.js";

const operatorToken = "operator-token-for-local-testing";

function operatorHeaders(): HeadersInit {
  return {
    authorization: `Basic ${Buffer.from(`operator:${operatorToken}`, "utf8").toString("base64")}`,
  };
}

async function startServer(ledger: RunLedger): Promise<{ server: ReturnType<typeof createGitHubWebhookServer>; origin: string }> {
  const server = createGitHubWebhookServer({
    secret: "webhook-secret",
    inbox: ledger,
    operatorConsole: {
      token: operatorToken,
      ledger,
      policy: { autoMergeEnabled: false, mergeStrategy: "merge_queue", allowedRepositoryCount: 1 },
    },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address.");
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

test("operator endpoints require Basic auth and expose only safe, non-cacheable views", async () => {
  const ledger = new RunLedger();
  const { server, origin } = await startServer(ledger);
  try {
    const claim = ledger.claim(demoRevision, "operator-server", 60_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      demoRevision,
      demoVerificationPolicy,
      new Date(10),
    );
    ledger.recordReceipt(claim.lease, receipt, 11);

    const unauthorized = await fetch(`${origin}/api/operator/v1/overview`);
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get("www-authenticate") ?? "", /Basic/);
    assert.equal(unauthorized.headers.get("cache-control"), "no-store");
    assert.equal(unauthorized.headers.get("access-control-allow-origin"), null);

    const dashboard = await fetch(`${origin}/ops`, { headers: operatorHeaders() });
    assert.equal(dashboard.status, 200);
    assert.match(await dashboard.text(), /durable emergency stop/);

    const overview = await fetch(`${origin}/api/operator/v1/overview`, { headers: operatorHeaders() });
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json() as { stats: { runs: { verified: number } }; automation: { paused: boolean } };
    assert.deepEqual(overviewBody.stats.runs.verified, 1);
    assert.equal(overviewBody.automation.paused, false);

    const unauthorizedPause = await fetch(`${origin}/api/operator/v1/automation/pause`, {
      method: "POST",
      headers: { "x-mergeproof-operator-action": "pause" },
    });
    assert.equal(unauthorizedPause.status, 401);
    assert.equal(ledger.automationControl().paused, false);

    const unconfirmedPause = await fetch(`${origin}/api/operator/v1/automation/pause`, {
      method: "POST",
      headers: operatorHeaders(),
    });
    assert.equal(unconfirmedPause.status, 400);

    const pause = await fetch(`${origin}/api/operator/v1/automation/pause`, {
      method: "POST",
      headers: { ...operatorHeaders(), "x-mergeproof-operator-action": "pause" },
    });
    assert.equal(pause.status, 200);
    assert.equal((await pause.json() as { automation: { paused: boolean } }).automation.paused, true);

    const resume = await fetch(`${origin}/api/operator/v1/automation/resume`, {
      method: "POST",
      headers: { ...operatorHeaders(), "x-mergeproof-operator-action": "resume" },
    });
    assert.equal(resume.status, 200);
    assert.equal((await resume.json() as { automation: { paused: boolean } }).automation.paused, false);

    const list = await fetch(`${origin}/api/operator/v1/runs?limit=1`, { headers: operatorHeaders() });
    const page = (await list.json()) as { runs: Array<{ runKey: string }> };
    assert.equal(page.runs.length, 1);
    const detail = await fetch(`${origin}/api/operator/v1/runs/${page.runs[0]?.runKey}`, {
      headers: operatorHeaders(),
    });
    const serialized = JSON.stringify(await detail.json());
    assert.doesNotMatch(serialized, /sandboxId|candidate source|hypotheses/);

    const missing = await fetch(`${origin}/api/operator/v1/runs/${"f".repeat(64)}`, {
      headers: operatorHeaders(),
    });
    assert.equal(missing.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    ledger.close();
  }
});

test("operator routes remain absent until the console is explicitly configured", async () => {
  const ledger = new RunLedger();
  const server = createGitHubWebhookServer({ secret: "webhook-secret", inbox: ledger });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");
    const response = await fetch(`http://127.0.0.1:${address.port}/ops`);
    assert.equal(response.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    ledger.close();
  }
});
