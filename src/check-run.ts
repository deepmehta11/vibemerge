import type { EvidenceReceipt } from "./domain.js";
import type { InstallationTokenProvider } from "./github-app.js";
import type { ExternalOperation } from "./ledger.js";

export interface CheckRunGateway {
  createInProgress(input: {
    repository: string;
    headSha: string;
    name: string;
    /** Stable operation identity used only to reconcile an interrupted publication. */
    externalId?: string;
  }): Promise<{ id: number }>;
  complete(input: {
    repository: string;
    checkRunId: number;
    receipt: EvidenceReceipt;
    /** A live merge-policy failure must not publish a successful required check. */
    conclusion?: "success" | "failure";
    summaryNote?: string;
  }): Promise<void>;
}

/**
 * Narrow recovery capability for a Check Run that was durably created but
 * remained in progress after its publisher lease expired. It has no success
 * operation: recovery can only complete the exact known Check Run as failure.
 */
export interface CheckRunFailureCloser {
  completeAsFailure(input: { operation: ExternalOperation; checkRunId: number }): Promise<void>;
}

function safeSummaryNote(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/https?:\/\/\S+/gi, "external-text-omitted")
    .replace(/[`<>\[\](){}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function summary(receipt: EvidenceReceipt): string {
  const claimProof = receipt.claimProof;
  const causalSummary = claimProof
    ? `Claim-to-proof ${claimProof.judgment.decision}; base → PR candidate → fix removed; plan ${claimProof.proofPlanDigest.slice(0, 16)}.`
    : "";
  if (receipt.reasons.length === 0) {
    return [
      `Sealed receipt ${receipt.integrityHash.slice(0, 16)} observed no policy failures.`,
      causalSummary,
    ].filter(Boolean).join("\n");
  }
  return [causalSummary, receipt.reasons
    .slice(0, 10)
    .map((reason) => {
      // Harness command output can be controlled by the candidate source. It
      // remains sealed in the receipt, but must not be rendered into GitHub.
      const trustedDetail = reason.detail.split("Command outcome:")[0]?.trim();
      return `- [${reason.code}] ${reason.subject}${trustedDetail ? `: ${trustedDetail.slice(0, 300)}` : ""}`;
    })
    .join("\n")].filter(Boolean).join("\n");
}

type CheckRunResponse = { id?: unknown };

/** GitHub Check Run publisher for the merge_group SHA, never a PR head SHA. */
export class GitHubCheckRunGateway implements CheckRunGateway {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
  ) {}

  async createInProgress(input: {
    repository: string;
    headSha: string;
    name: string;
    externalId?: string;
  }): Promise<{ id: number }> {
    const body = await this.request<CheckRunResponse>(`/repos/${input.repository}/check-runs`, {
      method: "POST",
      body: JSON.stringify({
        name: input.name,
        head_sha: input.headSha,
        ...(input.externalId ? { external_id: input.externalId } : {}),
        status: "in_progress",
        started_at: new Date().toISOString(),
        output: {
          title: "MergeProof is verifying this merge-group revision",
          summary: "Evidence collection is running in an isolated sandbox.",
        },
      }),
    });
    if (typeof body.id !== "number" || !Number.isSafeInteger(body.id)) {
      throw new Error("GitHub Check Run creation did not return an id.");
    }
    return { id: body.id };
  }

  async complete(input: {
    repository: string;
    checkRunId: number;
    receipt: EvidenceReceipt;
    conclusion?: "success" | "failure";
    summaryNote?: string;
  }): Promise<void> {
    const conclusion = input.conclusion ?? (
      input.receipt.verdict === "LOW_OBSERVED_RISK" ? "success" : "failure"
    );
    const evidenceSummary = summary(input.receipt);
    const note = input.summaryNote ? safeSummaryNote(input.summaryNote) : "";
    await this.request(`/repos/${input.repository}/check-runs/${input.checkRunId}`, {
      method: "PATCH",
      body: JSON.stringify({
        status: "completed",
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: `MergeProof: ${input.receipt.verdict}`,
          summary: [evidenceSummary, note ? `Live merge policy: ${note}` : ""].filter(Boolean).join("\n\n"),
          text: [
            `Receipt: ${input.receipt.integrityHash}`,
            `Policy: ${input.receipt.policy.version}`,
            ...(input.receipt.claimProof
              ? [
                  `Claim-to-proof plan: ${input.receipt.claimProof.proofPlanDigest}`,
                  `Evidence identity: ${input.receipt.claimProof.evidenceIdentity}`,
                ]
              : []),
          ].join("\n"),
        },
      }),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2026-03-10",
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub Check Run API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    return (await response.json()) as T;
  }
}

/**
 * Uses a fresh checks:write installation token only after the durable
 * reconciler proves that an exact Check Run is still in progress and its
 * original publisher lease has expired. A transport retry remains safe: every
 * mutation targets one known Check Run id and can only set failure.
 */
export class GitHubCheckRunFailureCloser implements CheckRunFailureCloser {
  constructor(
    private readonly tokens: InstallationTokenProvider,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
  ) {}

  async completeAsFailure(input: { operation: ExternalOperation; checkRunId: number }): Promise<void> {
    const operation = input.operation;
    if (
      operation.kind !== "check_run_publish" ||
      !operation.target.checkName ||
      !Number.isSafeInteger(input.checkRunId) ||
      input.checkRunId < 1
    ) {
      throw new Error("Interrupted Check Run recovery requires an exact Check Run publication operation.");
    }
    const token = await this.tokens.mint({
      installationId: operation.installationId,
      repository: operation.target.repository,
      permissions: { checks: "write" },
    });
    const response = await this.fetchImpl(
      `${this.apiBase}/repos/${operation.target.repository}/check-runs/${input.checkRunId}`,
      {
        method: "PATCH",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token.token}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: JSON.stringify({
          status: "completed",
          conclusion: "failure",
          completed_at: new Date().toISOString(),
          output: {
            title: "MergeProof: interrupted verification blocked",
            summary: "The original verification publisher did not finish before its lease expired. This Check Run was completed as failure; a fresh proof is required.",
            text: `Recovery operation: ${operation.operationId}`,
          },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub interrupted Check Run recovery returned HTTP ${response.status}.`);
    }
  }
}
