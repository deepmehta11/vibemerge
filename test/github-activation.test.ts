import assert from "node:assert/strict";
import test from "node:test";

import {
  sourcePinnedRequiredChecks,
  verifyGitHubActivation,
} from "../src/github-activation.js";
import type { InstallationTokenRequest } from "../src/github-app.js";

test("activation check proves every source-pinned production Check Run with a read-only token", async () => {
  const requests: InstallationTokenRequest[] = [];
  const result = await verifyGitHubActivation(
    {
      installationId: 99,
      repository: "acme/checkout-service",
      branch: "main",
      requiredChecks: [
        { name: "ci / test", appId: 42 },
        { name: "ci / security", appId: 43 },
      ],
      requiredEvidenceCheck: { name: "MergeProof / evidence", appId: 777 },
    },
    {
      mint: async (request) => {
        requests.push(request);
        return { token: "activation-read-token", expiresAt: "2026-07-14T19:00:00Z" };
      },
    },
    {
      create: () => ({
        getRequiredStatusChecks: async () => [
          { name: "ci / test", appId: 42 },
          { name: "ci / security", appId: 43 },
          { name: "MergeProof / evidence", appId: 777 },
        ],
      }),
    },
  );

  assert.deepEqual(requests, [{
    installationId: 99,
    repository: "acme/checkout-service",
    permissions: { administration: "read" },
  }]);
  assert.deepEqual(result, {
    repository: "acme/checkout-service",
    branch: "main",
    requiredChecks: [
      { name: "ci / test", appId: 42 },
      { name: "ci / security", appId: 43 },
    ],
    requiredEvidenceCheck: { name: "MergeProof / evidence", appId: 777 },
    queueMode: "requires_controlled_golden_pr",
  });
});

test("activation check rejects a same-named required CI Check Run from another App", async () => {
  await assert.rejects(
    verifyGitHubActivation(
      {
        installationId: 99,
        repository: "acme/checkout-service",
        branch: "main",
        requiredChecks: [{ name: "ci / test", appId: 42 }],
        requiredEvidenceCheck: { name: "MergeProof / evidence", appId: 777 },
      },
      { mint: async () => ({ token: "activation-read-token", expiresAt: "2026-07-14T19:00:00Z" }) },
      {
        create: () => ({
          getRequiredStatusChecks: async () => [
            { name: "ci / test", appId: 7 },
            { name: "MergeProof / evidence", appId: 777 },
          ],
        }),
      },
    ),
    /source-pinned Check Runs: ci \/ test from App 42/i,
  );
});

test("activation check rejects a branch that omits one policy-required CI source pin", async () => {
  await assert.rejects(
    verifyGitHubActivation(
      {
        installationId: 99,
        repository: "acme/checkout-service",
        branch: "main",
        requiredChecks: [
          { name: "ci / test", appId: 42 },
          { name: "ci / security", appId: 43 },
        ],
        requiredEvidenceCheck: { name: "MergeProof / evidence", appId: 777 },
      },
      { mint: async () => ({ token: "activation-read-token", expiresAt: "2026-07-14T19:00:00Z" }) },
      {
        create: () => ({
          getRequiredStatusChecks: async () => [
            { name: "ci / test", appId: 42 },
            { name: "MergeProof / evidence", appId: 777 },
          ],
        }),
      },
    ),
    /ci \/ security from App 43/i,
  );
});

test("activation policy loader refuses a required CI Check Run without a source pin", () => {
  assert.throws(
    () =>
      sourcePinnedRequiredChecks({
        requiredChecks: ["ci / test", "ci / security"],
        requiredCheckAppIds: { "ci / test": 42 },
      }),
    /source pin.*ci \/ security/i,
  );
});
