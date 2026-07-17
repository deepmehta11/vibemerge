import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyReverseUnifiedDiff, parseReverseAblationDiff } from "../harness/reverse-unified-diff.mjs";

const diff = `diff --git a/src/jobs.mjs b/src/jobs.mjs
--- a/src/jobs.mjs
+++ b/src/jobs.mjs
@@ -1,4 +1,6 @@
 export function generate(state) {
-  state.count += 1;
+  if (state.count === 0) {
+    state.count += 1;
+  }
   return state.count;
 }
`;

test("reverse ablation removes the exact candidate fix without a shell or Git checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "mergeproof-ablation-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "jobs.mjs"), `export function generate(state) {
  if (state.count === 0) {
    state.count += 1;
  }
  return state.count;
}
`);
    assert.deepEqual(applyReverseUnifiedDiff(root, diff), ["src/jobs.mjs"]);
    assert.equal(readFileSync(join(root, "src", "jobs.mjs"), "utf8"), `export function generate(state) {
  state.count += 1;
  return state.count;
}
`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ablation fails closed for traversal, binary, rename, addition, and mismatched source", () => {
  for (const unsafe of [
    diff.replaceAll("src/jobs.mjs", "../outside.mjs"),
    `${diff}\nBinary files a/src/jobs.mjs and b/src/jobs.mjs differ`,
    diff.replace("--- a/src/jobs.mjs", "rename from src/jobs.mjs"),
    diff.replace("--- a/src/jobs.mjs", "--- /dev/null"),
  ]) {
    assert.throws(() => parseReverseAblationDiff(unsafe));
  }
  const root = mkdtempSync(join(tmpdir(), "mergeproof-ablation-"));
  try {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "jobs.mjs"), "export const unrelated = true;\n");
    assert.throws(() => applyReverseUnifiedDiff(root, diff), /does not match candidate source/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
