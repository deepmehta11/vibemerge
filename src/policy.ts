import type {
  PairedCheck,
  PairedMetric,
  VerificationPolicy,
  VerificationVerdict,
  VerdictReason,
} from "./domain.js";

export interface PolicyEvaluation {
  verdict: VerificationVerdict;
  reasons: VerdictReason[];
}

function reason(
  code: VerdictReason["code"],
  subject: string,
  detail: string,
): VerdictReason {
  return { code, subject, detail };
}

function mustPass(check: PairedCheck): boolean {
  if (!check.required) {
    return false;
  }
  return (
    check.kind === "deterministic_gate" ||
    check.kind === "protected_behavior" ||
    check.kind === "adversarial"
  );
}

function checkIsRequired(check: PairedCheck, policy: VerificationPolicy): boolean {
  if (!check.required) {
    return false;
  }
  if (check.kind === "bug_reproduction") {
    return policy.requireBugReproduction;
  }
  if (check.kind === "adversarial") {
    return policy.requireAdversarialChecks;
  }
  if (check.kind === "hunk_closure") {
    return policy.requireHunkClosure;
  }
  return true;
}

export function evaluateEvidence(
  checks: PairedCheck[],
  metrics: PairedMetric[],
  policy: VerificationPolicy,
): PolicyEvaluation {
  const unsupported: VerdictReason[] = [];
  const blocked: VerdictReason[] = [];
  const incomplete: VerdictReason[] = [];

  for (const check of checks) {
    if (!checkIsRequired(check, policy)) {
      continue;
    }

    if (check.base === "unsupported" || check.candidate === "unsupported") {
      unsupported.push(
        reason("UNSUPPORTED_PROOF", check.id, `${check.detail}: sandbox harness cannot run this proof.`),
      );
      continue;
    }

    if (check.base === "unknown" || check.candidate === "unknown") {
      incomplete.push(
        reason("INCOMPLETE_PROOF", check.id, `${check.detail}: a required observation is missing.`),
      );
      continue;
    }

    if (check.kind === "bug_reproduction") {
      if (check.candidate === "fail") {
        blocked.push(
          reason("CHECK_FAILED", check.id, `${check.detail}: the candidate still reproduces the reported bug.`),
        );
      } else if (check.base !== "fail") {
        incomplete.push(
          reason("INCOMPLETE_PROOF", check.id, `${check.detail}: the base revision did not reproduce the bug.`),
        );
      }
      continue;
    }

    if (check.kind === "hunk_closure") {
      // A hunk-closure probe may intentionally observe the defect on the base
      // revision. Its obligation is that the candidate closes the observed
      // behavior; requiring a base pass would make a proven bug fix impossible
      // to merge.
      if (check.candidate === "fail") {
        blocked.push(
          reason("CHECK_FAILED", check.id, `${check.detail}: the candidate did not close the changed behavior.`),
        );
      }
      continue;
    }

    if (mustPass(check) && (check.base === "fail" || check.candidate === "fail")) {
      blocked.push(
        reason("CHECK_FAILED", check.id, `${check.detail}: a required check failed.`),
      );
    }
  }

  for (const metric of metrics) {
    if (!metric.required) {
      continue;
    }
    const threshold = policy.metricThresholds[metric.name];
    if (!threshold) {
      incomplete.push(
        reason("INCOMPLETE_PROOF", metric.name, "No resource threshold is configured for this required metric."),
      );
      continue;
    }
    if (metric.base === null || metric.candidate === null) {
      incomplete.push(
        reason("INCOMPLETE_PROOF", metric.name, `${metric.detail}: a required baseline or candidate metric is missing.`),
      );
      continue;
    }

    const permitted =
      metric.base > 0
        ? metric.base * threshold.maxRatio
        : threshold.maxAbsolute;
    if (metric.candidate > permitted) {
      blocked.push(
        reason(
          "RESOURCE_REGRESSION",
          metric.name,
          `${metric.detail}: observed ${metric.candidate}, permitted at most ${permitted}.`,
        ),
      );
    }
  }

  if (unsupported.length > 0) {
    return { verdict: "UNSUPPORTED", reasons: unsupported };
  }
  if (blocked.length > 0) {
    return { verdict: "BLOCK", reasons: blocked };
  }
  if (incomplete.length > 0) {
    return { verdict: "REVIEW", reasons: incomplete };
  }
  return { verdict: "LOW_OBSERVED_RISK", reasons: [] };
}
