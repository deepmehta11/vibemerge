import {
  CLAIM_COMPILER_SYSTEM_INSTRUCTIONS,
  compileClaimContract,
  sanitizeClaimCompilerInput,
  type ClaimAuthorityReference,
  type ClaimCompilerCandidateProvider,
} from "./claim-compiler.js";
import { canonicalJson, sha256 } from "./crypto.js";
import { mapImpact, type ImpactMapperLimits } from "./impact-mapper.js";
import { planningIdentity, type PlanningIdentityInput } from "./proof-identity.js";
import { buildProofPlan } from "./proof-plan.js";
import {
  ProofPlanStore,
  type SealedProofPlanningRecord,
} from "./proof-plan-store.js";
import {
  parseTrustedReplayProfile,
  trustedReplayProfileDigest,
  type TrustedReplayProfile,
} from "./replay-profile.js";
import type { RepositorySnapshotProvider } from "./repository-snapshot.js";

const digestPattern = /^[a-f0-9]{64}$/;
const fullGitShaPattern = /^[0-9a-f]{40}$/;

export interface ClaimCompilerIdentity
  extends Omit<PlanningIdentityInput["compiler"], "promptDigest"> {}

export interface PrepareClaimProofInput {
  repository: string;
  pullRequest: number;
  baseSha: string;
  headSha: string;
  /** Exact synthetic merge commit to analyze and later execute. */
  mergeSha: string;
  title: string;
  description: string;
  diff: string;
  githubReadToken: string;
  trustedAuthorityReferences: readonly ClaimAuthorityReference[];
  baseContractDigest: string;
  policyHash: string;
  trustedArtifactDigest: string;
  compiler: ClaimCompilerIdentity;
  replayProfile: TrustedReplayProfile;
  workerId: string;
  leaseMs: number;
  impactLimits?: Partial<ImpactMapperLimits>;
}

export type PrepareClaimProofResult =
  | {
      state: "prepared";
      source: "created" | "reused";
      analysisKey: string;
      evidenceKey: string;
      record: SealedProofPlanningRecord;
    }
  | {
      state: "busy";
      analysisKey: string;
      retryAt: number;
    };

export interface ClaimProofCoordinatorDependencies {
  proofPlanStore: ProofPlanStore;
  claimCompilerProvider: ClaimCompilerCandidateProvider;
  repositorySnapshotProvider: RepositorySnapshotProvider;
  clock?: () => number;
}

export class ClaimProofPreparationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaimProofPreparationInputError";
  }
}

function assertDigest(value: string, label: string): string {
  if (!digestPattern.test(value)) {
    throw new ClaimProofPreparationInputError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function assertExactRevision(input: PrepareClaimProofInput): void {
  for (const [label, value] of [
    ["baseSha", input.baseSha],
    ["headSha", input.headSha],
    ["mergeSha", input.mergeSha],
  ] as const) {
    if (!fullGitShaPattern.test(value)) {
      throw new ClaimProofPreparationInputError(`${label} must be a full, lowercase Git SHA.`);
    }
  }
  if (input.baseSha === input.headSha) {
    throw new ClaimProofPreparationInputError("baseSha and headSha must identify different revisions.");
  }
}

function prepared(
  source: "created" | "reused",
  record: SealedProofPlanningRecord,
): PrepareClaimProofResult {
  return {
    state: "prepared",
    source,
    analysisKey: record.analysisKey,
    evidenceKey: record.bundle.evidenceKey,
    record,
  };
}

/**
 * Durable pre-run boundary for stochastic claim-to-proof planning.
 *
 * The analysis identity is claimed before repository I/O or a model call. A
 * sealed identity is immutable and short-circuits every later retry. The
 * compiler receives only its sanitized title/description envelope; the diff
 * and GitHub credential remain in deterministic controller-owned lanes.
 */
export class ClaimProofCoordinator {
  private readonly clock: () => number;

  constructor(private readonly dependencies: ClaimProofCoordinatorDependencies) {
    this.clock = dependencies.clock ?? Date.now;
  }

  async prepare(input: PrepareClaimProofInput): Promise<PrepareClaimProofResult> {
    assertExactRevision(input);
    const sanitizedCompilerInput = sanitizeClaimCompilerInput({
      repository: input.repository,
      pullRequest: input.pullRequest,
      baseSha: input.baseSha,
      headSha: input.headSha,
      title: input.title,
      description: input.description,
      trustedAuthorityReferences: input.trustedAuthorityReferences,
    });
    const replayProfile = parseTrustedReplayProfile(input.replayProfile);
    const replayProfileDigest = trustedReplayProfileDigest(replayProfile);
    const promptDigest = sha256(CLAIM_COMPILER_SYSTEM_INSTRUCTIONS);
    const boundTrustedArtifactDigest = sha256(
      canonicalJson({
        schemaVersion: 1,
        trustedArtifactDigest: assertDigest(
          input.trustedArtifactDigest,
          "trustedArtifactDigest",
        ),
        replayProfileDigest,
      }),
    );
    const analysisKey = planningIdentity({
      repository: input.repository,
      pullRequest: input.pullRequest,
      baseSha: input.baseSha,
      headSha: input.headSha,
      mergeSha: input.mergeSha,
      diffDigest: sha256(input.diff),
      issueContextDigest: sha256(canonicalJson(sanitizedCompilerInput)),
      baseContractDigest: assertDigest(input.baseContractDigest, "baseContractDigest"),
      policyHash: assertDigest(input.policyHash, "policyHash"),
      trustedArtifactDigest: boundTrustedArtifactDigest,
      compiler: {
        ...input.compiler,
        promptDigest,
      },
    });

    const claim = this.dependencies.proofPlanStore.claim(
      analysisKey,
      input.workerId,
      input.leaseMs,
      this.clock(),
    );
    if (claim.state === "sealed") return prepared("reused", claim.record);
    if (claim.state === "busy") {
      return { state: "busy", analysisKey, retryAt: claim.retryAt };
    }

    let lease = claim.lease;
    const repositoryFiles = await this.dependencies.repositorySnapshotProvider.fetchFiles({
      repository: input.repository,
      sha: input.mergeSha,
      githubReadToken: input.githubReadToken,
    });
    const impactMap = mapImpact({
      diff: input.diff,
      repositoryFiles,
      ...(input.impactLimits === undefined ? {} : { limits: input.impactLimits }),
    });

    // Refresh before and after the only stochastic operation. If another
    // worker has taken over, fencing fails closed before a plan can be sealed.
    lease = this.dependencies.proofPlanStore.renew(lease, input.leaseMs, this.clock());
    const claimContract = await compileClaimContract(this.dependencies.claimCompilerProvider, {
      repository: input.repository,
      pullRequest: input.pullRequest,
      baseSha: input.baseSha,
      headSha: input.headSha,
      title: input.title,
      description: input.description,
      trustedAuthorityReferences: input.trustedAuthorityReferences,
    });
    lease = this.dependencies.proofPlanStore.renew(lease, input.leaseMs, this.clock());

    const proofPlan = buildProofPlan({ claimContract, impactMap, replayProfile });
    const record = this.dependencies.proofPlanStore.seal(
      lease,
      { claimContract, impactMap, proofPlan, replayProfile },
      this.clock(),
    );
    return prepared("created", record);
  }
}
