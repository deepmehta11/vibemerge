import { redactSensitiveText } from "./agent-planner.js";
import type { EvidenceReceipt } from "./domain.js";
import type { AutomationControl, LedgerRun, OperatorLedgerStats, RunDecision } from "./ledger.js";

export interface OperatorPolicySummary {
  autoMergeEnabled: boolean;
  mergeStrategy: "direct_fixture" | "github_api" | "merge_queue";
  allowedRepositoryCount: number;
}

export interface OperatorDecision {
  stage: RunDecision["stage"];
  state: RunDecision["state"];
  outcome: RunDecision["outcome"];
  reason: string;
  decidedAt: string;
}

export interface OperatorRunSummary {
  runKey: string;
  status: LedgerRun["status"];
  outcome: LedgerRun["outcome"];
  updatedAt: number;
  decision: OperatorDecision | null;
  revision?: {
    repository: string;
    pullRequest: number;
    baseSha: string;
    headSha: string;
    mergeSha: string;
  };
  evidence?: {
    verdict: EvidenceReceipt["verdict"];
    observedAt: string;
    policyVersion: string;
    integrityHash: string;
  };
}

export interface OperatorRunDetail extends Omit<OperatorRunSummary, "evidence"> {
  evidence?: NonNullable<OperatorRunSummary["evidence"]> & {
    reasons: Array<{ code: string; subject: string; detail: string }>;
    checks: Array<{
      id: string;
      kind: string;
      required: boolean;
      base: string;
      candidate: string;
    }>;
    metrics: Array<{
      name: string;
      required: boolean;
      base: number | null;
      candidate: number | null;
      threshold?: { maxRatio: number; maxAbsolute: number };
    }>;
    agent: {
      status: EvidenceReceipt["agentAnalysis"]["status"];
      model?: string;
      hypothesisCount: number;
      challengeCount: number;
    };
  };
}

export interface OperatorOverview {
  generatedAt: string;
  policy: OperatorPolicySummary;
  automation: AutomationControl;
  stats: OperatorLedgerStats;
  reconciliationRequired: number;
}

function safeText(value: string, maxLength = 300): string {
  return redactSensitiveText(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/https?:\/\/\S+/gi, "external-text-omitted")
    .replace(/[`<>{}\[\]@()]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function staticDetail(value: string): string {
  return value.split("Command outcome:")[0]?.trim() ?? "";
}

function projectDecision(decision: RunDecision | null): OperatorDecision | null {
  if (!decision) {
    return null;
  }
  return {
    stage: decision.stage,
    state: decision.state,
    outcome: decision.outcome,
    reason: safeText(staticDetail(decision.reason), 500),
    decidedAt: decision.decidedAt,
  };
}

export function toOperatorRunSummary(run: LedgerRun): OperatorRunSummary {
  const receipt = run.receipt;
  return {
    runKey: run.runKey,
    status: run.status,
    outcome: run.outcome,
    updatedAt: run.updatedAt,
    decision: projectDecision(run.decision),
    ...(receipt
      ? {
          revision: {
            repository: safeText(receipt.revision.repository, 200),
            pullRequest: receipt.revision.pullRequest,
            baseSha: receipt.revision.baseSha,
            headSha: receipt.revision.headSha,
            mergeSha: receipt.revision.mergeSha,
          },
          evidence: {
            verdict: receipt.verdict,
            observedAt: receipt.observedAt,
            policyVersion: safeText(receipt.policy.version, 160),
            integrityHash: receipt.integrityHash,
          },
        }
      : {}),
  };
}

/**
 * Allowlist the fields appropriate for an authenticated operator console. Raw
 * webhook bodies, PR content, sandbox ids, probe output, and advisory text are
 * intentionally absent even here.
 */
export function toOperatorRunDetail(run: LedgerRun): OperatorRunDetail {
  const summary = toOperatorRunSummary(run);
  if (!run.receipt || !summary.evidence) {
    const { evidence: _evidence, ...withoutEvidence } = summary;
    return withoutEvidence;
  }
  const receipt = run.receipt;
  return {
    ...summary,
    evidence: {
      ...summary.evidence,
      reasons: receipt.reasons.slice(0, 20).map((reason) => ({
        code: safeText(reason.code, 80),
        subject: safeText(reason.subject, 160),
        detail: safeText(staticDetail(reason.detail), 500),
      })),
      checks: receipt.pairedChecks.slice(0, 50).map((check) => ({
        id: safeText(check.id, 120),
        kind: check.kind,
        required: check.required,
        base: check.base,
        candidate: check.candidate,
      })),
      metrics: receipt.pairedMetrics.slice(0, 20).map((metric) => ({
        name: metric.name,
        required: metric.required,
        base: metric.base,
        candidate: metric.candidate,
        ...(receipt.policy.metricThresholds[metric.name]
          ? { threshold: receipt.policy.metricThresholds[metric.name] }
          : {}),
      })),
      agent: {
        status: receipt.agentAnalysis.status,
        ...(receipt.agentAnalysis.model ? { model: safeText(receipt.agentAnalysis.model, 120) } : {}),
        hypothesisCount: receipt.agentAnalysis.hypotheses.length,
        challengeCount: receipt.agentAnalysis.challenges.length,
      },
    },
  };
}

export function toOperatorOverview(
  policy: OperatorPolicySummary,
  stats: OperatorLedgerStats,
  automation: AutomationControl,
  now = new Date(),
): OperatorOverview {
  return {
    generatedAt: now.toISOString(),
    policy,
    automation,
    stats,
    reconciliationRequired: stats.runs.publishing + stats.runs.merge_unknown,
  };
}
