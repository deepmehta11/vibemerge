import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
      ...process.env,
      MERGEPROOF_SOURCE_DIR: cwd,
      MERGEPROOF_PHASE: process.env.MERGEPROOF_PHASE ?? "candidate",
      ...(workload
        ? {
            MERGEPROOF_WORKLOAD_ITERATION: String(workload.iteration),
            MERGEPROOF_WORKLOAD_REPETITIONS: String(workload.repetitions),
          }
        : {}),
    },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 1024 * 1024,
  });
  const output = clean(`${result.stdout ?? ""} ${result.stderr ?? ""}`);
  if (result.error) {
    return { ok: false, output: clean(result.error.message) };
  }
  return { ok: result.status === 0, output };
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
    return { harnessVersion: spec.version, checks, metrics };
  } finally {
    rmSync(worktree, { recursive: true, force: true });
  }
}

try {
  process.stdout.write(`MERGEPROOF_RESULT=${JSON.stringify(main())}\n`);
} catch (error) {
  process.stdout.write(`MERGEPROOF_RESULT=${JSON.stringify(unsupportedResult(error instanceof Error ? error.message : "Harness setup failed."))}\n`);
}
