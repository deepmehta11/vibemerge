import assert from "node:assert/strict";
import test from "node:test";

import { githubWebhookSignature } from "../src/crypto.js";
import { RunLedger } from "../src/ledger.js";
import { createGitHubWebhookServer } from "../src/webhook-server.js";

test("HTTP webhook server verifies raw signatures and durably queues accepted deliveries", async () => {
  const ledger = new RunLedger();
  const secret = "server-secret";
  const server = createGitHubWebhookServer({ secret, inbox: ledger });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");
    const body = "{\"action\":\"synchronize\"}";
    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/github`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-delivery": "server-1",
        "x-github-event": "pull_request",
        "x-hub-signature-256": githubWebhookSignature(body, secret),
      },
      body,
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { accepted: true, deliveryId: "server-1" });
    const job = ledger.claimWebhook("test-worker", 1_000);
    assert.equal(job?.deliveryId, "server-1");

    const rejected = await fetch(`http://127.0.0.1:${address.port}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-delivery": "server-2",
        "x-github-event": "pull_request",
        "x-hub-signature-256": "sha256=not-valid",
      },
      body,
    });
    assert.equal(rejected.status, 401);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    ledger.close();
  }
});

test("health endpoint is available without exposing webhook or receipt data", async () => {
  const ledger = new RunLedger();
  const server = createGitHubWebhookServer({ secret: "server-secret", inbox: ledger });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");
    const response = await fetch(`http://127.0.0.1:${address.port}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", service: "mergeproof" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    ledger.close();
  }
});

test("readiness endpoint reports when the process is draining", async () => {
  const ledger = new RunLedger();
  let ready = false;
  const server = createGitHubWebhookServer({
    secret: "server-secret",
    inbox: ledger,
    isReady: () => ready,
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");

    const draining = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    assert.equal(draining.status, 503);
    assert.deepEqual(await draining.json(), { status: "not_ready", service: "mergeproof" });

    const body = "{\"action\":\"synchronize\"}";
    const rejectedDelivery = await fetch(`http://127.0.0.1:${address.port}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-delivery": "draining-delivery",
        "x-github-event": "pull_request",
        "x-hub-signature-256": githubWebhookSignature(body, "server-secret"),
      },
      body,
    });
    assert.equal(rejectedDelivery.status, 503);
    assert.equal(rejectedDelivery.headers.get("retry-after"), "5");
    assert.deepEqual(await rejectedDelivery.json(), { accepted: false, reason: "service_draining" });
    assert.equal(ledger.claimWebhook("drain-test", 1_000), null);

    ready = true;
    const available = await fetch(`http://127.0.0.1:${address.port}/readyz`);
    assert.equal(available.status, 200);
    assert.deepEqual(await available.json(), { status: "ready", service: "mergeproof" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    ledger.close();
  }
});

test("webhook server asks GitHub to retry when its durable inbox is full", async () => {
  const ledger = new RunLedger(":memory:", 1);
  const secret = "server-secret";
  const server = createGitHubWebhookServer({ secret, inbox: ledger });
  try {
    assert.equal(ledger.enqueueWebhook("first", "pull_request", "{}"), true);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address.");
    const body = "{\"action\":\"synchronize\"}";
    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/github`, {
      method: "POST",
      headers: {
        "x-github-delivery": "second",
        "x-github-event": "pull_request",
        "x-hub-signature-256": githubWebhookSignature(body, secret),
      },
      body,
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("retry-after"), "5");
    assert.deepEqual(await response.json(), { accepted: false, reason: "inbox_full" });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    ledger.close();
  }
});
