import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CheckRunGateway } from "./check-run.js";
import { MergeProofController, type GitHubGatewayFactory } from "./controller.js";
import type { LivePullRequest, PinnedRevision } from "./domain.js";
import { demoMergePolicy, demoVerificationPolicy, resourceRegressionFixture, safeFixture } from "./fixtures.js";
import { FixtureEvidenceHarness, type FixtureScenario } from "./harness.js";
import type {
  InstallationToken,
  InstallationTokenProvider,
  InstallationTokenRequest,
} from "./github-app.js";
import { RunLedger } from "./ledger.js";
import { MemoryMergeGateway } from "./merge-broker.js";
import { MergeGroupController } from "./merge-group-controller.js";

const now = () => new Date("2026-07-14T18:00:00.000Z");
const policy = {
  allowedRepositories: ["acme/checkout-service"],
  autoMergeEnabled: true,
  mergeStrategy: "merge_queue" as const,
  verification: demoVerificationPolicy,
  merge: demoMergePolicy,
};

class DemoTokens implements InstallationTokenProvider {
  readonly requests: InstallationTokenRequest[] = [];

  async mint(request: InstallationTokenRequest): Promise<InstallationToken> {
    this.requests.push(request);
    return { token: `demo-token-${this.requests.length}`, expiresAt: "2026-07-14T19:00:00Z" };
  }
}

function revision(suffix: string): PinnedRevision {
  return {
    repository: "acme/checkout-service",
    pullRequest: 42,
    baseSha: `base-${suffix}`,
    headSha: `head-${suffix}`,
    mergeSha: `test-merge-${suffix}`,
    policyHash: "demo-policy",
    trustedArtifactDigest: "demo-fixture-artifacts",
  };
}

function livePullRequest(value: PinnedRevision): LivePullRequest {
  return {
    nodeId: "PR_kwDODemo42",
    repository: value.repository,
    pullRequest: value.pullRequest,
    state: "open",
    draft: false,
    baseSha: value.baseSha,
    headSha: value.headSha,
    mergeSha: value.mergeSha,
    title: "Prevent duplicate checkout settlement",
    description: "Fixture PR for the MergeProof golden path.",
    diff: "diff --git a/checkout.ts b/checkout.ts\n+// fixture diff",
    labels: ["mergeproof:auto"],
    approvals: 1,
    checks: [
      { name: "ci / test", status: "pass" },
      { name: "ci / security", status: "pass" },
    ],
  };
}

async function runScenario(name: string, scenario: FixtureScenario): Promise<void> {
  const tempDirectory = mkdtempSync(join(tmpdir(), "mergeproof-demo-"));
  const ledger = new RunLedger(join(tempDirectory, "ledger.sqlite"));
  const tokens = new DemoTokens();
  const prRevision = revision(name);
  const queues: string[] = [];
  const checkConclusions: string[] = [];
  const commentVerdicts: string[] = [];
  const checks = {
    create: (): CheckRunGateway => ({
      createInProgress: async () => ({ id: checkConclusions.length + 1 }),
      complete: async (input) => {
        checkConclusions.push(input.receipt.verdict);
      },
    }),
  };
  const gateways: GitHubGatewayFactory = {
    createReadGateway: () => ({ getPullRequest: async () => livePullRequest(prRevision) }),
    createMergeGateway: () => new MemoryMergeGateway(livePullRequest(prRevision)),
    createQueueGateway: () => ({
      enqueue: async (input) => {
        queues.push(input.expectedHeadSha);
        return { message: "Fixture queue accepted exact head." };
      },
    }),
    createCheckRunGateway: () => checks.create(),
    createCommentGateway: () => ({
      upsert: async (input) => {
        commentVerdicts.push(input.receipt.verdict);
      },
    }),
  };
  try {
    const pr = await new MergeProofController(
      policy,
      tokens,
      gateways,
      new FixtureEvidenceHarness(scenario),
      ledger,
      now,
    ).process({
      deliveryId: `pr-${name}`,
      action: "synchronize",
      installationId: 99,
      repository: prRevision.repository,
      repositoryId: 101,
      pullRequest: prRevision.pullRequest,
    });

    if (pr.state !== "queued") {
      const verdict = "receipt" in pr ? pr.receipt.verdict : pr.state;
      console.log(`${name}: PR verdict=${verdict}; queue=not-enqueued; comment=${commentVerdicts[0] ?? "none"}`);
      return;
    }

    const group = await new MergeGroupController(
      policy,
      tokens,
      { create: () => new FixtureEvidenceHarness(scenario) },
      checks,
      {
        create: () => ({
          getPullRequestsForCommit: async () => [prRevision.pullRequest],
          getPullRequest: async () => livePullRequest(prRevision),
        }),
      },
      ledger,
      now,
    ).process({
      deliveryId: `group-${name}`,
      installationId: 99,
      repository: prRevision.repository,
      repositoryId: 101,
      baseSha: `queue-base-${name}`,
      headSha: `queue-sha-${name}`,
    });
    if (group.state !== "reported") {
      throw new Error(`Golden demo group was not reported: ${group.state}`);
    }
    console.log(
      `${name}: PR=${pr.receipt.verdict}; enqueued=${queues.length === 1}; merge-group=${group.receipt.verdict}; checks=${checkConclusions.join(",")}; GitHub may merge=${group.receipt.verdict === "LOW_OBSERVED_RISK"}`,
    );
  } finally {
    ledger.close();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

await runScenario("safe-fix", safeFixture());
await runScenario("resource-regression", resourceRegressionFixture());
