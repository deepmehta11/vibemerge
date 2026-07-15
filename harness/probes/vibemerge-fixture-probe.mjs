import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const sourceDirectory = process.env.MERGEPROOF_SOURCE_DIR;
const scenario = process.argv[2];

if (!sourceDirectory) {
  throw new Error("MERGEPROOF_SOURCE_DIR is required.");
}

const checkoutModule = resolve(sourceDirectory, "src", "checkout.js");
if (!existsSync(checkoutModule)) {
  throw new Error("Fixture checkout module is missing.");
}

const { checkoutTotal } = await import(`${pathToFileURL(checkoutModule).href}?probe=${encodeURIComponent(scenario ?? "unknown")}`);
if (typeof checkoutTotal !== "function") {
  throw new Error("Fixture checkout module does not export checkoutTotal.");
}

function total(subtotalCents, discountPercent) {
  return checkoutTotal({ subtotalCents, discountPercent });
}

function fixtureCi() {
  assert.equal(total(1_000, 0), 1_000, "zero discount must preserve subtotal");
}

function issueReproduction() {
  // The base fixture intentionally treats a whole percentage as a multiplier;
  // this trusted assertion passes only after the candidate divides by 100.
  assert.equal(total(1_000, 10), 900, "a 10 percent discount must leave 900 cents");
}

function checkoutInvariants() {
  assert.equal(total(1_000, 0), 1_000, "zero percent must preserve the amount");
  assert.equal(total(1_000, 100), 0, "100 percent must produce a zero total");
}

function duplicateRace() {
  const values = Array.from({ length: 100 }, () => total(1_000, 0));
  assert.equal(new Set(values).size, 1, "repeated calculations must settle to one result");
  assert.equal(values[0], 1_000, "repeated calculations must retain the expected total");
}

switch (scenario) {
  case "fixture-ci":
    fixtureCi();
    break;
  case "issue-reproduction":
  case "changed-hunks":
    issueReproduction();
    break;
  case "checkout-invariants":
    checkoutInvariants();
    break;
  case "duplicate-race":
    duplicateRace();
    break;
  case "p95-latency":
    fixtureCi();
    process.stdout.write("2\n");
    break;
  case "peak-memory":
    fixtureCi();
    process.stdout.write("16\n");
    break;
  default:
    throw new Error(`Unknown fixture probe scenario: ${scenario ?? "missing"}`);
}
