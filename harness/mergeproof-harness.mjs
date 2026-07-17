import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { spawnSync } from "node:child_process";

import { applyReverseUnifiedDiff } from "./reverse-unified-diff.mjs";

const checkKinds = new Set([
  "deterministic_gate",
  "bug_reproduction",
  "protected_behavior",
  "adversarial",
  "hunk_closure",
]);
const metricNames = new Set(["p95_latency_ms", "peak_memory_mb", "cpu_ms", "error_rate"]);
const maxArchiveEntries = 10_000;
const maxExtractedKiB = 512 * 1024;
const defaultProbeTimeoutMs = 60_000;
const maxProbeTimeoutMs = 5 * 60_000;
const maxHarnessChecks = 32;
const maxHarnessMetrics = 32;
const maxWorkloadRepetitions = 10;
const maxWorkloadProfileBudgetMs = 5 * 60_000;
const maxTotalProbeBudgetMs = 20 * 60_000;
const trustedProbesDir = process.env.MERGEPROOF_TRUSTED_PROBES_DIR ?? "/workspace/probes";

function trustedControllerInputPath(value, productionPath) {
  if (value === productionPath) return value;
  if (!value || !isAbsolute(value)) return undefined;
  try {
    const temporaryRoot = realpathSync(tmpdir());
    const resolvedValue = realpathSync(value);
    const fromTemporaryRoot = relative(temporaryRoot, resolvedValue);
    if (
      fromTemporaryRoot.length > 0 &&
      !fromTemporaryRoot.startsWith("..") &&
      !isAbsolute(fromTemporaryRoot)
    ) {
      return resolvedValue;
    }
  } catch {
    // Missing inputs and symlink escapes are not trusted controller mounts.
  }
  return undefined;
}

/**
 * A probe runs controller-owned code against candidate source.  It must not
 * inherit the harness's whole environment: even though E2B has no egress,
 * tests can print inherited values into candidate-influenced output.  Preserve
 * only runtime plumbing plus explicit MergeProof coordinates.
 */
function trustedProbeEnvironment(workload) {
  const environment = {
    PATH: process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: process.env.HOME ?? "/tmp",
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: process.env.LANG ?? "C.UTF-8",
    LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
    TZ: "UTC",
    MERGEPROOF_SOURCE_DIR: undefined,
    MERGEPROOF_PHASE: process.env.MERGEPROOF_PHASE ?? "candidate",
  };
  environment.MERGEPROOF_PROOF_PLAN_PATH = trustedControllerInputPath(
    process.env.MERGEPROOF_PROOF_PLAN_PATH,
    "/workspace/mergeproof-proof-plan.json",
  );
  environment.MERGEPROOF_REPLAY_PROFILE_PATH = trustedControllerInputPath(
    process.env.MERGEPROOF_REPLAY_PROFILE_PATH,
    "/workspace/mergeproof-replay-profile.json",
  );
  if (/^[a-f0-9]{64}$/.test(process.env.MERGEPROOF_PROOF_PLAN_DIGEST ?? "")) {
    environment.MERGEPROOF_PROOF_PLAN_DIGEST = process.env.MERGEPROOF_PROOF_PLAN_DIGEST;
  }
  if (workload) {
    environment.MERGEPROOF_WORKLOAD_ITERATION = String(workload.iteration);
    environment.MERGEPROOF_WORKLOAD_REPETITIONS = String(workload.repetitions);
  }
  return environment;
}

function clean(value, maxLength = 500) {
  return String(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    // Probe output is candidate-influenced evidence. It is useful for a
    // maintainer-owned failure summary, but it must never persist credentials
    // that a test happened to print from its environment or fixtures.
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:sk|sk-proj|e2b|ghp|gho|ghu|ghs|github_pat)[_-][A-Za-z0-9_-]{12,}\b/gi, "[REDACTED_SECRET]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_SECRET]")
    .replace(/\bBearer\s+[A-Za-z0-9._-]{20,}\b/gi, "Bearer [REDACTED_SECRET]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_000) {
    throw new Error(`${label} must be a non-empty bounded string.`);
  }
  return value;
}

function assertProbe(value, label) {
  const probe = assertString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*\.mjs$/.test(probe) || probe.includes("..")) {
    throw new Error(`${label} must be a relative trusted .mjs probe path.`);
  }
  return probe;
}

function assertProbeArgs(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error(`${label} must be a bounded string array.`);
  }
  return value.map((entry, index) => assertString(entry, `${label}[${index}]`));
}

function assertProbeTimeout(value, label) {
  if (value === undefined) return defaultProbeTimeoutMs;
  if (!Number.isSafeInteger(value) || value < 1 || value > maxProbeTimeoutMs) {
    throw new Error(`${label} must be an integer from 1 through ${maxProbeTimeoutMs} milliseconds.`);
  }
  return value;
}

/**
 * Resource thresholds are upper bounds, so a repeated profile may only retain
 * its worst observed value. The profile is part of the sealed, controller-owned
 * spec: a checked-out PR cannot choose its command, iteration count, or
 * aggregation rule.
 */
function parseWorkloadProfile(value, label, timeoutMs) {
  if (value === undefined) return undefined;
  const profile = assertObject(value, label);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${label} requires a finite positive metric timeoutMs.`);
  }
  const repetitions = profile.repetitions;
  if (
    !Number.isSafeInteger(repetitions) ||
    repetitions < 2 ||
    repetitions > maxWorkloadRepetitions
  ) {
    throw new Error(`${label}.repetitions must be a fixed integer from 2 through ${maxWorkloadRepetitions}.`);
  }
  if (profile.aggregation !== "max") {
    throw new Error(`${label}.aggregation must be the conservative value "max".`);
  }
  if (timeoutMs * repetitions > maxWorkloadProfileBudgetMs) {
    throw new Error(`${label} exceeds the ${maxWorkloadProfileBudgetMs}ms bounded profile budget.`);
  }
  return { repetitions, aggregation: "max" };
}

function parseSpec(raw) {
  const value = assertObject(raw, "Harness specification");
  const version = assertString(value.version, "version");
  if (!Array.isArray(value.checks) || !Array.isArray(value.metrics)) {
    throw new Error("Harness specification requires checks and metrics arrays.");
  }
  if (value.checks.length > maxHarnessChecks || value.metrics.length > maxHarnessMetrics) {
    throw new Error(`Harness specification supports at most ${maxHarnessChecks} checks and ${maxHarnessMetrics} metrics.`);
  }
  const checks = value.checks.map((entry, index) => {
    const check = assertObject(entry, `checks[${index}]`);
    const kind = assertString(check.kind, `checks[${index}].kind`);
    if (!checkKinds.has(kind)) throw new Error(`checks[${index}].kind is unsupported.`);
    if (typeof check.required !== "boolean") throw new Error(`checks[${index}].required must be boolean.`);
    return {
      id: assertString(check.id, `checks[${index}].id`),
      kind,
      required: check.required,
      probe: assertProbe(check.probe, `checks[${index}].probe`),
      args: assertProbeArgs(check.args, `checks[${index}].args`),
      detail: assertString(check.detail, `checks[${index}].detail`),
      timeoutMs: assertProbeTimeout(check.timeoutMs, `checks[${index}].timeoutMs`),
    };
  });
  const metrics = value.metrics.map((entry, index) => {
    const metric = assertObject(entry, `metrics[${index}]`);
    const name = assertString(metric.name, `metrics[${index}].name`);
    if (!metricNames.has(name)) throw new Error(`metrics[${index}].name is unsupported.`);
    if (typeof metric.required !== "boolean") throw new Error(`metrics[${index}].required must be boolean.`);
    const timeoutMs = assertProbeTimeout(metric.timeoutMs, `metrics[${index}].timeoutMs`);
    return {
      name,
      required: metric.required,
      probe: assertProbe(metric.probe, `metrics[${index}].probe`),
      args: assertProbeArgs(metric.args, `metrics[${index}].args`),
      detail: assertString(metric.detail, `metrics[${index}].detail`),
      timeoutMs,
      workloadProfile: parseWorkloadProfile(
        metric.workloadProfile,
        `metrics[${index}].workloadProfile`,
        timeoutMs,
      ),
    };
  });
  if (new Set(checks.map((check) => check.id)).size !== checks.length) {
    throw new Error("Harness check identifiers must be unique.");
  }
  if (new Set(metrics.map((metric) => metric.name)).size !== metrics.length) {
    throw new Error("Harness metric names must be unique.");
  }
  const totalProbeBudgetMs =
    checks.reduce((total, check) => total + check.timeoutMs, 0) +
    metrics.reduce(
      (total, metric) => total + metric.timeoutMs * (metric.workloadProfile?.repetitions ?? 1),
      0,
    );
  if (!Number.isSafeInteger(totalProbeBudgetMs) || totalProbeBudgetMs > maxTotalProbeBudgetMs) {
    throw new Error(`Harness specification exceeds the ${maxTotalProbeBudgetMs}ms total trusted probe budget.`);
  }
  return { version, checks, metrics };
}

function run(probe, args, cwd, timeoutMs, workload) {
  // Probes are mounted by the controller outside the candidate archive. They
  // can exercise the extracted source through MERGEPROOF_SOURCE_DIR, but a PR
  // cannot replace the executable entry point or inject shell syntax.
  const result = spawnSync(process.execPath, [join(trustedProbesDir, probe), ...args], {
    cwd,
    env: {
      ...trustedProbeEnvironment(workload),
      MERGEPROOF_SOURCE_DIR: cwd,
    },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const rawStdout = String(result.stdout ?? "");
  const output = clean(`${rawStdout} ${result.stderr ?? ""}`);
  if (result.error) {
    return { ok: false, output: clean(result.error.message), rawStdout: "" };
  }
  return { ok: result.status === 0, output, rawStdout };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function generatedProof(cwd) {
  const configuredPlanPath = process.env.MERGEPROOF_PROOF_PLAN_PATH;
  const configuredReplayProfilePath = process.env.MERGEPROOF_REPLAY_PROFILE_PATH;
  const digest = process.env.MERGEPROOF_PROOF_PLAN_DIGEST;
  if (!configuredPlanPath && !configuredReplayProfilePath && !digest) return undefined;
  const planPath = trustedControllerInputPath(
    configuredPlanPath,
    "/workspace/mergeproof-proof-plan.json",
  );
  const replayProfilePath = trustedControllerInputPath(
    configuredReplayProfilePath,
    "/workspace/mergeproof-replay-profile.json",
  );
  if (!planPath || !replayProfilePath || !/^[a-f0-9]{64}$/.test(digest ?? "")) {
    throw new Error("Generated proof identity is incomplete.");
  }
  const plan = assertObject(JSON.parse(readFileSync(planPath, "utf8")), "Generated proof plan");
  if (plan.schemaVersion !== 1 || plan.status !== "ready") {
    throw new Error("Generated proof plan is not ready.");
  }
  if (!Array.isArray(plan.experiments) || plan.experiments.length === 0 || plan.experiments.length > 64) {
    throw new Error("Generated proof plan has an invalid experiment set.");
  }
  const descriptors = plan.experiments.map((raw, index) => {
    const experiment = assertObject(raw, `experiments[${index}]`);
    const id = assertString(experiment.id, `experiments[${index}].id`);
    const kind = assertString(experiment.kind, `experiments[${index}].kind`);
    if (!/^[a-z][a-z0-9_-]{0,159}$/.test(id) || !["primary", "positive_control", "negative_control"].includes(kind)) {
      throw new Error(`experiments[${index}] identity is invalid.`);
    }
    return { id, kind };
  });
  if (new Set(descriptors.map(({ id }) => id)).size !== descriptors.length) {
    throw new Error("Generated proof experiment identifiers must be unique.");
  }
  const experiments = descriptors.map(({ id, kind }) => {
    const result = run("http-replay.mjs", [`experiment:${id}`], cwd, 60_000);
    const marker = "MERGEPROOF_REPLAY=";
    const markerIndex = result.rawStdout.indexOf(marker);
    if (markerIndex < 0) {
      return { id, kind, observed: "unsupported", assertions: 0, failedAssertionIds: [], artifactDigest: sha256(result.output) };
    }
    try {
      const recordText = result.rawStdout.slice(markerIndex + marker.length).trim();
      if (Buffer.byteLength(recordText, "utf8") > 65_536) throw new Error("record too large");
      const record = assertObject(JSON.parse(recordText), "Replay observation");
      if (!Array.isArray(record.experiments) || record.experiments.length !== 1) throw new Error("experiment count");
      const observation = assertObject(record.experiments[0], "Replay experiment observation");
      if (observation.id !== id || !["pass", "fail"].includes(observation.observed)) throw new Error("identity");
      if (!Number.isSafeInteger(observation.assertions) || observation.assertions < 0 || observation.assertions > 24) throw new Error("assertions");
      if (!Array.isArray(observation.failures) || observation.failures.length > 24 || observation.failures.some((value) => typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,79}$/.test(value))) throw new Error("failures");
      return {
        id,
        kind,
        observed: observation.observed,
        assertions: observation.assertions,
        failedAssertionIds: [...observation.failures].sort(),
        artifactDigest: sha256(recordText),
      };
    } catch {
      return { id, kind, observed: "unsupported", assertions: 0, failedAssertionIds: [], artifactDigest: sha256(result.output) };
    }
  });
  return { proofPlanDigest: digest, experiments };
}

function parseMetricValue(output) {
  const value = output.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function collectMetric(metric, cwd) {
  if (!metric.workloadProfile) {
    const result = run(metric.probe, metric.args, cwd, metric.timeoutMs);
    const value = result.ok ? parseMetricValue(result.output) : null;
    return {
      name: metric.name,
      required: metric.required,
      value,
      detail: clean(
        `${metric.detail} Command outcome: ${value === null ? "fail" : "pass"}. ${result.output}`,
      ),
    };
  }

  const samples = [];
  for (let iteration = 1; iteration <= metric.workloadProfile.repetitions; iteration += 1) {
    const result = run(metric.probe, metric.args, cwd, metric.timeoutMs, {
      iteration,
      repetitions: metric.workloadProfile.repetitions,
    });
    const value = result.ok ? parseMetricValue(result.output) : null;
    if (value === null) {
      return {
        name: metric.name,
        required: metric.required,
        value: null,
        detail: clean(
          `${metric.detail} Workload profile: ${metric.workloadProfile.repetitions} fixed runs, max aggregation. Command outcome: fail.`,
        ),
      };
    }
    samples.push(value);
  }

  return {
    name: metric.name,
    required: metric.required,
    value: Math.max(...samples),
    detail: clean(
      `${metric.detail} Workload profile: ${metric.workloadProfile.repetitions} fixed runs, max aggregation. Command outcome: pass.`,
    ),
  };
}

function extractArchive(archive) {
  const worktree = mkdtempSync(join(tmpdir(), "mergeproof-source-"));
  try {
    const listing = spawnSync("tar", ["-tzf", archive], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (listing.status !== 0) throw new Error("Source archive cannot be listed as a gzip tarball.");
    const entries = String(listing.stdout).split("\n").filter(Boolean);
    if (
      entries.length === 0 ||
      entries.length > maxArchiveEntries ||
      entries.some((entry) => entry.startsWith("/") || entry.split("/").includes(".."))
    ) {
      throw new Error("Source archive contains an unsafe path or too many entries.");
    }
    const metadata = spawnSync("tar", ["-tvzf", archive], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const metadataLines = String(metadata.stdout).split("\n").filter(Boolean);
    if (
      metadata.status !== 0 ||
      metadataLines.length !== entries.length ||
      metadataLines.some((line) => line[0] !== "-" && line[0] !== "d")
    ) {
      throw new Error("Source archive contains unsupported link or special-file entries.");
    }
    const extracted = spawnSync(
      "tar",
      ["-xzf", archive, "--strip-components=1", "--no-same-owner", "--no-same-permissions", "-C", worktree],
      { encoding: "utf8", timeout: 60_000, maxBuffer: 1024 * 1024 },
    );
    if (extracted.status !== 0) throw new Error("Source archive could not be extracted.");
    const diskUsage = spawnSync("du", ["-sk", worktree], {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1_024,
    });
    const kib = Number(String(diskUsage.stdout).trim().split(/\s+/)[0]);
    if (diskUsage.status !== 0 || !Number.isFinite(kib) || kib > maxExtractedKiB) {
      throw new Error("Source archive expands beyond the trusted workspace size limit.");
    }
    return worktree;
  } catch (error) {
    rmSync(worktree, { recursive: true, force: true });
    throw error;
  }
}

function unsupportedResult(detail) {
  return {
    harnessVersion: "mergeproof-harness-v1",
    checks: [
      {
        id: "mergeproof-harness-setup",
        kind: "deterministic_gate",
        required: true,
        status: "unsupported",
        detail: clean(detail),
      },
    ],
    metrics: [],
  };
}

function main() {
  const archive = process.env.MERGEPROOF_SOURCE_ARCHIVE;
  const specPath = process.env.MERGEPROOF_HARNESS_SPEC_PATH;
  if (!archive || !specPath) throw new Error("Harness archive or specification path is missing.");
  const spec = parseSpec(JSON.parse(readFileSync(specPath, "utf8")));
  const worktree = extractArchive(archive);
  try {
    if (process.env.MERGEPROOF_PHASE === "ablation") {
      const diffPath = process.env.MERGEPROOF_PR_DIFF_PATH;
      if (!diffPath) throw new Error("Ablation phase is missing the sealed PR diff.");
      applyReverseUnifiedDiff(worktree, readFileSync(diffPath, "utf8"));
    }
    const checks = spec.checks.map((check) => {
      const result = run(check.probe, check.args, worktree, check.timeoutMs);
      return {
        id: check.id,
        kind: check.kind,
        required: check.required,
        status: result.ok ? "pass" : "fail",
        detail: clean(`${check.detail} Command outcome: ${result.ok ? "pass" : "fail"}. ${result.output}`),
      };
    });
    const metrics = spec.metrics.map((metric) => collectMetric(metric, worktree));
    const proof = generatedProof(worktree);
    return { harnessVersion: spec.version, checks, metrics, ...(proof ? { generatedProof: proof } : {}) };
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
}

try {
  process.stdout.write(`MERGEPROOF_RESULT=${JSON.stringify(main())}\n`);
} catch (error) {
  process.stdout.write(`MERGEPROOF_RESULT=${JSON.stringify(unsupportedResult(error instanceof Error ? error.message : "Harness setup failed."))}\n`);
}
