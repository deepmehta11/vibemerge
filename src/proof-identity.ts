import { canonicalJson, sha256 } from "./crypto.js";

const digestPattern = /^[a-f0-9]{64}$/;
const coordinatePattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export interface PlanningIdentityInput {
  repository: string;
  pullRequest: number;
  baseSha: string;
  headSha: string;
  mergeSha: string;
  diffDigest: string;
  issueContextDigest: string;
  baseContractDigest: string;
  policyHash: string;
  trustedArtifactDigest: string;
  compiler: {
    model: string;
    promptDigest: string;
    schemaVersion: number;
    toolVersion: string;
  };
}

export interface EvidenceIdentityInput {
  analysisKey: string;
  claimContractDigest: string;
  impactMapDigest: string;
  proofPlanDigest: string;
  replayProfileDigest: string;
}

function assertDigest(value: string, label: string): string {
  if (!digestPattern.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 digest.`);
  }
  return value;
}

function assertCoordinate(value: string, label: string): string {
  if (!coordinatePattern.test(value) || value.includes("..") || /[\r\n\0]/.test(value)) {
    throw new Error(`${label} must be a bounded stable coordinate.`);
  }
  return value;
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

/**
 * Identifies the exact inputs and compiler contract used to create one durable
 * claim-to-proof plan. Stochastic output is generated only after this key is
 * durably claimed, so retries reuse the sealed normalized plan.
 */
export function planningIdentity(input: PlanningIdentityInput): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      repository: assertCoordinate(input.repository, "repository"),
      pullRequest: assertPositiveInteger(input.pullRequest, "pullRequest"),
      baseSha: assertCoordinate(input.baseSha, "baseSha"),
      headSha: assertCoordinate(input.headSha, "headSha"),
      mergeSha: assertCoordinate(input.mergeSha, "mergeSha"),
      diffDigest: assertDigest(input.diffDigest, "diffDigest"),
      issueContextDigest: assertDigest(input.issueContextDigest, "issueContextDigest"),
      baseContractDigest: assertDigest(input.baseContractDigest, "baseContractDigest"),
      policyHash: assertDigest(input.policyHash, "policyHash"),
      trustedArtifactDigest: assertDigest(input.trustedArtifactDigest, "trustedArtifactDigest"),
      compiler: {
        model: assertCoordinate(input.compiler.model, "compiler.model"),
        promptDigest: assertDigest(input.compiler.promptDigest, "compiler.promptDigest"),
        schemaVersion: assertPositiveInteger(input.compiler.schemaVersion, "compiler.schemaVersion"),
        toolVersion: assertCoordinate(input.compiler.toolVersion, "compiler.toolVersion"),
      },
    }),
  );
}
/**
 * Evidence deduplication begins only after every normalized dynamic input is
 * sealed. Two plans for the same Git revision therefore cannot share a run.
 */
export function evidenceIdentity(input: EvidenceIdentityInput): string {
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      analysisKey: assertDigest(input.analysisKey, "analysisKey"),
      claimContractDigest: assertDigest(input.claimContractDigest, "claimContractDigest"),
      impactMapDigest: assertDigest(input.impactMapDigest, "impactMapDigest"),
      proofPlanDigest: assertDigest(input.proofPlanDigest, "proofPlanDigest"),
      replayProfileDigest: assertDigest(input.replayProfileDigest, "replayProfileDigest"),
    }),
  );
}
