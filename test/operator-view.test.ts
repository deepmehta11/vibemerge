import assert from "node:assert/strict";
import test from "node:test";

import { sealReceipt } from "../src/crypto.js";
import { demoRevision, demoVerificationPolicy, safeFixture } from "../src/fixtures.js";
import { FixtureEvidenceHarness } from "../src/harness.js";
import { RunLedger } from "../src/ledger.js";
import { toOperatorRunDetail } from "../src/operator-view.js";
import { VerificationEngine } from "../src/verifier.js";

test("operator receipt projection excludes sandbox, model, and candidate-command content", async () => {
  const ledger = new RunLedger();
  try {
    const claim = ledger.claim(demoRevision, "operator-test", 60_000, 10);
    assert.equal(claim.state, "claimed");
    if (claim.state !== "claimed") return;
    const receipt = await new VerificationEngine(new FixtureEvidenceHarness(safeFixture())).verify(
      demoRevision,
      demoVerificationPolicy,
      new Date(10),
    );
    receipt.reasons.push({
      code: "CHECK_FAILED",
      subject: "candidate output",
      detail: "Trusted detail. Command outcome: https://untrusted.example/ sk-test_abcdefghijklmnopqrstuvwxyz",
    });
    receipt.agentAnalysis = {
      status: "completed",
      model: "gpt-5.4",
      hypotheses: [
        {
          id: "secret-hypothesis",
          category: "security",
          claim: "sk-test_abcdefghijklmnopqrstuvwxyz",
          suggestedProbe: "do not expose",
          relatedObligationIds: [],
          confidence: "high",
        },
      ],
      challenges: [],
    };
    const { integrityHash: _oldIntegrityHash, ...unsignedReceipt } = receipt;
    ledger.recordReceipt(claim.lease, sealReceipt(unsignedReceipt), 11);
    const run = ledger.get(demoRevision);
    assert.ok(run);
    if (!run) return;
    const projected = JSON.stringify(toOperatorRunDetail(run));
    assert.match(projected, /Trusted detail/);
    assert.doesNotMatch(projected, /Command outcome|untrusted\.example|sk-test_|sandboxId|secret-hypothesis/);
    assert.match(projected, /hypothesisCount/);
  } finally {
    ledger.close();
  }
});
