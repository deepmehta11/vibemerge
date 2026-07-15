// The Agents SDK installs its own SIGTERM handler. Keep a normal CLI handler
// registered first so an outer process supervisor cannot make a successful
// request look like a clean early exit while the smoke assertion is pending.
import { writeFileSync } from "node:fs";

process.on("SIGTERM", () => undefined);

const { OpenAIProofPlanner, plannerLinkedIssueContext } = await import("./agent-planner.js");

const linkedIssue = { number: 42, source: "pull_request_description" as const };
const linkedIssueContext = plannerLinkedIssueContext(linkedIssue, {
  number: 42,
  title: "Duplicate checkout settlement permits a second payment",
  body: "Reject a duplicate request after the first payment settles.",
  isPullRequest: false,
});
if (!linkedIssueContext) {
  throw new Error("OpenAI planner smoke test could not construct canonical issue context.");
}

const planner = new OpenAIProofPlanner({
  model: process.env.MERGEPROOF_PLANNER_MODEL ?? "gpt-5.4",
});

// The SDK's HTTP handles may be unref'd. Keep this CLI process alive until the
// awaited structured result is checked, then release the timer immediately.
const keepAlive = setInterval(() => undefined, 1_000);
try {
  const analysis = await planner.analyze({
    repository: "acme/checkout-service",
    pullRequest: 42,
    title: "Prevent duplicate checkout settlement",
    description: "Fixes #42. Reject a duplicate request after the first payment settles.",
    diff: "diff --git a/checkout.ts b/checkout.ts\n+@@\n+if (paymentAlreadySettled(idempotencyKey)) return duplicateResponse();",
    requiredObligationIds: [
      "ci",
      "issue-reproduction",
      "checkout-invariants",
      "duplicate-race",
      "changed-hunks",
    ],
    issueToProof: {
      requireLinkedIssue: true,
      requiredObligationIds: ["issue-reproduction", "checkout-invariants"],
    },
    linkedIssue,
    linkedIssueContext,
  });

  if (analysis.status !== "completed") {
    throw new Error(`OpenAI planner smoke test did not complete: ${analysis.status}`);
  }
  process.stdout.write(
    `OpenAI planner smoke test passed (${analysis.hypotheses.length} hypotheses, ${analysis.challenges.length} challenges).\n`,
  );
  if (process.env.MERGEPROOF_SMOKE_OUTPUT_PATH) {
    writeFileSync(
      process.env.MERGEPROOF_SMOKE_OUTPUT_PATH,
      JSON.stringify({
        status: analysis.status,
        model: analysis.model ?? "unknown",
        hypothesisCount: analysis.hypotheses.length,
        challengeCount: analysis.challenges.length,
      }),
    );
  }
} finally {
  clearInterval(keepAlive);
}
