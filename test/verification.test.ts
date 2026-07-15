import assert from "node:assert/strict";
import test from "node:test";

import { verifyReceipt } from "../src/crypto.js";
import {
  demoRevision,
  demoVerificationPolicy,
  incompleteFixture,
  resourceRegressionFixture,
  safeFixture,
} from "../src/fixtures.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import { VerificationEngine } from "../src/verifier.js";

test("a complete base-versus-candidate proof has a sealed low-risk receipt", async () => {
  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(safeFixture()),
  ).verify(demoRevision, demoVerificationPolicy, new Date("2026-07-14T18:00:00.000Z"));

  assert.equal(receipt.verdict, "LOW_OBSERVED_RISK");
  assert.equal(verifyReceipt(receipt), true);
  assert.equal(receipt.reasons.length, 0);
});

test("missing a required bug-reproduction observation forces human review", async () => {
  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(incompleteFixture()),
  ).verify(demoRevision, demoVerificationPolicy);

  assert.equal(receipt.verdict, "REVIEW");
  assert.match(receipt.reasons[0]?.detail ?? "", /required observation is missing/i);
});

test("a reproducible latency regression blocks automatic merge", async () => {
  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(resourceRegressionFixture()),
  ).verify(demoRevision, demoVerificationPolicy);

  assert.equal(receipt.verdict, "BLOCK");
  assert.equal(receipt.reasons[0]?.code, "RESOURCE_REGRESSION");
});

test("hunk closure may fail on the base when the candidate closes that changed behavior", async () => {
  const scenario = safeFixture();
  scenario.base.checks = scenario.base.checks.map((check) =>
    check.id === "changed-hunks" ? { ...check, status: "fail" } : check,
  );

  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(scenario),
  ).verify(demoRevision, demoVerificationPolicy);

  assert.equal(receipt.verdict, "LOW_OBSERVED_RISK");
  assert.equal(receipt.reasons.length, 0);
});

test("a candidate hunk-closure failure blocks automatic merge", async () => {
  const scenario = safeFixture();
  scenario.candidate.checks = scenario.candidate.checks.map((check) =>
    check.id === "changed-hunks" ? { ...check, status: "fail" } : check,
  );

  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(scenario),
  ).verify(demoRevision, demoVerificationPolicy);

  assert.equal(receipt.verdict, "BLOCK");
  assert.ok(receipt.reasons.some((reason) => reason.subject === "changed-hunks"));
});

test("an omitted policy-owned obligation cannot become low observed risk", async () => {
  const scenario = safeFixture();
  scenario.candidate.checks = scenario.candidate.checks.filter(
    (check) => check.id !== "duplicate-race",
  );
  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(scenario),
  ).verify(demoRevision, demoVerificationPolicy);

  assert.equal(receipt.verdict, "REVIEW");
  assert.ok(receipt.reasons.some((entry) => entry.subject === "duplicate-race"));
});

test("a receipt changed after sealing fails integrity verification", async () => {
  const receipt = await new VerificationEngine(
    new FixtureEvidenceHarness(safeFixture()),
  ).verify(demoRevision, demoVerificationPolicy);
  receipt.verdict = "BLOCK";

  assert.equal(verifyReceipt(receipt), false);
});
