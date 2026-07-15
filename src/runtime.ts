import { lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { z } from "zod";

import { OpenAIProofPlanner } from "./agent-planner.js";
import { GitHubCheckRunFailureCloser, GitHubCheckRunGateway } from "./check-run.js";
import type { MergeProofControllerPolicy } from "./controller.js";
import { MergeProofController } from "./controller.js";
import { E2BSourceHarnessFactory } from "./e2b-harness.js";
import { GitHubAppInstallationTokenProvider } from "./github-app.js";
import { GitHubPullRequestCommentGateway } from "./github-comment.js";
import { GitHubRestGateway } from "./github-gateway.js";
import { GitHubRestSourceArchiveProvider } from "./github-source.js";
import { RunLedger } from "./ledger.js";
import { MergeGroupController } from "./merge-group-controller.js";
import { GitHubMergeQueueGateway } from "./merge-queue.js";
import { deriveTrustedHarnessBudget, type TrustedHarnessBudget } from "./harness-budget.js";
import { GitHubReconciliationReader } from "./reconciliation-github.js";
import { reconciliationConcurrency } from "./reconciliation-pool.js";
import { ReconciliationWorker } from "./reconciliation-worker.js";
import {
  assertImmutableE2BTemplate,
  trustedArtifactDigest,
  type TrustedWorkspaceFile,
} from "./trusted-artifacts.js";
import { createGitHubWebhookServer } from "./webhook-server.js";
import { WebhookWorker } from "./webhook-worker.js";

const metricNameSchema = z.enum([
  "p95_latency_ms",
  "peak_memory_mb",
  "cpu_ms",
  "error_rate",
]);

const unique = <T>(values: T[]): boolean => new Set(values).size === values.length;

const policySchema = z.object({
  allowedRepositories: z
    .array(z.string().regex(/^[^/\s]+\/[^/\s]+$/))
    .min(1, "At least 1 allowed repository must be configured.")
    .refine(unique, "Allowed repositories must be unique."),
  autoMergeEnabled: z.boolean(),
  mergeStrategy: z.enum(["direct_fixture", "github_api", "merge_queue"]).default("merge_queue"),
  verification: z
    .object({
      version: z.string().min(1),
      requiredCheckIds: z
        .array(z.string().min(1))
        .min(1, "At least 1 verification check must be configured.")
        .refine(unique, "Verification check identifiers must be unique."),
      requiredMetricNames: z
        .array(metricNameSchema)
        .min(1, "At least 1 resource metric must be configured.")
        .refine(unique, "Required resource metric names must be unique."),
      requireBugReproduction: z.boolean(),
      requireAdversarialChecks: z.boolean(),
      requireHunkClosure: z.boolean(),
      issueToProof: z
        .object({
          requireLinkedIssue: z.boolean(),
          requiredObligationIds: z
            .array(z.string().min(1))
            .min(1, "At least 1 Issue-to-Proof obligation must be configured.")
            .refine(unique, "Issue-to-Proof obligations must be unique."),
        })
        .strict()
        .optional(),
      metricThresholds: z.partialRecord(
        metricNameSchema,
        z.object({ maxRatio: z.number().positive(), maxAbsolute: z.number().nonnegative() }).strict(),
      ),
    })
    .strict(),
  merge: z
    .object({
      requiredApprovals: z.number().int().nonnegative(),
      requiredLabels: z.array(z.string().min(1)).refine(unique, "Required labels must be unique."),
      requiredChecks: z
        .array(z.string().min(1))
        .min(1, "At least 1 required GitHub check must be configured.")
        .refine(unique, "Required GitHub checks must be unique."),
      requiredCheckAppIds: z.record(z.string().min(1), z.number().int().positive()).optional(),
      mergeMethod: z.enum(["merge", "squash", "rebase"]),
    })
    .strict(),
})
  .strict()
  .superRefine((policy, context) => {
    for (const metricName of policy.verification.requiredMetricNames) {
      if (!policy.verification.metricThresholds[metricName]) {
        context.addIssue({
          code: "custom",
          path: ["verification", "metricThresholds", metricName],
          message: `A threshold is required for resource metric ${metricName}.`,
        });
      }
    }
    for (const obligation of policy.verification.issueToProof?.requiredObligationIds ?? []) {
      if (!policy.verification.requiredCheckIds.includes(obligation)) {
        context.addIssue({
          code: "custom",
          path: ["verification", "issueToProof", "requiredObligationIds"],
          message: `Issue-to-Proof obligation ${obligation} is not a required verification check.`,
        });
      }
    }
    for (const name of Object.keys(policy.merge.requiredCheckAppIds ?? {})) {
      if (!policy.merge.requiredChecks.includes(name)) {
        context.addIssue({
          code: "custom",
          path: ["merge", "requiredCheckAppIds", name],
          message: `Check App id is configured for unknown required check ${name}.`,
        });
      }
    }
  });

export interface MergeProofRuntime {
  server: ReturnType<typeof createGitHubWebhookServer>;
  worker: WebhookWorker;
  /** Compatibility handle for single-slot callers; serve uses all slots below. */
  reconciler: ReconciliationWorker;
  /** Independently fenced reconciliation slots for this single process. */
  reconcilers: readonly ReconciliationWorker[];
  reconciliationConcurrency: number;
  ledger: RunLedger;
  /** Safe-to-display digest of mounted trusted execution artifacts. */
  trustedArtifactDigest: string;
  /** Durable lease covering one derived E2B lifetime plus controller work. */
  verificationLeaseMs: number;
  port: number;
  setReady(ready: boolean): void;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}.`);
  }
  return value;
}

function port(value: string | undefined): number {
  const parsed = Number(value ?? "3000");
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("PORT must be a valid TCP port.");
  }
  return parsed;
}

function operatorToken(env: NodeJS.ProcessEnv): string | undefined {
  if (env.MERGEPROOF_OPERATOR_CONSOLE !== "true") {
    return undefined;
  }
  const token = required(env, "MERGEPROOF_OPERATOR_TOKEN");
  if (token.length < 24) {
    throw new Error("MERGEPROOF_OPERATOR_TOKEN must contain at least 24 characters.");
  }
  return token;
}

function boundedPositiveInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const supplied = env[name];
  if (supplied === undefined || supplied === "") {
    return fallback;
  }
  const parsed = Number(supplied);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 through ${maximum}.`);
  }
  return parsed;
}

function positiveInteger(value: string, name: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

/**
 * Probes remain JavaScript entry points.  A sealed probe can also need
 * controller-owned, non-executable assets (for example frozen Python tests
 * that are copied over a candidate's test directory before execution).  Keep
 * the allowlist deliberately small so artifact mounting never becomes a way
 * to smuggle arbitrary binaries or shell scripts into E2B.
 */
const trustedProbeAssetPath = /^[A-Za-z0-9][A-Za-z0-9._/-]*\.(?:mjs|py|json|toml|ini|lock)$/;

function loadTrustedProbeFiles(directory: string): Record<string, Uint8Array> {
  const root = resolve(directory);
  const files: Record<string, Uint8Array> = {};
  const visit = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        throw new Error("Trusted probe directories cannot contain symbolic links.");
      }
      if (info.isDirectory()) {
        visit(path);
        continue;
      }
      if (!info.isFile() || info.size > 1_048_576) {
        throw new Error("Trusted probe files must be regular files no larger than 1 MiB.");
      }
      const pathInWorkspace = relative(root, path).replaceAll("\\", "/");
      if (!trustedProbeAssetPath.test(pathInWorkspace) || pathInWorkspace.includes("..")) {
        throw new Error(
          "Trusted probe files must use safe relative .mjs, .py, .json, .toml, .ini, or .lock paths.",
        );
      }
      files[`/workspace/probes/${pathInWorkspace}`] = readFileSync(path);
    }
  };
  visit(root);
  if (!Object.keys(files).some((path) => path.endsWith(".mjs"))) {
    throw new Error("Trusted probe directory must contain at least one .mjs probe entrypoint.");
  }
  return files;
}

export interface TrustedArtifactBundle {
  template: string;
  command: string;
  workspaceFiles: Record<string, TrustedWorkspaceFile>;
  digest: string;
  harnessBudget: TrustedHarnessBudget;
}

/** Loads and byte-seals the complete controller-mounted E2B artifact bundle. */
export function loadTrustedArtifactBundle(input: {
  template: string;
  command: string;
  trustedHarnessPath: string;
  harnessSpecPath: string;
  trustedProbeDirectory: string;
}): TrustedArtifactBundle {
  const template = assertImmutableE2BTemplate(input.template);
  const harnessSpec = readFileSync(resolve(input.harnessSpecPath));
  const harnessBudget = deriveTrustedHarnessBudget(harnessSpec);
  const workspaceFiles: Record<string, TrustedWorkspaceFile> = {
    "/workspace/mergeproof-harness.mjs": readFileSync(resolve(input.trustedHarnessPath)),
    "/workspace/mergeproof-harness.json": harnessSpec,
    ...loadTrustedProbeFiles(input.trustedProbeDirectory),
  };
  return {
    template,
    command: input.command,
    workspaceFiles,
    digest: trustedArtifactDigest({
      template,
      command: input.command,
      workspaceFiles,
    }),
    harnessBudget,
  };
}

export function parseControllerPolicy(raw: unknown): MergeProofControllerPolicy {
  return policySchema.parse(raw) as MergeProofControllerPolicy;
}

export function loadControllerPolicy(path: string): MergeProofControllerPolicy {
  const raw = JSON.parse(readFileSync(resolve(path), "utf8")) as unknown;
  return parseControllerPolicy(raw);
}

/** Rejects configuration that would weaken a production merge gate. */
export function assertRuntimePolicySafe(
  policy: MergeProofControllerPolicy,
): void {
  if (
    policy.requiredEvidenceCheck &&
    policy.merge.requiredChecks.includes(policy.requiredEvidenceCheck.name)
  ) {
    throw new Error(
      "MergeProof / evidence is a final post-verification gate and must not be listed in merge.requiredChecks; doing so would wait for a Check Run that is only published after verification.",
    );
  }
  if (policy.autoMergeEnabled && policy.mergeStrategy === "direct_fixture") {
    throw new Error(
      "direct_fixture exists only for injected tests and demos. Use github_api or merge_queue in production.",
    );
  }
  if (
    policy.autoMergeEnabled &&
    (policy.mergeStrategy === "github_api" || policy.mergeStrategy === "merge_queue")
  ) {
    const sources = policy.merge.requiredCheckAppIds ?? {};
    const missingSources = policy.merge.requiredChecks.filter((name) => !sources[name]);
    if (missingSources.length > 0) {
      throw new Error(
        `Production merge policy requires an App id for every required check: ${missingSources.join(", ")}.`,
      );
    }
  }
  if (policy.autoMergeEnabled && policy.mergeStrategy === "github_api" && !policy.requiredEvidenceCheck) {
    throw new Error("Production github_api policy requires VibeMerge's own evidence Check Run identity.");
  }
}

/**
 * Builds the local Node service. Secrets are read from process environment only;
 * no secret is placed in policies, sandbox files, logs, or evidence receipts.
 */
export function createRuntime(env: NodeJS.ProcessEnv = process.env): MergeProofRuntime {
  // Parse this in the runtime rather than serve so `npm run config:check`
  // rejects an unsafe deployment setting without opening a port.
  const configuredReconciliationConcurrency = reconciliationConcurrency(
    env.MERGEPROOF_RECONCILIATION_CONCURRENCY,
  );
  const configuredPolicy = loadControllerPolicy(required(env, "MERGEPROOF_POLICY_PATH"));
  const appId = required(env, "GITHUB_APP_ID");
  const requiredEvidenceCheck = {
    name: "MergeProof / evidence",
    appId: positiveInteger(appId, "GITHUB_APP_ID"),
  };
  const privateKey = required(env, "GITHUB_APP_PRIVATE_KEY").replace(/\\n/g, "\n");
  const trustedHarnessPath = required(env, "MERGEPROOF_TRUSTED_HARNESS_PATH");
  const trustedProbeDirectory = required(env, "MERGEPROOF_TRUSTED_PROBES_DIR");
  const harnessSpecPath = required(env, "MERGEPROOF_HARNESS_SPEC_PATH");
  const trustedArtifacts = loadTrustedArtifactBundle({
    template: required(env, "MERGEPROOF_E2B_TEMPLATE"),
    command: required(env, "MERGEPROOF_HARNESS_COMMAND"),
    trustedHarnessPath,
    trustedProbeDirectory,
    harnessSpecPath,
  });
  const policy: MergeProofControllerPolicy = {
    ...configuredPolicy,
    trustedArtifactDigest: trustedArtifacts.digest,
    requiredEvidenceCheck,
  };
  assertRuntimePolicySafe(policy);
  const configuredOperatorToken = operatorToken(env);
  const databasePath = env.MERGEPROOF_DB_PATH ?? ".data/mergeproof.sqlite";
  if (databasePath !== ":memory:") {
    mkdirSync(dirname(resolve(databasePath)), { recursive: true });
  }
  const ledger = new RunLedger(
    databasePath,
    boundedPositiveInteger(env, "MERGEPROOF_MAX_PENDING_WEBHOOK_EVENTS", 10_000, 1_000_000),
    boundedPositiveInteger(env, "MERGEPROOF_MAX_PENDING_WEBHOOK_BYTES", 256 * 1024 * 1024, 10 * 1024 * 1024 * 1024),
  );
  const tokens = new GitHubAppInstallationTokenProvider(appId, privateKey);
  const reconcilers = Array.from(
    { length: configuredReconciliationConcurrency },
    (_, slot) =>
      new ReconciliationWorker(
        ledger,
        new GitHubReconciliationReader(tokens),
        `reconciler:${process.pid}:slot:${slot + 1}`,
        () => Date.now(),
        undefined,
        new GitHubCheckRunFailureCloser(tokens),
      ),
  );
  const reconciler = reconcilers[0]!;
  const sourceHarness = new E2BSourceHarnessFactory(
    {
      template: trustedArtifacts.template,
      command: trustedArtifacts.command,
      timeoutMs: trustedArtifacts.harnessBudget.sandboxTimeoutMs,
      verificationLeaseMs: trustedArtifacts.harnessBudget.verificationLeaseMs,
      environment: {
        MERGEPROOF_HARNESS_SPEC_PATH: "/workspace/mergeproof-harness.json",
      },
      trustedWorkspaceFiles: trustedArtifacts.workspaceFiles,
    },
    new GitHubRestSourceArchiveProvider(),
  );
  const controller = new MergeProofController(
    policy,
    tokens,
    {
      createReadGateway: (token) => new GitHubRestGateway(token),
      createMergeGateway: (token) => new GitHubRestGateway(token),
      createQueueGateway: (token) => new GitHubMergeQueueGateway(token),
      createCheckRunGateway: (token) => new GitHubCheckRunGateway(token),
      createCommentGateway: (token) => new GitHubPullRequestCommentGateway(token, requiredEvidenceCheck.appId),
    },
    undefined,
    ledger,
    () => new Date(),
    new OpenAIProofPlanner(),
    sourceHarness,
  );
  const mergeGroups = new MergeGroupController(
    policy,
    tokens,
    sourceHarness,
    { create: (token) => new GitHubCheckRunGateway(token) },
    { create: (token) => new GitHubRestGateway(token) },
    ledger,
  );
  const worker = new WebhookWorker(
    ledger,
    controller,
    `pid:${process.pid}`,
    3,
    () => Date.now(),
    mergeGroups,
    {
      checkRunPolicy: {
        requiredChecks: policy.merge.requiredChecks,
        ...(policy.merge.requiredCheckAppIds
          ? { requiredCheckAppIds: policy.merge.requiredCheckAppIds }
          : {}),
        ownAppId: positiveInteger(appId, "GITHUB_APP_ID"),
        ownCheckName: "MergeProof / evidence",
      },
    },
  );
  let ready = true;
  return {
    server: createGitHubWebhookServer({
      secret: required(env, "GITHUB_WEBHOOK_SECRET"),
      inbox: ledger,
      isReady: () => ready,
      ...(configuredOperatorToken
        ? {
            operatorConsole: {
              token: configuredOperatorToken,
              ledger,
              policy: {
                autoMergeEnabled: policy.autoMergeEnabled,
                mergeStrategy: policy.mergeStrategy,
                allowedRepositoryCount: policy.allowedRepositories.length,
              },
            },
          }
        : {}),
    }),
    worker,
    reconciler,
    reconcilers,
    reconciliationConcurrency: configuredReconciliationConcurrency,
    ledger,
    trustedArtifactDigest: trustedArtifacts.digest,
    verificationLeaseMs: trustedArtifacts.harnessBudget.verificationLeaseMs,
    port: port(env.PORT),
    setReady: (nextReady) => {
      ready = nextReady;
    },
  };
}
