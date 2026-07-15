import type { RequiredStatusCheck } from "./github-gateway.js";
import type { GitHubPermission, InstallationTokenProvider } from "./github-app.js";
import type { MergePolicy } from "./domain.js";

export interface SourcePinnedCheck {
  name: string;
  appId: number;
}

export interface GitHubActivationReadGateway {
  getRequiredStatusChecks(repository: string, branch: string): Promise<RequiredStatusCheck[]>;
}

export interface GitHubActivationCheckInput {
  installationId: number;
  repository: string;
  branch: string;
  /** Every CI Check Run that queue policy requires before queueing. */
  requiredChecks: readonly SourcePinnedCheck[];
  requiredEvidenceCheck: { name: string; appId: number };
}

export interface GitHubActivationCheckResult {
  repository: string;
  branch: string;
  requiredChecks: SourcePinnedCheck[];
  requiredEvidenceCheck: { name: string; appId: number };
  /** A token read plus exact source pin are proven; queue mode needs a fixture PR. */
  queueMode: "requires_controlled_golden_pr";
}

const activationReadPermissions: Record<string, GitHubPermission> = {
  administration: "read",
};

/**
 * Converts a merge-queue policy into the exact source-pinned CI requirements
 * that branch protection must enforce. This deliberately refuses
 * an unpinned requirement instead of treating a same-named legacy status or
 * Check Run from an arbitrary App as equivalent.
 */
export function sourcePinnedRequiredChecks(
  merge: Pick<MergePolicy, "requiredChecks" | "requiredCheckAppIds">,
): SourcePinnedCheck[] {
  const sourcePins = merge.requiredCheckAppIds ?? {};
  const missing = merge.requiredChecks.filter((name) => !sourcePins[name]);
  if (missing.length > 0) {
    throw new Error(
      `Activation check requires a source pin for every production required Check Run: ${missing.join(", ")}.`,
    );
  }
  return merge.requiredChecks.map((name) => ({
    name,
    // The missing-source guard above establishes this is present. Validate the
    // value again below because this utility is safe to call outside zod policy
    // loading as well.
    appId: sourcePins[name]!,
  }));
}

function validateSourcePinnedChecks(
  checks: readonly SourcePinnedCheck[],
  description: string,
): SourcePinnedCheck[] {
  if (checks.length === 0) {
    throw new Error(`Activation check requires at least one ${description} Check Run.`);
  }
  const names = new Set<string>();
  return checks.map((check) => {
    if (
      !check ||
      typeof check.name !== "string" ||
      check.name.trim().length === 0 ||
      check.name !== check.name.trim() ||
      !Number.isSafeInteger(check.appId) ||
      check.appId < 1
    ) {
      throw new Error(`Activation check requires an exact source pin for every ${description} Check Run.`);
    }
    if (names.has(check.name)) {
      throw new Error(`Activation check has duplicate ${description} Check Run ${check.name}.`);
    }
    names.add(check.name);
    return { name: check.name, appId: check.appId };
  });
}

/**
 * Read-only activation check. It proves that this installation can read the
 * target branch's queue-required CI checks and final MergeProof check are all
 * source-pinned to their policy-selected Apps. GitHub API mode does not need
 * this branch-protection check. The command deliberately cannot enqueue,
 * publish a Check Run, label, comment, or merge anything.
 */
export async function verifyGitHubActivation(
  input: GitHubActivationCheckInput,
  tokens: InstallationTokenProvider,
  gateways: { create(token: string): GitHubActivationReadGateway },
): Promise<GitHubActivationCheckResult> {
  if (!/^[^/\s]{1,128}\/[^/\s]{1,128}$/.test(input.repository)) {
    throw new Error("Activation check requires an owner/repository identifier.");
  }
  if (!/^[A-Za-z0-9._/-]{1,255}$/.test(input.branch) || input.branch.includes("..")) {
    throw new Error("Activation check requires a safe base branch name.");
  }
  if (!Number.isSafeInteger(input.installationId) || input.installationId < 1) {
    throw new Error("Activation check requires a positive GitHub App installation id.");
  }
  const policyRequiredChecks = validateSourcePinnedChecks(
    input.requiredChecks,
    "production required",
  );
  if (
    !input.requiredEvidenceCheck.name ||
    !Number.isSafeInteger(input.requiredEvidenceCheck.appId) ||
    input.requiredEvidenceCheck.appId < 1
  ) {
    throw new Error("Activation check requires an exact evidence Check Run App id.");
  }
  if (policyRequiredChecks.some((check) => check.name === input.requiredEvidenceCheck.name)) {
    throw new Error("MergeProof evidence Check Run must not also be a production required CI Check Run.");
  }

  const token = await tokens.mint({
    installationId: input.installationId,
    repository: input.repository,
    permissions: activationReadPermissions,
  });
  const requiredChecksFromGitHub = await gateways
    .create(token.token)
    .getRequiredStatusChecks(input.repository, input.branch);
  const expectedChecks = [...policyRequiredChecks, input.requiredEvidenceCheck];
  const missing = expectedChecks.filter(
    (expected) =>
      !requiredChecksFromGitHub.some(
        (actual) => actual.name === expected.name && actual.appId === expected.appId,
      ),
  );
  if (missing.length > 0) {
    throw new Error(
      `GitHub branch protection does not require exact source-pinned Check Runs: ${missing
        .map((check) => `${check.name} from App ${check.appId}`)
        .join(", ")}.`,
    );
  }
  return {
    repository: input.repository,
    branch: input.branch,
    requiredChecks: policyRequiredChecks,
    requiredEvidenceCheck: { ...input.requiredEvidenceCheck },
    queueMode: "requires_controlled_golden_pr",
  };
}
