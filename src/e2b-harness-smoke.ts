import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { E2BEvidenceHarness } from "./e2b-harness.js";
import type { PinnedRevision } from "./domain.js";

if (!process.env.E2B_API_KEY) {
  throw new Error("Set E2B_API_KEY in the runtime environment before running this smoke test.");
}

const fixture = mkdtempSync(join(tmpdir(), "mergeproof-e2b-harness-"));
try {
  const source = join(fixture, "fixture-source");
  const archive = join(fixture, "source.tar.gz");
  const spec = join(fixture, "mergeproof-harness.json");
  const probe = join(fixture, "fixture-probe.mjs");
  execFileSync("mkdir", [source]);
  writeFileSync(join(source, "present.txt"), "fixture source\n");
  writeFileSync(
    probe,
    `import { existsSync } from "node:fs";
import { join } from "node:path";
const action = process.argv[2];
const source = process.env.MERGEPROOF_SOURCE_DIR;
if (action === "ci") process.exitCode = existsSync(join(source, "present.txt")) ? 0 : 1;
else if (action === "reproduction") process.exitCode = process.env.MERGEPROOF_PHASE === "candidate" ? 0 : 1;
else if (action === "latency") process.stdout.write("42");
else process.exitCode = 1;
`,
  );
  writeFileSync(
    spec,
    JSON.stringify({
      version: "mergeproof-harness-smoke-v1",
      checks: [
        {
          id: "ci",
          kind: "deterministic_gate",
          required: true,
          probe: "fixture-probe.mjs",
          args: ["ci"],
          detail: "Source archive was extracted.",
        },
        {
          id: "issue-reproduction",
          kind: "bug_reproduction",
          required: true,
          probe: "fixture-probe.mjs",
          args: ["reproduction"],
          detail: "Bug reproduces only on the base fixture.",
        },
      ],
      metrics: [
        {
          name: "p95_latency_ms",
          required: true,
          probe: "fixture-probe.mjs",
          args: ["latency"],
          detail: "Synthetic latency fixture.",
        },
      ],
    }),
  );
  execFileSync("tar", ["-czf", archive, "-C", fixture, "fixture-source"]);

  const revision: PinnedRevision = {
    repository: "acme/mergeproof-fixture",
    pullRequest: 42,
    baseSha: "abcdef1",
    headSha: "1234567",
    mergeSha: "7654321",
    policyHash: "smoke-policy",
    trustedArtifactDigest: "smoke-artifacts",
  };
  const harness = new E2BEvidenceHarness({
    command: "node /workspace/mergeproof-harness.mjs",
    timeoutMs: 120_000,
    workspaceFiles: {
      "/workspace/source.tar.gz": readFileSync(archive),
      "/workspace/mergeproof-harness.mjs": readFileSync(
        join(process.cwd(), "harness", "mergeproof-harness.mjs"),
        "utf8",
      ),
      "/workspace/mergeproof-harness.json": readFileSync(spec, "utf8"),
      "/workspace/probes/fixture-probe.mjs": readFileSync(probe, "utf8"),
    },
    environment: {
      MERGEPROOF_HARNESS_SPEC_PATH: "/workspace/mergeproof-harness.json",
    },
  });
  const [base, candidate] = await Promise.all([
    harness.collect({ revision, phase: "base" }),
    harness.collect({ revision, phase: "candidate" }),
  ]);
  if (
    base.checks.find((check) => check.id === "issue-reproduction")?.status !== "fail" ||
    candidate.checks.find((check) => check.id === "issue-reproduction")?.status !== "pass" ||
    candidate.metrics.find((metric) => metric.name === "p95_latency_ms")?.value !== 42
  ) {
    throw new Error(
      `Trusted E2B harness did not produce expected base/candidate evidence: ${JSON.stringify({ base, candidate })}`,
    );
  }
  console.log("E2B trusted-harness smoke test passed.");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
