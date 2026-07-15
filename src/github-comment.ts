import { redactSensitiveText } from "./agent-planner.js";
import type { EvidenceReceipt } from "./domain.js";

const managedMarker = "<!-- mergeproof:managed -->";

export interface PullRequestCommentGateway {
  upsert(input: {
    repository: string;
    pullRequest: number;
    receipt: EvidenceReceipt;
    eligibilityReason?: string;
  }): Promise<void>;
}

function safeText(value: string, maxLength = 300): string {
  return redactSensitiveText(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/https?:\/\/\S+/gi, "external-text-omitted")
    .replace(/[@`\[\]()<>{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function staticDetail(detail: string): string {
  // Anything after this delimiter may be command output from candidate source.
  return detail.split("Command outcome:")[0]?.trim() ?? "";
}

function verdictTitle(receipt: EvidenceReceipt): string {
  switch (receipt.verdict) {
    case "LOW_OBSERVED_RISK":
      return "MergeProof: low observed risk";
    case "BLOCK":
      return "MergeProof: automatic merge blocked";
    case "UNSUPPORTED":
      return "MergeProof: proof unsupported";
    default:
      return "MergeProof: maintainer review required";
  }
}

function renderChecks(receipt: EvidenceReceipt): string {
  const rows = receipt.pairedChecks
    .slice(0, 20)
    .map((check) => `| ${safeText(check.id, 80)} | ${check.base} | ${check.candidate} |`)
    .join("\n");
  return rows || "No paired checks were emitted.";
}

function renderMetrics(receipt: EvidenceReceipt): string {
  const rows = receipt.pairedMetrics
    .slice(0, 10)
    .map((metric) => `| ${safeText(metric.name, 80)} | ${metric.base ?? "missing"} | ${metric.candidate ?? "missing"} |`)
    .join("\n");
  return rows || "No paired metrics were emitted.";
}

function renderAdvisory(receipt: EvidenceReceipt): string {
  if (receipt.agentAnalysis.status !== "completed") {
    return "Agent analysis was unavailable or not configured; it did not affect this verdict.";
  }
  return "Advisory model findings remain sealed in the receipt and are not published to GitHub.";
}

function expectedScenarioOutcome(kind: EvidenceReceipt["issueToProof"]["scenarioBindings"][number]["kind"]): string {
  switch (kind) {
    case "base_fails_candidate_passes":
      return "base fails; candidate passes";
    case "both_revisions_pass":
      return "base passes; candidate passes";
    case "candidate_not_worse":
      return "candidate is not worse than base";
  }
}

/**
 * Deliberately renders only sealed identifiers and trusted observations. The
 * canonical issue title/body and planner-authored assertion never leave the
 * receipt's transient execution context.
 */
function renderIssueToProof(receipt: EvidenceReceipt): string {
  const issue = receipt.issueToProof.linkedIssue;
  const bindings = receipt.issueToProof.scenarioBindings;
  if (!issue && bindings.length === 0) {
    return "No Issue-to-Proof binding was required for this receipt.";
  }
  const rows = bindings
    .slice(0, 20)
    .map((binding) => {
      const observed = `${binding.base ?? "missing"} → ${binding.candidate ?? "missing"}`;
      return `| #${issue?.number ?? "unknown"} | ${safeText(binding.obligationId, 80)} | ${expectedScenarioOutcome(binding.kind)} | ${observed} | ${binding.status} |`;
    })
    .join("\n");
  return `The canonical issue is bound by digest to this receipt; its title and body are not published.\n\n| Issue | Policy obligation | Expected | Observed | Result |\n| --- | --- | --- | --- | --- |\n${rows || "| #" + (issue?.number ?? "unknown") + " | No validated scenario | — | — | missing |"}`;
}

/**
 * Renders a human-readable receipt without publishing candidate-controlled
 * command output or treating advisory model content as merge authority.
 */
export function renderEvidenceComment(receipt: EvidenceReceipt, eligibilityReason?: string): string {
  const reasons = receipt.reasons
    .slice(0, 10)
    .map((reason) => {
      const detail = safeText(staticDetail(reason.detail));
      return `- **${safeText(reason.code, 50)}** — ${safeText(reason.subject, 100)}${detail ? `: ${detail}` : ""}`;
    })
    .join("\n");
  const revision = receipt.revision;
  return `${managedMarker}
<!-- mergeproof:run=${receipt.runKey} -->
## ${verdictTitle(receipt)}

**Evidence verdict:** \`${receipt.verdict}\`<br>
**Policy:** \`${safeText(receipt.policy.version, 100)}\`<br>
**Revision:** base \`${safeText(revision.baseSha, 64)}\` → head \`${safeText(revision.headSha, 64)}\` → candidate \`${safeText(revision.mergeSha, 64)}\`

${eligibilityReason ? `**Automatic merge gate:** ${safeText(eligibilityReason)}\n` : ""}

${reasons || "All configured deterministic obligations passed."}

<details>
<summary>Observed deterministic checks</summary>

| Obligation | Base | Candidate |
| --- | --- | --- |
${renderChecks(receipt)}

</details>

<details>
<summary>Observed infrastructure metrics</summary>

| Metric | Base | Candidate |
| --- | --- | --- |
${renderMetrics(receipt)}

</details>

<details>
<summary>Issue-to-Proof bindings</summary>

${renderIssueToProof(receipt)}

</details>

<details>
<summary>Advisory agent review (never used for merge authority)</summary>

${renderAdvisory(receipt)}

</details>

Receipt integrity: \`${receipt.integrityHash}\``;
}

type GitHubComment = {
  id?: unknown;
  body?: unknown;
  user?: { id?: unknown } | null;
};

/**
 * Upserts one comment per PR, but only mutates a comment owned by the current
 * installation identity. A user cannot trick MergeProof into editing theirs by
 * copying the marker.
 */
export class GitHubPullRequestCommentGateway implements PullRequestCommentGateway {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
  ) {}

  async upsert(input: {
    repository: string;
    pullRequest: number;
    receipt: EvidenceReceipt;
    eligibilityReason?: string;
  }): Promise<void> {
    const authenticated = await this.request<{ id?: unknown }>("/user");
    if (typeof authenticated.id !== "number" || !Number.isSafeInteger(authenticated.id)) {
      throw new Error("GitHub installation identity response is missing a numeric id.");
    }
    const body = renderEvidenceComment(input.receipt, input.eligibilityReason);
    for (let page = 1; page <= 20; page += 1) {
      const comments = await this.request<GitHubComment[]>(
        `/repos/${input.repository}/issues/${input.pullRequest}/comments?per_page=100&sort=updated&direction=desc&page=${page}`,
      );
      const managed = comments.find(
        (comment) =>
          typeof comment.id === "number" &&
          typeof comment.body === "string" &&
          comment.user?.id === authenticated.id &&
          comment.body.includes(managedMarker),
      );
      if (managed && typeof managed.id === "number") {
        await this.request(`/repos/${input.repository}/issues/comments/${managed.id}`, {
          method: "PATCH",
          body: JSON.stringify({ body }),
        });
        return;
      }
      if (comments.length < 100) {
        break;
      }
    }
    await this.request(`/repos/${input.repository}/issues/${input.pullRequest}/comments`, {
      method: "POST",
      body: JSON.stringify({ body }),
    });
  }

  private async request<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${this.apiBase}${path}`, {
      ...init,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`GitHub PR comment API ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    return (await response.json()) as T;
  }
}
