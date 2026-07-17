import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/crypto.js";
import { evidenceIdentity, planningIdentity } from "../src/proof-identity.js";

const digest = (value: string): string => sha256(value);

function planningInput() {
  return {
    repository: "acme/job-service",
    pullRequest: 42,
    baseSha: "base-123",
    headSha: "head-456",
    mergeSha: "merge-789",
    diffDigest: digest("diff"),
    issueContextDigest: digest("issue"),
    baseContractDigest: digest("base-contract"),
    policyHash: digest("policy"),
    trustedArtifactDigest: digest("artifacts"),
    compiler: {
      model: "gpt-5.4",
      promptDigest: digest("prompt"),
      schemaVersion: 1,
      toolVersion: "mergeproof-claim-compiler-v1",
    },
  };
}

test("planning identity changes for every compiler and authoritative input", () => {
  const base = planningInput();
  const first = planningIdentity(base);
  assert.match(first, /^[a-f0-9]{64}$/);
  for (const mutate of [
    (value: ReturnType<typeof planningInput>) => { value.diffDigest = digest("other-diff"); },
    (value: ReturnType<typeof planningInput>) => { value.issueContextDigest = digest("other-issue"); },
    (value: ReturnType<typeof planningInput>) => { value.compiler.promptDigest = digest("other-prompt"); },
    (value: ReturnType<typeof planningInput>) => { value.compiler.model = "gpt-5.4-mini"; },
  ]) {
    const changed = structuredClone(base);
    mutate(changed);
    assert.notEqual(planningIdentity(changed), first);
  }
});

test("evidence identity cannot hide a changed normalized plan behind one revision", () => {
  const analysisKey = planningIdentity(planningInput());
  const input = {
    analysisKey,
    claimContractDigest: digest("claim"),
    impactMapDigest: digest("impact"),
    proofPlanDigest: digest("proof-plan"),
    replayProfileDigest: digest("profile"),
  };
  const first = evidenceIdentity(input);
  assert.notEqual(evidenceIdentity({ ...input, proofPlanDigest: digest("other-plan") }), first);
  assert.notEqual(evidenceIdentity({ ...input, impactMapDigest: digest("other-impact") }), first);
});

test("identity constructors reject malformed or ambiguous coordinates", () => {
  assert.throws(() => planningIdentity({ ...planningInput(), policyHash: "not-a-digest" }));
  assert.throws(() => planningIdentity({ ...planningInput(), repository: "../escape" }));
});
