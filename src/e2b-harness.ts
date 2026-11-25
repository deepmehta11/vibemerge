import { Sandbox } from "e2b";

import type { CheckKind, CheckStatus, HarnessResult, MetricName } from "./domain.js";
import {
  assertVerificationLeaseCoversSandbox,
  MAX_TRUSTED_SANDBOX_TIMEOUT_MS,
} from "./harness-budget.js";
import {
  HarnessUnavailableError,
  type EvidenceHarness,
  type EvidenceHarnessFactory,
  type HarnessRequest,
} from "./harness.js";
import { proofPlanDigest } from "./proof-plan.js";
import { parseTrustedReplayProfile, trustedReplayProfileDigest } from "./replay-profile.js";

export interface E2BTrustedHarnessConfig {
  /** Production runtime supplies an immutable `<template>:<build-id>` selector. */
  template?: string;
  /** Repository-owned command that emits MERGEPROOF_RESULT=<json>. */
  command: string;
  timeoutMs?: number;
  /** Values are supplied by the controller, never taken from checked-out source. */
  environment?: Record<string, string>;
  workspaceFiles?:
    | Record<string, string | Uint8Array>
    | ((request: HarnessRequest) => Promise<Record<string, string | Uint8Array>>);
}

export interface GitHubSourceArchiveProvider {
  fetchArchive(input: {
    repository: string;
    sha: string;
    githubReadToken: string;
  }): Promise<Uint8Array>;
}

export interface E2BSourceHarnessFactoryConfig extends Omit<E2BTrustedHarnessConfig, "workspaceFiles"> {
  /** Immutable harness code and policy-owned configuration uploaded beside source. */
  trustedWorkspaceFiles?: Record<string, string | Uint8Array>;
  /**
   * Optional durable lease published to controllers using this factory. It is
   * checked against the actual sandbox lifetime at construction time.
   */
  verificationLeaseMs?: number;
}

export const DEFAULT_E2B_SANDBOX_TIMEOUT_MS = 10 * 60_000;

/** Keeps direct E2B callers inside the same bounded lifetime as production. */
export function resolveE2BSandboxTimeoutMs(timeoutMs?: number): number {
  const resolved = timeoutMs ?? DEFAULT_E2B_SANDBOX_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_TRUSTED_SANDBOX_TIMEOUT_MS
  ) {
    throw new Error(
      `E2B sandbox timeout must be an integer from 1 through ${MAX_TRUSTED_SANDBOX_TIMEOUT_MS} milliseconds.`,
    );
  }
  return resolved;
}

function isHarnessResult(value: unknown): value is Omit<HarnessResult, "phase" | "sandboxId"> {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<HarnessResult>;
  if (
    typeof candidate.harnessVersion !== "string" ||
    !Array.isArray(candidate.checks) ||
    !Array.isArray(candidate.metrics)
  ) {
    return false;
  }
  const statuses = new Set<CheckStatus>(["pass", "fail", "unknown", "unsupported"]);
  const kinds = new Set<CheckKind>([
    "deterministic_gate",
    "bug_reproduction",
    "protected_behavior",
    "adversarial",
    "hunk_closure",
  ]);
  const metricNames = new Set<MetricName>([
    "p95_latency_ms",
    "peak_memory_mb",
    "cpu_ms",
    "error_rate",
  ]);
  const generatedProofValid = candidate.generatedProof === undefined || (
    !!candidate.generatedProof &&
    typeof candidate.generatedProof === "object" &&
    /^[a-f0-9]{64}$/.test((candidate.generatedProof as { proofPlanDigest?: unknown }).proofPlanDigest as string) &&
    Array.isArray((candidate.generatedProof as { experiments?: unknown }).experiments) &&
    (candidate.generatedProof as { experiments: unknown[] }).experiments.length <= 64 &&
    new Set(
      (candidate.generatedProof as { experiments: Array<{ id?: unknown }> }).experiments
        .map(({ id }) => id),
    ).size === (candidate.generatedProof as { experiments: unknown[] }).experiments.length &&
    (candidate.generatedProof as { experiments: unknown[] }).experiments.every((entry) => {
      if (!entry || typeof entry !== "object") return false;
      const observation = entry as Record<string, unknown>;
      return (
        typeof observation.id === "string" &&
        /^[a-z][a-z0-9_-]{0,159}$/.test(observation.id) &&
        ["primary", "positive_control", "negative_control"].includes(observation.kind as string) &&
        ["pass", "fail", "unsupported"].includes(observation.observed as string) &&
        Number.isSafeInteger(observation.assertions) &&
        (observation.assertions as number) >= 0 &&
        (observation.assertions as number) <= 24 &&
        Array.isArray(observation.failedAssertionIds) &&
        observation.failedAssertionIds.length <= 24 &&
        observation.failedAssertionIds.every(
          (id) => typeof id === "string" && /^[a-z][a-z0-9_-]{0,79}$/.test(id),
        ) &&
        typeof observation.artifactDigest === "string" &&
        /^[a-f0-9]{64}$/.test(observation.artifactDigest)
      );
    })
  );
  return (
    candidate.checks.every(
      (check) =>
        !!check &&
        typeof check === "object" &&
        typeof (check as { id?: unknown }).id === "string" &&
        kinds.has((check as { kind: CheckKind }).kind) &&
        typeof (check as { required?: unknown }).required === "boolean" &&
        statuses.has((check as { status: CheckStatus }).status) &&
        typeof (check as { detail?: unknown }).detail === "string",
    ) &&
    candidate.metrics.every(
      (metric) =>
        !!metric &&
        typeof metric === "object" &&
        metricNames.has((metric as { name: MetricName }).name) &&
        typeof (metric as { required?: unknown }).required === "boolean" &&
        (((metric as { value?: unknown }).value === null) ||
          (typeof (metric as { value?: unknown }).value === "number" &&
            Number.isFinite((metric as { value: number }).value))) &&
        typeof (metric as { detail?: unknown }).detail === "string",
    ) && generatedProofValid
  );
}

export function parseHarnessResult(
  stdout: string,
): Omit<HarnessResult, "phase" | "sandboxId"> {
  const line = stdout
    .split("\n")
    .find((entry) => entry.startsWith("MERGEPROOF_RESULT="));
  if (!line) {
    throw new HarnessUnavailableError(
      "Trusted harness did not emit a MERGEPROOF_RESULT record.",
    );
  }

  try {
    const result: unknown = JSON.parse(line.slice("MERGEPROOF_RESULT=".length));
    if (!isHarnessResult(result)) {
      throw new Error("shape");
    }
    return result;
  } catch {
    throw new HarnessUnavailableError(
      "Trusted harness emitted an invalid MERGEPROOF_RESULT record.",
    );
  }
}

/**
 * Executes one repository-owned harness command in a short-lived, no-egress E2B
 * sandbox. The command itself is the trusted boundary: it must create the
 * repository worktree and emit structured observations, never a merge verdict.
 */
export class E2BEvidenceHarness implements EvidenceHarness {
  readonly kind = "e2b";

  constructor(private readonly config: E2BTrustedHarnessConfig) {}

  async collect(request: HarnessRequest): Promise<HarnessResult> {
    if (!process.env.E2B_API_KEY) {
      throw new HarnessUnavailableError("E2B_API_KEY is not configured.");
    }

    let sandbox: Sandbox | undefined;
    try {
      const sandboxOptions = {
        timeoutMs: resolveE2BSandboxTimeoutMs(this.config.timeoutMs),
        allowInternetAccess: false,
        network: { allowPublicTraffic: false },
        metadata: {
          mergeproofPhase: request.phase,
          mergeproofRun: request.revision.headSha,
        },
      };
      sandbox = this.config.template
        ? await Sandbox.create(this.config.template, sandboxOptions)
        : await Sandbox.create(sandboxOptions);

      const workspaceFiles =
        typeof this.config.workspaceFiles === "function"
          ? await this.config.workspaceFiles(request)
          : (this.config.workspaceFiles ?? {});
      const controllerFiles = request.advisoryPlan
        ? {
            ...workspaceFiles,
            // The plan is JSON guidance only. The mounted trusted harness and
            // fixed maintainer probes decide whether and how to read it.
            "/workspace/mergeproof-advisory-plan.json": JSON.stringify(request.advisoryPlan),
          }
        : workspaceFiles;
      const generatedProofInputs = [
        request.proofPlan,
        request.proofPlanDigest,
        request.replayProfile,
        request.ablationDiff,
      ];
      if (generatedProofInputs.some((value) => value !== undefined) && generatedProofInputs.some((value) => value === undefined)) {
        throw new HarnessUnavailableError(
          "Generated proof plans, their digest, trusted replay profiles, and ablation diff must be mounted together.",
        );
      }
      const generatedProofFiles: Record<string, string | Uint8Array> = request.proofPlan && request.proofPlanDigest && request.replayProfile && request.ablationDiff
        ? (() => {
            const replayProfile = parseTrustedReplayProfile(request.replayProfile);
            if (request.proofPlan.status !== "ready") {
              throw new HarnessUnavailableError("Only a ready generated proof plan can execute.");
            }
            const digestPattern = /^[a-f0-9]{64}$/;
            const generatedPlanDigest = proofPlanDigest(request.proofPlan);
            const planRevision = request.proofPlan.revision;
            if (
              generatedPlanDigest !== request.proofPlanDigest ||
              !digestPattern.test(request.proofPlanDigest) ||
              !Object.values(request.proofPlan.inputs).every((value) => digestPattern.test(value)) ||
              planRevision.repository !== request.revision.repository ||
              planRevision.pullRequest !== request.revision.pullRequest ||
              planRevision.baseSha !== request.revision.baseSha ||
              planRevision.headSha !== request.revision.headSha ||
              request.proofPlan.inputs.replayProfileDigest !== trustedReplayProfileDigest(replayProfile)
            ) {
              throw new HarnessUnavailableError("Generated proof plan identity is malformed.");
            }
            if (Buffer.byteLength(request.ablationDiff, "utf8") > 1_048_576) {
              throw new HarnessUnavailableError("Generated proof ablation diff exceeds the trusted limit.");
            }
            return {
              "/workspace/mergeproof-proof-plan.json": JSON.stringify(request.proofPlan),
              "/workspace/mergeproof-replay-profile.json": JSON.stringify(replayProfile),
              "/workspace/mergeproof-pr.diff": request.ablationDiff,
            };
          })()
        : {};
      const mountedFiles: Record<string, string | Uint8Array> = {
        ...controllerFiles,
        ...generatedProofFiles,
      };
      for (const [path, content] of Object.entries(mountedFiles)) {
        if (!path.startsWith("/workspace/")) {
          throw new HarnessUnavailableError(
            `Workspace file must stay below /workspace: ${path}`,
          );
        }
        const data =
          content instanceof Uint8Array
            ? (() => {
                const copy = new Uint8Array(content.byteLength);
                copy.set(content);
                return copy.buffer;
              })()
            : content;
        await sandbox.files.write(path, data);
      }

      const command = await sandbox.commands.run(this.config.command, {
        envs: {
          ...(this.config.environment ?? {}),
          MERGEPROOF_PHASE: request.phase,
          MERGEPROOF_BASE_SHA: request.revision.baseSha,
          MERGEPROOF_HEAD_SHA: request.revision.headSha,
          MERGEPROOF_MERGE_SHA: request.revision.mergeSha,
          MERGEPROOF_SOURCE_ARCHIVE: "/workspace/source.tar.gz",
          ...(request.advisoryPlan
            ? { MERGEPROOF_ADVISORY_PLAN_PATH: "/workspace/mergeproof-advisory-plan.json" }
            : {}),
          ...(request.proofPlan
            ? {
                MERGEPROOF_PROOF_PLAN_PATH: "/workspace/mergeproof-proof-plan.json",
                MERGEPROOF_PROOF_PLAN_DIGEST: request.proofPlanDigest!,
                MERGEPROOF_REPLAY_PROFILE_PATH: "/workspace/mergeproof-replay-profile.json",
                MERGEPROOF_PR_DIFF_PATH: "/workspace/mergeproof-pr.diff",
              }
            : {}),
        },
      });
      if (command.exitCode !== 0) {
        throw new HarnessUnavailableError(
          `Trusted harness exited ${command.exitCode}: ${command.stderr.slice(0, 500)}`,
        );
      }
      return {
        ...parseHarnessResult(command.stdout),
        phase: request.phase,
        sandboxId: sandbox.sandboxId,
      };
    } catch (error) {
      if (error instanceof HarnessUnavailableError) {
        throw error;
      }
      throw new HarnessUnavailableError(
        error instanceof Error ? `E2B harness failed: ${error.message}` : "E2B harness failed.",
      );
    } finally {
      await sandbox?.kill().catch(() => undefined);
    }
  }
}

/**
 * Creates a separate E2B harness per exact revision. The GitHub read token is
 * used by the controller to download source and is never placed in the sandbox.
 */
export class E2BSourceHarnessFactory implements EvidenceHarnessFactory {
  readonly verificationLeaseMs?: number;
  private readonly sandboxTimeoutMs: number;

  constructor(
    private readonly config: E2BSourceHarnessFactoryConfig,
    private readonly archives: GitHubSourceArchiveProvider,
  ) {
    this.sandboxTimeoutMs = resolveE2BSandboxTimeoutMs(config.timeoutMs);
    if (config.verificationLeaseMs !== undefined) {
      assertVerificationLeaseCoversSandbox(this.sandboxTimeoutMs, config.verificationLeaseMs);
    }
    if (config.verificationLeaseMs !== undefined) {
      this.verificationLeaseMs = config.verificationLeaseMs;
    }
  }

  create(input: {
    revision: import("./domain.js").PinnedRevision;
    githubReadToken: string;
  }): EvidenceHarness {
    return new E2BEvidenceHarness({
      ...this.config,
      timeoutMs: this.sandboxTimeoutMs,
      workspaceFiles: async (request) => {
        const archive = await this.archives.fetchArchive({
          repository: input.revision.repository,
          sha: request.phase === "base" ? input.revision.baseSha : input.revision.mergeSha,
          githubReadToken: input.githubReadToken,
        });
        return {
          ...(this.config.trustedWorkspaceFiles ?? {}),
          "/workspace/source.tar.gz": archive,
        };
      },
    });
  }
}
