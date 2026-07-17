import assert from "node:assert/strict";
import test from "node:test";

import {
  ImpactMapperInputError,
  mapImpact,
  parseUnifiedDiff,
  type RepositoryFile,
} from "../src/impact-mapper.js";

function gitDiff(filePath: string, hunk: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    hunk,
  ].join("\n");
}

test("parseUnifiedDiff parses git and plain unified diffs with deterministic classifications", () => {
  const diff = [
    'diff --git "a/src/image worker.ts" "b/src/image worker.ts"',
    '--- "a/src/image worker.ts"',
    '+++ "b/src/image worker.ts"',
    "@@ -1,2 +1,4 @@ generate",
    " import { save } from './store.js';",
    "-export function generate() { return save(); }",
    "+export function generate() {",
    "+  if (ready) return save();",
    "+}",
    "diff --git a/old.ts b/new.ts",
    "similarity index 100%",
    "rename from old.ts",
    "rename to new.ts",
    "diff --git a/logo.png b/logo.png",
    "Binary files a/logo.png and b/logo.png differ",
  ].join("\n");

  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[0], {
    oldPath: "src/image worker.ts",
    newPath: "src/image worker.ts",
    change: "modified",
    classifications: ["source"],
    hunks: [{
      oldStart: 1,
      oldCount: 2,
      newStart: 1,
      newCount: 4,
      section: "generate",
      classifications: ["control_flow", "declaration", "export_surface", "import_surface"],
      changes: [
        { kind: "removed", line: 2, content: "export function generate() { return save(); }" },
        { kind: "added", line: 2, content: "export function generate() {" },
        { kind: "added", line: 3, content: "  if (ready) return save();" },
        { kind: "added", line: 4, content: "}" },
      ],
    }],
  });
  assert.equal(parsed[1]?.change, "renamed");
  assert.equal(parsed[1]?.oldPath, "old.ts");
  assert.equal(parsed[1]?.newPath, "new.ts");
  assert.equal(parsed[2]?.change, "binary");
  assert.deepEqual(parsed[2]?.classifications, ["asset"]);

  const plain = parseUnifiedDiff([
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1 +1 @@",
    "-export const a = 1;",
    "+export const a = 2;",
  ].join("\n"));
  assert.equal(plain.length, 1);
  assert.equal(plain[0]?.newPath, "src/a.ts");
});

test("mapImpact maps an exported change through direct callers to likely workflows", () => {
  const repositoryFiles: RepositoryFile[] = [
    {
      path: "src/generate.ts",
      content: [
        "export function generate(job: string): string {",
        "  return `one:${job}`;",
        "}",
      ].join("\n"),
    },
    {
      path: "src/jobs/retry-job.ts",
      content: [
        'import { generate } from "../generate.js";',
        "export function processJob(): string {",
        '  return generate("job-1");',
        "}",
      ].join("\n"),
    },
    {
      path: "src/server.ts",
      content: [
        'import { processJob } from "./jobs/retry-job.js";',
        "export function start(): string {",
        "  return processJob();",
        "}",
      ].join("\n"),
    },
  ];
  const diff = gitDiff("src/generate.ts", [
    "@@ -1,3 +1,3 @@",
    " export function generate(job: string): string {",
    "-  return job;",
    "+  return `one:${job}`;",
    " }",
  ].join("\n"));

  const report = mapImpact({ diff, repositoryFiles });
  assert.equal(report.status, "complete");
  assert.equal(report.changedSymbols.length, 1);
  assert.deepEqual(report.changedSymbols[0], {
    id: "src/generate.ts#generate@1",
    path: "src/generate.ts",
    name: "generate",
    line: 1,
    kind: "function",
    exported: true,
    defaultExport: false,
    startLine: 1,
    endLine: 3,
    changedLines: [2],
    changeKinds: ["control_flow"],
    importers: ["src/jobs/retry-job.ts"],
    callers: [{
      id: "src/jobs/retry-job.ts#processJob@2",
      path: "src/jobs/retry-job.ts",
      name: "processJob",
      line: 3,
    }],
  });
  assert.ok(report.affectedFiles.some((file) => file.path === "src/server.ts" && file.reasons.some((reason) => reason.startsWith("calls_changed_behavior"))));
  assert.ok(report.workflows.some((workflow) => workflow.path === "src/jobs/retry-job.ts" && workflow.kind === "job"));
  assert.ok(report.workflows.some((workflow) => workflow.path === "src/server.ts" && workflow.kind === "server" && workflow.distance === 2));
  assert.deepEqual(report.unresolvedPaths, []);
  assert.deepEqual(report.stats, {
    repositoryFiles: 3,
    repositoryBytes: repositoryFiles.reduce((total, file) => total + Buffer.byteLength(file.content), 0),
    diffFiles: 1,
    hunks: 1,
    changedLines: 2,
    parsedSourceFiles: 3,
    analyzedSymbols: 3,
  });
});

test("mapImpact resolves changed local functions, class methods, and imported instances", () => {
  const repositoryFiles: RepositoryFile[] = [
    {
      path: "src/generator.ts",
      content: [
        "export class Generator {",
        "  run(job: string): string {",
        "    return job.toUpperCase();",
        "  }",
        "}",
        "function normalize(job: string): string {",
        "  return job.trim();",
        "}",
        "export function prepare(job: string): string {",
        "  return normalize(job);",
        "}",
      ].join("\n"),
    },
    {
      path: "src/workers/generate-worker.ts",
      content: [
        'import { Generator } from "../generator.js";',
        "const generator = new Generator();",
        "export function handle(): string {",
        '  return generator.run("job");',
        "}",
      ].join("\n"),
    },
  ];
  const methodReport = mapImpact({
    repositoryFiles,
    diff: gitDiff("src/generator.ts", [
      "@@ -1,5 +1,5 @@",
      " export class Generator {",
      "   run(job: string): string {",
      "-    return job;",
      "+    return job.toUpperCase();",
      "   }",
      " }",
    ].join("\n")),
  });
  const changedMethod = methodReport.changedSymbols.find((symbol) => symbol.name === "Generator.run");
  assert.ok(changedMethod);
  assert.equal(changedMethod.exported, true);
  assert.deepEqual(changedMethod.callers.map((caller) => caller.name), ["handle"]);
  assert.deepEqual(changedMethod.importers, ["src/workers/generate-worker.ts"]);
  assert.ok(methodReport.workflows.some((workflow) => workflow.kind === "worker"));

  const localReport = mapImpact({
    repositoryFiles,
    diff: gitDiff("src/generator.ts", [
      "@@ -6,3 +6,3 @@ function normalize",
      " function normalize(job: string): string {",
      "-  return job;",
      "+  return job.trim();",
      " }",
    ].join("\n")),
  });
  const local = localReport.changedSymbols.find((symbol) => symbol.name === "normalize");
  assert.ok(local);
  assert.equal(local.exported, false);
  assert.deepEqual(local.callers.map((caller) => caller.name), ["prepare"]);
});

test("mapImpact conservatively traces Python functions through imports to worker and server workflows", () => {
  const repositoryFiles: RepositoryFile[] = [
    {
      path: "jobs/generate.py",
      content: "def generate(job: str) -> str:\n    return f'one:{job}'\n",
    },
    {
      path: "workers/retry_worker.py",
      content: "from jobs.generate import generate\ndef process_job() -> str:\n    return generate('job-1')\n",
    },
    {
      path: "server.py",
      content: "from workers.retry_worker import process_job\ndef main() -> str:\n    return process_job()\n",
    },
  ];
  const report = mapImpact({
    repositoryFiles,
    diff: gitDiff("jobs/generate.py", [
      "@@ -1,2 +1,2 @@ generate",
      " def generate(job: str) -> str:",
      "-    return job",
      "+    return f'one:{job}'",
    ].join("\n")),
  });

  assert.equal(report.status, "complete");
  assert.equal(report.stats.parsedSourceFiles, 3);
  const changed = report.changedSymbols.find((symbol) => symbol.name === "generate");
  assert.ok(changed);
  assert.deepEqual(changed.importers, ["workers/retry_worker.py"]);
  assert.deepEqual(changed.callers.map((caller) => caller.name), ["process_job"]);
  assert.ok(report.workflows.some((workflow) => workflow.path === "workers/retry_worker.py" && workflow.kind === "worker"));
  assert.ok(report.workflows.some((workflow) => workflow.path === "server.py" && workflow.kind === "server" && workflow.distance === 2));
});

test("Python dynamic behavior, unresolved relative imports, missing files, and unsupported executable languages fail closed", () => {
  const dynamic = mapImpact({
    repositoryFiles: [{
      path: "jobs/dynamic.py",
      content: [
        "import importlib",
        "def run(name, target):",
        "    __import__(name)",
        "    importlib.import_module(name)",
        "    getattr(target, name)()",
        "    eval(name)",
        "    exec(name)",
      ].join("\n"),
    }],
    diff: gitDiff("jobs/dynamic.py", "@@ -2,2 +2,2 @@ run\n def run(name, target):\n-    return None\n+    __import__(name)"),
  });
  assert.equal(dynamic.status, "blocked");
  assert.deepEqual(
    [...new Set(dynamic.unresolvedPaths.map((item) => item.kind))].sort(),
    ["dynamic_import", "eval", "reflection"],
  );

  const unresolvedImport = mapImpact({
    repositoryFiles: [{ path: "jobs/main.py", content: "from .missing import run\ndef main():\n    return run()\n" }],
    diff: gitDiff("jobs/main.py", "@@ -2,2 +2,2 @@ main\n def main():\n-    return None\n+    return run()"),
  });
  assert.ok(unresolvedImport.unresolvedPaths.some((item) => item.kind === "unresolved_relative_import"));

  const missing = mapImpact({
    repositoryFiles: [],
    diff: gitDiff("jobs/missing.py", "@@ -0,0 +1 @@\n+def run(): pass"),
  });
  assert.equal(missing.unresolvedPaths[0]?.kind, "missing_changed_file");

  const unsupported = mapImpact({
    repositoryFiles: [{ path: "worker.go", content: "package main\nfunc main() {}\n" }],
    diff: gitDiff("worker.go", "@@ -1,2 +1,2 @@\n package main\n-func main() {}\n+func main() { run() }"),
  });
  assert.ok(unsupported.unresolvedPaths.some((item) => item.kind === "unsupported_source_language"));
});

test("deletion-only hunks map to their candidate anchor and module changes retain importers", () => {
  const repositoryFiles: RepositoryFile[] = [
    { path: "src/value.ts", content: "export function value(): number {\n  return 1;\n}\n" },
    { path: "src/use.ts", content: 'import { value } from "./value.js";\nexport const result = value();\n' },
  ];
  const deletion = mapImpact({
    repositoryFiles,
    diff: gitDiff("src/value.ts", [
      "@@ -1,4 +1,3 @@ function value",
      " export function value(): number {",
      "-  // stale comment",
      "   return 1;",
      " }",
    ].join("\n")),
  });
  assert.equal(deletion.changedSymbols[0]?.name, "value");
  assert.deepEqual(deletion.changedSymbols[0]?.changedLines, [1]);

  const moduleChange = mapImpact({
    repositoryFiles: [
      { path: "src/value.ts", content: "export const version = 1;\nexport function value(): number {\n  return 1;\n}\n" },
      { path: "src/use.ts", content: 'import { value } from "./value.js";\nexport const result = value();\n' },
    ],
    diff: gitDiff("src/value.ts", [
      "@@ -1,3 +1,4 @@",
      "+export const version = 1;",
      " export function value(): number {",
      "   return 1;",
      " }",
    ].join("\n")),
  });
  const moduleSymbol = moduleChange.changedSymbols.find((symbol) => symbol.kind === "module");
  assert.ok(moduleSymbol);
  assert.deepEqual(moduleSymbol.importers, ["src/use.ts"]);
});

test("dynamic imports, requires, computed dispatch, eval, and reflection fail closed", () => {
  const content = [
    "export function changed(name: string, target: Record<string, () => void>): void {",
    "  import(name);",
    "  require(name);",
    "  target[name]();",
    '  eval("target.run()");',
    "  Reflect.apply(target.run, target, []);",
    "  target.run.call(target);",
    "  new Function('return 1')();",
    "}",
  ].join("\n");
  const report = mapImpact({
    repositoryFiles: [{ path: "src/dynamic.ts", content }],
    diff: gitDiff("src/dynamic.ts", [
      "@@ -1,2 +1,2 @@",
      " export function changed(name: string, target: Record<string, () => void>): void {",
      "-  // old",
      "+  import(name);",
    ].join("\n")),
  });

  assert.equal(report.status, "blocked");
  assert.deepEqual(
    [...new Set(report.unresolvedPaths.map((item) => item.kind))].sort(),
    ["computed_dispatch", "dynamic_import", "dynamic_require", "eval", "reflection"],
  );
  assert.ok(report.unresolvedPaths.every((item) => item.reason.length > 0 && item.path === "src/dynamic.ts"));
});

test("missing, deleted, binary, malformed, and unresolved source paths fail closed", () => {
  const missing = mapImpact({
    repositoryFiles: [],
    diff: gitDiff("src/missing.ts", "@@ -0,0 +1 @@\n+export const value = 1;"),
  });
  assert.equal(missing.status, "blocked");
  assert.equal(missing.unresolvedPaths[0]?.kind, "missing_changed_file");

  const deleted = mapImpact({
    repositoryFiles: [],
    diff: [
      "diff --git a/src/deleted.ts b/src/deleted.ts",
      "deleted file mode 100644",
      "--- a/src/deleted.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-export const value = 1;",
    ].join("\n"),
  });
  assert.equal(deleted.unresolvedPaths[0]?.kind, "deleted_source");

  const binary = mapImpact({
    repositoryFiles: [],
    diff: "diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ",
  });
  assert.equal(binary.unresolvedPaths[0]?.kind, "binary_change");

  const parseError = mapImpact({
    repositoryFiles: [{ path: "src/broken.ts", content: "export function broken( {" }],
    diff: gitDiff("src/broken.ts", "@@ -1 +1 @@\n-export const x = 1;\n+export function broken( {"),
  });
  assert.ok(parseError.unresolvedPaths.some((item) => item.kind === "parse_error"));

  const unresolvedImport = mapImpact({
    repositoryFiles: [{ path: "src/main.ts", content: 'import { absent } from "./absent.js";\nexport function main() { absent(); }' }],
    diff: gitDiff("src/main.ts", "@@ -2 +2 @@\n-export function main() {}\n+export function main() { absent(); }"),
  });
  assert.ok(unresolvedImport.unresolvedPaths.some((item) => item.kind === "unresolved_relative_import"));
});

test("output ordering is stable and controller input limits reject incomplete analysis", () => {
  const files: RepositoryFile[] = [
    { path: "src/z.ts", content: "export function z() { return 1; }" },
    { path: "src/a.ts", content: 'import { z } from "./z.js";\nexport function a() { return z(); }' },
  ];
  const diff = gitDiff("src/z.ts", "@@ -1 +1 @@\n-export function z() { return 0; }\n+export function z() { return 1; }");
  assert.deepEqual(
    mapImpact({ diff, repositoryFiles: files }),
    mapImpact({ diff, repositoryFiles: [...files].reverse() }),
  );

  assert.throws(
    () => mapImpact({ diff, repositoryFiles: files, limits: { maxFiles: 1 } }),
    ImpactMapperInputError,
  );
  assert.throws(
    () => parseUnifiedDiff(diff, { maxDiffBytes: 10 }),
    /Unified diff exceeds 10 bytes/,
  );
  assert.throws(
    () => mapImpact({ diff, repositoryFiles: [{ path: "../escape.ts", content: "" }] }),
    /escapes the repository/,
  );
  assert.throws(
    () => mapImpact({ diff, repositoryFiles: [files[0] as RepositoryFile, files[0] as RepositoryFile] }),
    /Duplicate repository file/,
  );
});
