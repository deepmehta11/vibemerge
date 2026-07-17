import assert from "node:assert/strict";
import test from "node:test";

import {
  extractLinkedIssue,
  plannerLinkedIssueContext,
  redactSensitiveText,
  retryMalformedStructuredOutput,
  sanitizeUntrustedAgentInput,
  StaticProofPlanner,
  validateIssueToProofPlan,
} from "../src/agent-planner.js";
import { verifyReceipt } from "../src/crypto.js";
import type {
  AgentAnalysis,
  CanonicalGitHubIssue,
  IssueToProofPlan,
  PinnedRevision,
} from "../src/domain.js";
import {
  demoRevision,
  demoVerificationPolicy,
  resourceRegressionFixture,
  safeFixture,
} from "../src/fixtures.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import { VerificationEngine } from "../src/verifier.js";

const issueToProofPolicy = {
  ...demoVerificationPolicy,
  issueToProof: {
    requireLinkedIssue: true,
    requiredObligationIds: ["issue-reproduction", "checkout-invariants", "duplicate-race"],
  },
};

const linkedIssue = { number: 42, source: "pull_request_description" as const };
const canonicalIssue: CanonicalGitHubIssue = {
  number: 42,
  title: "Duplicate checkout settlement permits a second payment",
  body: "Reject a duplicate request after the first payment settles.",
  isPullRequest: false,
};

test("malformed advisory structured output receives one bounded retry", async () => {
  let calls = 0;
  const result = await retryMalformedStructuredOutput(async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error("Invalid output type: Unterminated string in JSON at position 200.");
    }
    return "valid structured response";
  });
  assert.equal(result, "valid structured response");
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(
    retryMalformedStructuredOutput(async () => {
      calls += 1;
      throw new Error("Invalid output type: Unterminated string in JSON at position 200.");
    }),
    /Invalid output type/,
  );
  assert.equal(calls, 2);
});

test("structured output retry supplies fixed schema guidance without echoing provider output", async () => {
  const feedback: Array<string | undefined> = [];
  const result = await retryMalformedStructuredOutput(async (retryGuidance) => {
    feedback.push(retryGuidance);
    if (!retryGuidance) {
      throw new Error(
        `Invalid output type: attacker-controlled-value ${"x".repeat(5_000)} ` +
          "Expected a canonical lower-case identifier.",
      );
    }
    return "corrected structured response";
  });

  assert.equal(result, "corrected structured response");
  assert.equal(feedback[0], undefined);
  assert.match(feedback[1] ?? "", /canonical lower-case identifier/);
  assert.doesNotMatch(feedback[1] ?? "", /attacker-controlled-value/);
  assert.ok((feedback[1] ?? "").length < 500);
});

function revisionForIssue(issue: CanonicalGitHubIssue = canonicalIssue): PinnedRevision {
  const context = plannerLinkedIssueContext(linkedIssue, issue);
  if (!context) throw new Error("Test issue must be a canonical issue.");
  return { ...demoRevision, issueContextDigest: context.contentDigest };
}

function issuePrContext(
  input: { title: string; description: string; diff: string },
  issue: CanonicalGitHubIssue = canonicalIssue,
) {
  return { ...input, linkedIssue, canonicalIssue: issue };
}

function validPlan(): IssueToProofPlan {
  return {
    schemaVersion: 1 as const,
    issueNumber: 42,
    scenarios: [
      {
        id: "reproduce-duplicate",
        obligationId: "issue-reproduction",
        kind: "base_fails_candidate_passes" as const,
        assertion: "The duplicate-payment defect fails on base and passes on candidate.",
      },
      {
        id: "preserve-checkout",
        obligationId: "checkout-invariants",
        kind: "both_revisions_pass" as const,
        assertion: "Existing checkout authorization and audit behavior remains intact.",
      },
      {
        id: "race-case",
        obligationId: "duplicate-race",
        kind: "both_revisions_pass" as const,
        assertion: "Concurrent duplicate requests settle at most one payment.",
      },
    ],
    limitation: "Guidance only; trusted probes provide observed evidence.",
  };
}

function sealedPlan(): IssueToProofPlan {
  const plan = validPlan();
  return {
    ...plan,
    scenarios: plan.scenarios.map((scenario, index) => ({
      ...scenario,
      id: `scenario-${index + 1}`,
      assertion: "Structural advisory guidance is intentionally not retained.",
    })),
    limitation: "Trusted probes remain the only observed evidence authority.",
  };
}

test("untrusted agent input is bounded and strips terminal control sequences", () => {
  assert.equal(
    sanitizeUntrustedAgentInput("hello\u001b[2J\u0000world", 100),
    "helloworld",
  );
  assert.equal(sanitizeUntrustedAgentInput("abcdef", 3), "abc");
  assert.equal(
    redactSensitiveText("token sk-proj-abcdefghijklmnopqrstuvwxyz0123456789"),
    "token [REDACTED_SECRET]",
  );
  assert.deepEqual(extractLinkedIssue("Fixes #42\n\nDetails"), {
    number: 42,
    source: "pull_request_description",
  });
  assert.equal(extractLinkedIssue("Related to #42"), null);
});

test("canonical issue content is bounded for planning, sealed only as metadata, and changes proof identity", async () => {
  const issue: CanonicalGitHubIssue = {
    number: 42,
    title: "Canonical issue title\u001b[2J\u0000",
    body: `credential-shaped-value ${"x".repeat(8_100)}`,
    isPullRequest: false,
  };
  const changedIssue = { ...issue, body: `${issue.body} changed` };
  const context = plannerLinkedIssueContext(linkedIssue, issue);
  const changedContext = plannerLinkedIssueContext(linkedIssue, changedIssue);
  assert.ok(context);
  assert.ok(changedContext);
  if (!context || !changedContext) return;
  assert.equal(context.title, "Canonical issue title");
  assert.equal(context.body.length, 8_000);
  assert.notEqual(context.contentDigest, changedContext.contentDigest);

  let plannerInput: import("../src/agent-planner.js").PlannerInput | undefined;
  const planner = {
    analyze: async (input: import("../src/agent-planner.js").PlannerInput): Promise<AgentAnalysis> => {
      plannerInput = input;
      return {
        status: "completed",
        hypotheses: [],
        challenges: [],
        issueToProofPlan: validPlan(),
      };
    },
  };
  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(safeFixture()),
    planner,
  ).verify(
    revisionForIssue(issue),
    issueToProofPolicy,
    new Date("2026-07-14T18:00:00.000Z"),
    issuePrContext({ title: "Fix duplicate settlement", description: "Fixes #42.", diff: "fixture" }, issue),
  );
  const changedReceipt = await new VerificationEngine(
    new FixtureEvidenceHarness(safeFixture()),
    new StaticProofPlanner({
      status: "completed",
      hypotheses: [],
      challenges: [],
      issueToProofPlan: validPlan(),
    }),
  ).verify(
    revisionForIssue(changedIssue),
    issueToProofPolicy,
    new Date("2026-07-14T18:00:00.000Z"),
    issuePrContext({ title: "Fix duplicate settlement", description: "Fixes #42.", diff: "fixture" }, changedIssue),
  );

  assert.equal(plannerInput?.linkedIssueContext?.contentDigest, context.contentDigest);
  assert.equal(plannerInput?.linkedIssueContext?.body.length, 8_000);
  assert.deepEqual(receipt.issueToProof.linkedIssue, {
    number: 42,
    source: "pull_request_description",
    contentDigest: context.contentDigest,
    titleBytes: context.titleBytes,
    bodyBytes: context.bodyBytes,
  });
  const sealedContext = JSON.stringify(receipt.issueToProof);
  assert.equal(sealedContext.includes(issue.title), false);
  assert.equal(sealedContext.includes(issue.body), false);
  assert.equal(receipt.revision.issueContextDigest, context.contentDigest);
  assert.notEqual(receipt.runKey, changedReceipt.runKey);
});

test("Issue-to-Proof fails closed when canonical issue content is absent or does not match the revision digest", async () => {
  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(safeFixture()),
    new StaticProofPlanner({
      status: "completed",
      hypotheses: [],
      challenges: [],
      issueToProofPlan: validPlan(),
    }),
  ).verify(
    { ...demoRevision, issueContextDigest: "stale-issue-content-digest" },
    issueToProofPolicy,
    new Date("2026-07-14T18:00:00.000Z"),
    issuePrContext({ title: "Fix duplicate settlement", description: "Fixes #42.", diff: "fixture" }),
  );

  assert.equal(receipt.verdict, "REVIEW");
  assert.equal(receipt.issueToProof.linkedIssue, null);
  assert.equal(receipt.agentAnalysis.status, "failed");
  assert.match(
    receipt.reasons.find((reason) => reason.subject === "linked-issue")?.detail ?? "",
    /canonical GitHub issue context/i,
  );
});

test("a valid fixed-DSL Issue-to-Proof plan is sealed and delivered only as harness guidance", async () => {
  const analysis: AgentAnalysis = {
    status: "completed",
    model: "test-model",
    hypotheses: [
      {
        id: "duplicate-race-hypothesis",
        category: "concurrency",
        claim: "A duplicate request may race the settlement write.",
        suggestedProbe: "Barrier two requests on one idempotency key.",
        relatedObligationIds: ["duplicate-race"],
        confidence: "high",
      },
    ],
    challenges: [
      {
        hypothesisId: "duplicate-race-hypothesis",
        challenge: "The lock may be released before the audit write.",
        suggestedCounterexample: "Force audit write to yield before commit.",
        severity: "medium",
      },
    ],
    limitation: "Static test planner.",
    issueToProofPlan: validPlan(),
  };
  const stages: string[] = [];
  const planner = {
    analyze: async () => {
      stages.push("planner");
      return structuredClone(analysis);
    },
  };
  const seenPlans: unknown[] = [];
  const fixture = new FixtureEvidenceHarness(safeFixture());
  const receipt = await new VerificationEngine(
    {
      kind: "capturing-fixture",
      collect: async (request) => {
        stages.push(`harness:${request.phase}`);
        seenPlans.push(request.advisoryPlan);
        return fixture.collect(request);
      },
    },
    planner,
  ).verify(revisionForIssue(), issueToProofPolicy, new Date("2026-07-14T18:00:00.000Z"), issuePrContext({
    title: "Prevent duplicate checkout settlement",
    description: "Fixes #42. Fixture.",
    diff: "diff --git a/checkout.ts b/checkout.ts",
  }));

  assert.equal(receipt.verdict, "LOW_OBSERVED_RISK");
  assert.equal(receipt.deterministicVerdict, "LOW_OBSERVED_RISK");
  assert.equal(receipt.agentAnalysis.status, "completed");
  assert.equal(receipt.agentAnalysis.hypotheses.length, 1);
  assert.equal(receipt.agentAnalysis.issueToProofPlan?.scenarios.length, 3);
  assert.equal(receipt.issueToProof.linkedIssue?.number, 42);
  assert.deepEqual(
    receipt.issueToProof.scenarioBindings.map((binding) => ({
      scenarioId: binding.scenarioId,
      pairedCheckId: binding.pairedCheckId,
      base: binding.base,
      candidate: binding.candidate,
      status: binding.status,
    })),
    [
      {
        scenarioId: "scenario-1",
        pairedCheckId: "issue-reproduction",
        base: "fail",
        candidate: "pass",
        status: "satisfied",
      },
      {
        scenarioId: "scenario-2",
        pairedCheckId: "checkout-invariants",
        base: "pass",
        candidate: "pass",
        status: "satisfied",
      },
      {
        scenarioId: "scenario-3",
        pairedCheckId: "duplicate-race",
        base: "pass",
        candidate: "pass",
        status: "satisfied",
      },
    ],
  );
  assert.deepEqual(seenPlans, [sealedPlan(), sealedPlan()]);
  assert.equal(stages[0], "planner");
  assert.deepEqual(new Set(stages.slice(1)), new Set(["harness:base", "harness:candidate"]));
  assert.equal(verifyReceipt(receipt), true);
  receipt.issueToProof.scenarioBindings[0]!.status = "unmet";
  assert.equal(verifyReceipt(receipt), false);
});

test("canonical issue and model prose never survive into receipts or trusted probe guidance", async () => {
  const privateIssue: CanonicalGitHubIssue = {
    number: 42,
    title: "PRIVATE_ISSUE_TITLE_7d72a",
    body: "PRIVATE_ISSUE_BODY_c91f4 must never be stored in MergeProof evidence.",
    isPullRequest: false,
  };
  const echoedModelText = "MODEL_ECHO_42a8d advisory prose must not become durable evidence.";
  const rawPlan = validPlan();
  rawPlan.scenarios = rawPlan.scenarios.map((scenario) => ({
    ...scenario,
    id: `echo-${scenario.id}`,
    assertion: `${privateIssue.title} ${privateIssue.body} ${echoedModelText}`,
  }));
  rawPlan.limitation = echoedModelText;
  const observedPlans: unknown[] = [];
  const fixture = new FixtureEvidenceHarness(safeFixture());
  const receipt = await new VerificationEngine(
    {
      kind: "capturing-fixture",
      collect: async (request) => {
        observedPlans.push(request.advisoryPlan);
        return fixture.collect(request);
      },
    },
    new StaticProofPlanner({
      status: "completed",
      model: privateIssue.body,
      hypotheses: [{
        id: echoedModelText,
        category: "security",
        claim: `${privateIssue.body} ${echoedModelText}`,
        suggestedProbe: `${privateIssue.title} ${echoedModelText}`,
        relatedObligationIds: ["issue-reproduction", "invented-model-obligation"],
        confidence: "high",
      }],
      challenges: [{
        hypothesisId: echoedModelText,
        challenge: `${privateIssue.body} ${echoedModelText}`,
        suggestedCounterexample: `${privateIssue.title} ${echoedModelText}`,
        severity: "high",
      }],
      limitation: `${privateIssue.body} ${echoedModelText}`,
      issueToProofPlan: rawPlan,
    }),
  ).verify(
    revisionForIssue(privateIssue),
    issueToProofPolicy,
    new Date("2026-07-14T18:00:00.000Z"),
    issuePrContext(
      { title: "Safe PR title", description: "Fixes #42.", diff: "fixture" },
      privateIssue,
    ),
  );

  const durable = JSON.stringify({ receipt, observedPlans });
  for (const privateText of [privateIssue.title, privateIssue.body, echoedModelText]) {
    assert.equal(durable.includes(privateText), false, privateText);
  }
  assert.deepEqual(observedPlans, [sealedPlan(), sealedPlan()]);
  assert.deepEqual(receipt.agentAnalysis.hypotheses[0]?.relatedObligationIds, ["issue-reproduction"]);
  assert.equal(receipt.agentAnalysis.hypotheses[0]?.claim, "Structural advisory hypothesis is intentionally not retained.");
  assert.equal(receipt.agentAnalysis.challenges[0]?.challenge, "Structural advisory challenge is intentionally not retained.");
});

test("Issue-to-Proof semantics fail closed when a model scenario contradicts paired evidence", async () => {
  const contradictoryPlan = validPlan();
  contradictoryPlan.scenarios[0]!.kind = "both_revisions_pass";

  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(safeFixture()),
    new StaticProofPlanner({
      status: "completed",
      hypotheses: [],
      challenges: [],
      issueToProofPlan: contradictoryPlan,
    }),
  ).verify(revisionForIssue(), issueToProofPolicy, new Date("2026-07-14T18:00:00.000Z"), issuePrContext({
    title: "Prevent duplicate checkout settlement",
    description: "Fixes #42.",
    diff: "fixture",
  }));

  assert.equal(receipt.deterministicVerdict, "LOW_OBSERVED_RISK");
  assert.equal(receipt.verdict, "REVIEW");
  assert.deepEqual(receipt.issueToProof.scenarioBindings[0], {
    scenarioId: "scenario-1",
    obligationId: "issue-reproduction",
    kind: "both_revisions_pass",
    pairedCheckId: "issue-reproduction",
    checkKind: "bug_reproduction",
    base: "fail",
    candidate: "pass",
    status: "unmet",
    detail: "Expected base=pass and candidate=pass; observed base=fail and candidate=pass.",
  });
  assert.ok(receipt.reasons.some((reason) => reason.subject === "scenario-1"));
});

test("candidate-not-worse scenarios reject a regression even when the base policy does not require that check", async () => {
  const scenario = safeFixture();
  scenario.base.checks = scenario.base.checks.map((check) =>
    check.id === "issue-reproduction" ? { ...check, status: "pass" } : check,
  );
  scenario.candidate.checks = scenario.candidate.checks.map((check) =>
    check.id === "issue-reproduction" ? { ...check, status: "fail" } : check,
  );
  const candidateNotWorsePlan = validPlan();
  candidateNotWorsePlan.scenarios[0]!.kind = "candidate_not_worse";
  const policy = { ...issueToProofPolicy, requireBugReproduction: false };

  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(scenario),
    new StaticProofPlanner({
      status: "completed",
      hypotheses: [],
      challenges: [],
      issueToProofPlan: candidateNotWorsePlan,
    }),
  ).verify(revisionForIssue(), policy, new Date("2026-07-14T18:00:00.000Z"), issuePrContext({
    title: "Prevent duplicate checkout settlement",
    description: "Fixes #42.",
    diff: "fixture",
  }));

  assert.equal(receipt.deterministicVerdict, "LOW_OBSERVED_RISK");
  assert.equal(receipt.verdict, "REVIEW");
  assert.equal(receipt.issueToProof.scenarioBindings[0]?.status, "unmet");
  assert.match(receipt.issueToProof.scenarioBindings[0]?.detail ?? "", /at least as good/i);
});

test("candidate-not-worse scenarios seal an observed non-regression", async () => {
  const candidateNotWorsePlan = validPlan();
  candidateNotWorsePlan.scenarios[2]!.kind = "candidate_not_worse";

  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(safeFixture()),
    new StaticProofPlanner({
      status: "completed",
      hypotheses: [],
      challenges: [],
      issueToProofPlan: candidateNotWorsePlan,
    }),
  ).verify(revisionForIssue(), issueToProofPolicy, new Date("2026-07-14T18:00:00.000Z"), issuePrContext({
    title: "Prevent duplicate checkout settlement",
    description: "Fixes #42.",
    diff: "fixture",
  }));

  assert.equal(receipt.verdict, "LOW_OBSERVED_RISK");
  assert.equal(receipt.issueToProof.scenarioBindings[2]?.status, "satisfied");
  assert.match(
    receipt.issueToProof.scenarioBindings[2]?.detail ?? "",
    /at least as good/i,
  );
});

test("an Issue-to-Proof scenario cannot bind to a missing policy-owned obligation", async () => {
  const scenario = safeFixture();
  scenario.base.checks = scenario.base.checks.filter((check) => check.id !== "checkout-invariants");
  scenario.candidate.checks = scenario.candidate.checks.filter(
    (check) => check.id !== "checkout-invariants",
  );

  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(scenario),
    new StaticProofPlanner({
      status: "completed",
      hypotheses: [],
      challenges: [],
      issueToProofPlan: validPlan(),
    }),
  ).verify(revisionForIssue(), issueToProofPolicy, new Date("2026-07-14T18:00:00.000Z"), issuePrContext({
    title: "Prevent duplicate checkout settlement",
    description: "Fixes #42.",
    diff: "fixture",
  }));

  assert.equal(receipt.verdict, "REVIEW");
  assert.deepEqual(receipt.issueToProof.scenarioBindings[1], {
    scenarioId: "scenario-2",
    obligationId: "checkout-invariants",
    kind: "both_revisions_pass",
    pairedCheckId: null,
    checkKind: null,
    base: null,
    candidate: null,
    status: "missing",
    detail: "No unique paired check was observed for this policy-owned obligation.",
  });
});

test("an Issue-to-Proof scenario cannot bind to a harness-downgraded obligation", async () => {
  const scenario = safeFixture();
  scenario.base.checks = scenario.base.checks.map((check) =>
    check.id === "checkout-invariants" ? { ...check, required: false } : check,
  );
  scenario.candidate.checks = scenario.candidate.checks.map((check) =>
    check.id === "checkout-invariants" ? { ...check, required: false } : check,
  );

  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(scenario),
    new StaticProofPlanner({
      status: "completed",
      hypotheses: [],
      challenges: [],
      issueToProofPlan: validPlan(),
    }),
  ).verify(revisionForIssue(), issueToProofPolicy, new Date("2026-07-14T18:00:00.000Z"), issuePrContext({
    title: "Prevent duplicate checkout settlement",
    description: "Fixes #42.",
    diff: "fixture",
  }));

  assert.equal(receipt.verdict, "REVIEW");
  assert.equal(receipt.issueToProof.scenarioBindings[1]?.pairedCheckId, "checkout-invariants");
  assert.equal(receipt.issueToProof.scenarioBindings[1]?.status, "unmet");
  assert.match(
    receipt.issueToProof.scenarioBindings[1]?.detail ?? "",
    /not a policy-required/i,
  );
});

test("a plan is not accepted outside the explicit Issue-to-Proof policy gate", () => {
  const validation = validateIssueToProofPlan(validPlan(), {
    requiredObligationIds: demoVerificationPolicy.requiredCheckIds,
    linkedIssue,
    linkedIssueContext: null,
  });

  assert.equal(validation.ok, false);
});

test("unknown model obligation is rejected before trusted probes see a plan", async () => {
  const invalidPlan = validPlan();
  invalidPlan.scenarios[0]!.obligationId = "invented-model-obligation";
  const validation = validateIssueToProofPlan(invalidPlan, {
    requiredObligationIds: issueToProofPolicy.requiredCheckIds,
    issueToProof: issueToProofPolicy.issueToProof,
    linkedIssue,
    linkedIssueContext: plannerLinkedIssueContext(linkedIssue, canonicalIssue),
  });
  assert.equal(validation.ok, false);

  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(safeFixture()),
    new StaticProofPlanner({
      status: "completed",
      hypotheses: [],
      challenges: [],
      issueToProofPlan: invalidPlan,
    }),
  ).verify(revisionForIssue(), issueToProofPolicy, new Date("2026-07-14T18:00:00.000Z"), issuePrContext({
    title: "Prevent duplicate checkout settlement",
    description: "Fixes #42.",
    diff: "fixture",
  }));

  assert.equal(receipt.deterministicVerdict, "LOW_OBSERVED_RISK");
  assert.equal(receipt.verdict, "REVIEW");
  assert.equal(receipt.agentAnalysis.status, "failed");
  assert.equal(receipt.agentAnalysis.issueToProofPlan, undefined);
});

test("an advisory plan cannot elevate a deterministic infrastructure block", async () => {
  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(resourceRegressionFixture()),
    new StaticProofPlanner({
      status: "completed",
      hypotheses: [],
      challenges: [],
      issueToProofPlan: validPlan(),
    }),
  ).verify(revisionForIssue(), issueToProofPolicy, new Date("2026-07-14T18:00:00.000Z"), issuePrContext({
    title: "Prevent duplicate checkout settlement",
    description: "Fixes #42.",
    diff: "fixture",
  }));

  assert.equal(receipt.deterministicVerdict, "BLOCK");
  assert.equal(receipt.verdict, "BLOCK");
  assert.ok(receipt.reasons.some((reason) => reason.code === "RESOURCE_REGRESSION"));
});
