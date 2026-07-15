import type { HarnessResult, IssueToProofPlan, PinnedRevision } from "./domain.js";

export interface HarnessRequest {
  revision: PinnedRevision;
  phase: "base" | "candidate";
  /**
   * Validated declarative guidance for maintainer-owned probes. Harnesses may
   * expose it read-only, but it never supplies a command or changes a verdict.
   */
  advisoryPlan?: IssueToProofPlan;
}

export interface EvidenceHarness {
  readonly kind: string;
  collect(request: HarnessRequest): Promise<HarnessResult>;
}

export interface EvidenceHarnessFactory {
  /**
   * When present, the controller uses this duration for the durable evidence
   * run lease. Source-backed factories set it from their sealed sandbox
   * budget; fixture factories intentionally leave it undefined.
   */
  readonly verificationLeaseMs?: number;
  create(input: {
    revision: import("./domain.js").PinnedRevision;
    githubReadToken: string;
  }): EvidenceHarness;
}

export class HarnessUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessUnavailableError";
  }
}

export interface FixtureScenario {
  base: Omit<HarnessResult, "phase" | "sandboxId">;
  candidate: Omit<HarnessResult, "phase" | "sandboxId">;
}

/** A deterministic local harness for the product demo and regression tests. */
export class FixtureEvidenceHarness implements EvidenceHarness {
  readonly kind = "fixture";

  constructor(private readonly scenario: FixtureScenario) {}

  async collect(request: HarnessRequest): Promise<HarnessResult> {
    const value = request.phase === "base" ? this.scenario.base : this.scenario.candidate;
    return structuredClone({
      ...value,
      phase: request.phase,
      sandboxId: `fixture-${request.phase}-${request.revision.headSha.slice(0, 8)}`,
    });
  }
}
