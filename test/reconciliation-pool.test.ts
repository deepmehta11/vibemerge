import assert from "node:assert/strict";
import test from "node:test";

import {
  ReconciliationWorkerPool,
  reconciliationConcurrency,
  type ReconciliationProcessor,
} from "../src/reconciliation-pool.js";

const delay = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

test("reconciliation pool bounds work to its independently identified slots", async () => {
  let remaining = 7;
  let active = 0;
  let maximum = 0;
  const results: string[] = [];
  const workers: ReconciliationProcessor[] = ["slot-a", "slot-b"].map((workerId) => ({
    workerId,
    async processNext() {
      if (remaining === 0) {
        return { state: "idle" };
      }
      remaining -= 1;
      active += 1;
      maximum = Math.max(maximum, active);
      await delay(2);
      active -= 1;
      return { state: "ambiguous", operationId: `${workerId}:${remaining}` };
    },
  }));
  const pool = new ReconciliationWorkerPool(workers, (result) => {
    if (result.operationId) {
      results.push(result.operationId);
    }
  });

  pool.poll();
  while (results.length < 7) {
    await delay(2);
  }
  await pool.stop();

  assert.equal(maximum, 2);
  assert.equal(results.length, 7);
  assert.ok(results.every((operationId) => operationId.startsWith("slot-a:") || operationId.startsWith("slot-b:")));
});

test("reconciliation pool rejects duplicate owners and drains an active slot before shutdown", async () => {
  assert.throws(
    () => new ReconciliationWorkerPool([
      { workerId: "duplicate", async processNext() { return { state: "idle" as const }; } },
      { workerId: "duplicate", async processNext() { return { state: "idle" as const }; } },
    ]),
    /unique worker id/i,
  );

  let release: (() => void) | undefined;
  let started = false;
  let calls = 0;
  const pool = new ReconciliationWorkerPool([
    {
      workerId: "draining-slot",
      async processNext() {
        calls += 1;
        started = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { state: "ambiguous", operationId: "still-owned" };
      },
    },
  ]);
  pool.poll();
  while (!started) {
    await delay(1);
  }
  const stopped = pool.stop();
  await delay(2);
  assert.equal(calls, 1);
  assert.ok(release);
  release?.();
  await stopped;
  assert.equal(calls, 1);
});

test("reconciliation concurrency defaults conservatively and rejects unsafe values", () => {
  assert.equal(reconciliationConcurrency(undefined), 2);
  assert.equal(reconciliationConcurrency("8"), 8);
  assert.throws(() => reconciliationConcurrency("0"), /RECONCILIATION_CONCURRENCY/);
  assert.throws(() => reconciliationConcurrency("17"), /RECONCILIATION_CONCURRENCY/);
});
