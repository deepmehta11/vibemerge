import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const harnessPath = join(process.cwd(), "harness", "mergeproof-harness.mjs");

test("trusted harness measures base and candidate source archives with policy-owned commands", () => {
  const fixture = mkdtempSync(join(tmpdir(), "mergeproof-trusted-harness-"));
  try {
    const source = join(fixture, "fixture-source");
    const archive = join(fixture, "source.tar.gz");
    const spec = join(fixture, "harness.json");
    const probes = join(fixture, "probes");
    execFileSync("mkdir", [source]);
    execFileSync("mkdir", [probes]);
    writeFileSync(join(source, "present.txt"), "fixture source\n");
    writeFileSync(
      join(probes, "fixture-probe.mjs"),
      `import { existsSync } from "node:fs";
import { join } from "node:path";
const action = process.argv[2];
const source = process.env.MERGEPROOF_SOURCE_DIR;
if (action === "ci") {
  process.stdout.write("sk-proj_abcdefghijklmnopqrstuvwxyz0123456789");
  process.exitCode = existsSync(join(source, "present.txt")) ? 0 : 1;
}
else if (action === "reproduction") process.exitCode = process.env.MERGEPROOF_PHASE === "candidate" ? 0 : 1;
else if (action === "latency") process.stdout.write("42");
else if (action === "profile-latency") {
  const iteration = Number(process.env.MERGEPROOF_WORKLOAD_ITERATION);
  const repetitions = Number(process.env.MERGEPROOF_WORKLOAD_REPETITIONS);
  if (repetitions !== 3 || !Number.isSafeInteger(iteration)) process.exitCode = 1;
  else process.stdout.write(String((process.env.MERGEPROOF_PHASE === "candidate" ? 50 : 40) + iteration));
}
else process.exitCode = 1;
`,
    );
    writeFileSync(
      spec,
      JSON.stringify({
        version: "mergeproof-harness-test-v1",
        checks: [
          {
            id: "ci",
            kind: "deterministic_gate",
            required: true,
            probe: "fixture-probe.mjs",
            args: ["ci"],
            detail: "Source is extracted.",
          },
          {
            id: "issue-reproduction",
            kind: "bug_reproduction",
            required: true,
            probe: "fixture-probe.mjs",
            args: ["reproduction"],
            detail: "Bug must reproduce on base and be fixed by candidate.",
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
          {
            name: "cpu_ms",
            required: true,
            probe: "fixture-probe.mjs",
            args: ["profile-latency"],
            detail: "Repeated controller-owned latency fixture.",
            timeoutMs: 1000,
            workloadProfile: { repetitions: 3, aggregation: "max" },
          },
        ],
      }),
    );
    execFileSync("tar", ["-czf", archive, "-C", fixture, "fixture-source"]);

    const run = (phase: "base" | "candidate") => {
      const result = spawnSync(process.execPath, [harnessPath], {
        env: {
          ...process.env,
          MERGEPROOF_PHASE: phase,
          MERGEPROOF_SOURCE_ARCHIVE: archive,
          MERGEPROOF_HARNESS_SPEC_PATH: spec,
          MERGEPROOF_TRUSTED_PROBES_DIR: probes,
        },
        encoding: "utf8",
      });
      assert.equal(result.status, 0);
      const record = result.stdout.trim().replace("MERGEPROOF_RESULT=", "");
      return JSON.parse(record) as {
        harnessVersion: string;
        checks: Array<{ id: string; status: string; detail: string }>;
        metrics: Array<{ name: string; value: number | null; detail: string }>;
      };
    };

    const base = run("base");
    const candidate = run("candidate");
    assert.equal(base.harnessVersion, "mergeproof-harness-test-v1");
    assert.deepEqual(base.checks.map((check) => check.status), ["pass", "fail"]);
    assert.doesNotMatch(base.checks[0]?.detail ?? "", /sk-proj_/);
    assert.match(base.checks[0]?.detail ?? "", /REDACTED_SECRET/);
    assert.deepEqual(candidate.checks.map((check) => check.status), ["pass", "pass"]);
    assert.deepEqual(candidate.metrics, [
      { name: "p95_latency_ms", required: true, value: 42, detail: "Synthetic latency fixture. Command outcome: pass. 42" },
      {
        name: "cpu_ms",
        required: true,
        value: 53,
        detail: "Repeated controller-owned latency fixture. Workload profile: 3 fixed runs, max aggregation. Command outcome: pass.",
      },
    ]);
    assert.equal(base.metrics.find((metric) => metric.name === "cpu_ms")?.value, 43);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted harness fails closed for invalid or incomplete repeated workload samples", () => {
  const fixture = mkdtempSync(join(tmpdir(), "mergeproof-trusted-harness-"));
  try {
    const source = join(fixture, "fixture-source");
    const archive = join(fixture, "source.tar.gz");
    const spec = join(fixture, "harness.json");
    const probes = join(fixture, "probes");
    execFileSync("mkdir", [source]);
    execFileSync("mkdir", [probes]);
    writeFileSync(join(source, "present.txt"), "fixture source\n");
    writeFileSync(
      join(probes, "fixture-probe.mjs"),
      `const iteration = Number(process.env.MERGEPROOF_WORKLOAD_ITERATION);
if (iteration === 2) process.stdout.write("not-a-number");
else process.stdout.write("42");
`,
    );
    writeFileSync(
      spec,
      JSON.stringify({
        version: "profile-failure-v1",
        checks: [],
        metrics: [
          {
            name: "p95_latency_ms",
            required: true,
            probe: "fixture-probe.mjs",
            detail: "Every repeated sample must be numeric.",
            timeoutMs: 1000,
            workloadProfile: { repetitions: 3, aggregation: "max" },
          },
        ],
      }),
    );
    execFileSync("tar", ["-czf", archive, "-C", fixture, "fixture-source"]);
    const result = spawnSync(process.execPath, [harnessPath], {
      env: {
        ...process.env,
        MERGEPROOF_SOURCE_ARCHIVE: archive,
        MERGEPROOF_HARNESS_SPEC_PATH: spec,
        MERGEPROOF_TRUSTED_PROBES_DIR: probes,
      },
      encoding: "utf8",
    });
    const record = JSON.parse(result.stdout.trim().replace("MERGEPROOF_RESULT=", "")) as {
      metrics: Array<{ value: number | null; detail: string }>;
    };
    assert.equal(record.metrics[0]?.value, null);
    assert.match(record.metrics[0]?.detail ?? "", /3 fixed runs, max aggregation.*outcome: fail/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted harness rejects unbounded or non-conservative workload profiles", () => {
  const fixture = mkdtempSync(join(tmpdir(), "mergeproof-trusted-harness-"));
  try {
    const spec = join(fixture, "unsafe-profile.json");
    const invalidProfiles: Array<{
      profile: Record<string, unknown>;
      timeoutMs?: number;
      expected: RegExp;
    }> = [
      { profile: { repetitions: 11, aggregation: "max" }, expected: /repetitions/i },
      { profile: { repetitions: 3, aggregation: "mean" }, expected: /aggregation/i },
      {
        profile: { repetitions: 5, aggregation: "max" },
        timeoutMs: 60_001,
        expected: /bounded profile budget/i,
      },
    ];
    for (const { profile, timeoutMs, expected } of invalidProfiles) {
      writeFileSync(
        spec,
        JSON.stringify({
          version: "unsafe-profile-v1",
          checks: [],
          metrics: [
            {
              name: "p95_latency_ms",
              required: true,
              probe: "fixture-probe.mjs",
              detail: "unsafe profile",
              ...(timeoutMs === undefined ? {} : { timeoutMs }),
              workloadProfile: profile,
            },
          ],
        }),
      );
      const result = spawnSync(process.execPath, [harnessPath], {
        env: {
          ...process.env,
          MERGEPROOF_SOURCE_ARCHIVE: join(fixture, "does-not-matter.tar.gz"),
          MERGEPROOF_HARNESS_SPEC_PATH: spec,
        },
        encoding: "utf8",
      });
      const record = JSON.parse(result.stdout.trim().replace("MERGEPROOF_RESULT=", "")) as {
        checks: Array<{ status: string; detail: string }>;
      };
      assert.equal(record.checks[0]?.status, "unsupported");
      assert.match(record.checks[0]?.detail ?? "", expected);
    }
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted harness rejects a bounded-but-aggregate-expansive probe schedule", () => {
  const fixture = mkdtempSync(join(tmpdir(), "mergeproof-trusted-harness-"));
  try {
    const spec = join(fixture, "aggregate-budget.json");
    writeFileSync(
      spec,
      JSON.stringify({
        version: "aggregate-budget-v1",
        checks: Array.from({ length: 5 }, (_, index) => ({
          id: `slow-${index}`,
          kind: "deterministic_gate",
          required: true,
          probe: "fixture-probe.mjs",
          detail: "Each individual probe is bounded.",
          timeoutMs: 300_000,
        })),
        metrics: [],
      }),
    );
    const result = spawnSync(process.execPath, [harnessPath], {
      env: {
        ...process.env,
        MERGEPROOF_SOURCE_ARCHIVE: join(fixture, "does-not-matter.tar.gz"),
        MERGEPROOF_HARNESS_SPEC_PATH: spec,
      },
      encoding: "utf8",
    });
    const record = JSON.parse(result.stdout.trim().replace("MERGEPROOF_RESULT=", "")) as {
      checks: Array<{ status: string; detail: string }>;
    };
    assert.equal(record.checks[0]?.status, "unsupported");
    assert.match(record.checks[0]?.detail ?? "", /total trusted probe budget/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted harness rejects candidate-controlled shell commands in the probe specification", () => {
  const fixture = mkdtempSync(join(tmpdir(), "mergeproof-trusted-harness-"));
  try {
    const spec = join(fixture, "unsafe-harness.json");
    writeFileSync(
      spec,
      JSON.stringify({
        version: "unsafe-v1",
        checks: [{ id: "ci", kind: "deterministic_gate", required: true, command: "npm test", detail: "unsafe" }],
        metrics: [],
      }),
    );
    const result = spawnSync(process.execPath, [harnessPath], {
      env: {
        ...process.env,
        MERGEPROOF_SOURCE_ARCHIVE: join(fixture, "does-not-matter.tar.gz"),
        MERGEPROOF_HARNESS_SPEC_PATH: spec,
      },
      encoding: "utf8",
    });
    const record = JSON.parse(result.stdout.trim().replace("MERGEPROOF_RESULT=", "")) as {
      checks: Array<{ status: string; detail: string }>;
    };
    assert.equal(record.checks[0]?.status, "unsupported");
    assert.match(record.checks[0]?.detail ?? "", /probe/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("trusted harness rejects source archives containing symbolic links", () => {
  const fixture = mkdtempSync(join(tmpdir(), "mergeproof-trusted-harness-"));
  try {
    const source = join(fixture, "fixture-source");
    const archive = join(fixture, "source.tar.gz");
    const spec = join(fixture, "harness.json");
    execFileSync("mkdir", [source]);
    execFileSync("ln", ["-s", "/etc/passwd", join(source, "unsafe-link")]);
    writeFileSync(
      spec,
      JSON.stringify({
        version: "archive-v1",
        checks: [{ id: "ci", kind: "deterministic_gate", required: true, probe: "fixture.mjs", detail: "safe" }],
        metrics: [],
      }),
    );
    execFileSync("tar", ["-czf", archive, "-C", fixture, "fixture-source"]);
    const result = spawnSync(process.execPath, [harnessPath], {
      env: {
        ...process.env,
        MERGEPROOF_SOURCE_ARCHIVE: archive,
        MERGEPROOF_HARNESS_SPEC_PATH: spec,
      },
      encoding: "utf8",
    });
    const record = JSON.parse(result.stdout.trim().replace("MERGEPROOF_RESULT=", "")) as {
      checks: Array<{ status: string; detail: string }>;
    };
    assert.equal(record.checks[0]?.status, "unsupported");
    assert.match(record.checks[0]?.detail ?? "", /link or special/i);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
