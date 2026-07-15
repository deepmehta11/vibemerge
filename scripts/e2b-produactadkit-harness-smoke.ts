import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { E2BEvidenceHarness } from "../src/e2b-harness.js";
import { loadTrustedArtifactBundle } from "../src/runtime.js";

const template = process.env.MERGEPROOF_E2B_TEMPLATE;
if (!template) {
  throw new Error("MERGEPROOF_E2B_TEMPLATE must name the immutable Product AdKit template build.");
}
if (!process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY is required for the Product AdKit E2B harness smoke test.");
}

const repositoryDirectory = resolve(
  process.env.MERGEPROOF_PRODUCTADKIT_SOURCE_DIR ??
    "/Users/ira/codex/produactadkit-vibemerge",
);
const trustedArtifactBundle = loadTrustedArtifactBundle({
  template,
  command: "node /workspace/mergeproof-harness.mjs",
  trustedHarnessPath: resolve("harness/mergeproof-harness.mjs"),
  harnessSpecPath: resolve("config/produactadkit-engine.harness.json"),
  trustedProbeDirectory: resolve("harness/probes"),
});
const archive = execFileSync(
  "git",
  ["-C", repositoryDirectory, "archive", "--format=tar.gz", "--prefix=produactadkit-engine/", "HEAD"],
  // Product assets make the compressed source archive larger than Node's
  // 1 MiB default child-process buffer; the production archive gateway has
  // its own independent streaming bound.
  { maxBuffer: 32 * 1024 * 1024 },
);
const revision = {
  repository: "mvplab-ai/produactadkit-engine",
  pullRequest: 0,
  baseSha: "aa5a957a310740ffa85beb6aaa6023b656ef066a",
  headSha: "aa5a957a310740ffa85beb6aaa6023b656ef066a",
  mergeSha: "aa5a957a310740ffa85beb6aaa6023b656ef066a",
  policyHash: "produactadkit-harness-smoke",
  trustedArtifactDigest: trustedArtifactBundle.digest,
};
const harness = new E2BEvidenceHarness({
  template: trustedArtifactBundle.template,
  command: trustedArtifactBundle.command,
  timeoutMs: trustedArtifactBundle.harnessBudget.sandboxTimeoutMs,
  environment: { MERGEPROOF_HARNESS_SPEC_PATH: "/workspace/mergeproof-harness.json" },
  workspaceFiles: {
    ...trustedArtifactBundle.workspaceFiles,
    "/workspace/source.tar.gz": archive,
  },
});
const receipt = await harness.collect({ revision, phase: "candidate" });
const failedChecks = receipt.checks.filter((check) => check.status !== "pass").map((check) => check.id);
const missingMetrics = receipt.metrics.filter((metric) => metric.value === null).map((metric) => metric.name);
if (failedChecks.length > 0 || missingMetrics.length > 0) {
  if (process.env.MERGEPROOF_SMOKE_DEBUG === "true") {
    // Harness details are already bounded and secret-redacted.  Keep this
    // opt-in because normal activation output must remain a compact receipt.
    console.error(JSON.stringify({ checks: receipt.checks, metrics: receipt.metrics }));
  }
  throw new Error(
    `Product AdKit E2B profile did not pass its baseline smoke: checks=${failedChecks.join(",") || "none"}; metrics=${missingMetrics.join(",") || "none"}.`,
  );
}
console.info(JSON.stringify({
  event: "produactadkit_e2b_profile_verified",
  checks: receipt.checks.map((check) => check.id),
  metrics: receipt.metrics.map((metric) => metric.name),
  trustedArtifactDigest: trustedArtifactBundle.digest,
}));
