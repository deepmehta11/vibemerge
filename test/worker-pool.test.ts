import assert from "node:assert/strict";
import test from "node:test";

import { WebhookWorkerPool, workerConcurrency } from "../src/worker-pool.js";

test("worker pool keeps expensive queue work within its configured concurrency", async () => {
  let remaining = 7;
  let active = 0;
  let maximum = 0;
  let completed = 0;
  const pool = new WebhookWorkerPool(
    {
      processNext: async () => {
        if (remaining === 0) return { state: "idle" as const };
        remaining -= 1;
        active += 1;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return { state: "processed" as const, deliveryId: String(remaining) };
      },
    },
    3,
    () => {
      completed += 1;
    },
  );

  pool.poll();
  while (completed < 7) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  await pool.stop();

  assert.equal(maximum, 3);
  assert.equal(completed, 7);
});

test("worker concurrency defaults conservatively and rejects unsafe values", () => {
  assert.equal(workerConcurrency(undefined), 2);
  assert.equal(workerConcurrency("8"), 8);
  assert.throws(() => workerConcurrency("0"), /WORKER_CONCURRENCY/);
  assert.throws(() => workerConcurrency("33"), /WORKER_CONCURRENCY/);
});
