import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = process.env.MERGEPROOF_SOURCE_DIR;
const scenario = process.argv[2];
const probeDirectory = dirname(fileURLToPath(import.meta.url));
const assetDirectory = fileURLToPath(new URL("./assets/", import.meta.url));
const frozenTestsDirectory = join(assetDirectory, "tests");
const frozenSuiteRunner = join(assetDirectory, "run_frozen_suite.py");
const python = "python3";

const requiredSourceFiles = [
  "app.py",
  "pipeline.py",
  "core.py",
  "concepts.py",
  "promptbuilder.py",
  "scenes.py",
];
const frozenContractTests = [
  "test_scenes.py",
  "test_promptbuilder.py",
];
const personGuardTests = ["test_person_guard.py"];
const allFrozenTests = [...frozenContractTests, ...personGuardTests];

function sourceRoot() {
  if (!sourceDirectory) {
    throw new Error("MERGEPROOF_SOURCE_DIR is required.");
  }
  const root = resolve(sourceDirectory);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error("MERGEPROOF_SOURCE_DIR must resolve to an extracted source directory.");
  }
  return root;
}

function runPython(args) {
  const result = spawnSync(python, ["-I", ...args], {
    // Isolated Python still gets the candidate source only when the trusted
    // runner explicitly places it on sys.path. It never discovers candidate
    // tests through the current working directory or user site packages.
    cwd: probeDirectory,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME ?? "/tmp",
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      PYTHONDONTWRITEBYTECODE: "1",
    },
    encoding: "utf8",
    timeout: 55_000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error) {
    throw new Error(`Trusted Python runner failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
    throw new Error(`Trusted Python runner failed${output ? `: ${output}` : ""}`);
  }
  return String(result.stdout ?? "").trim();
}

function assertSourceContract() {
  const root = sourceRoot();
  const sourceFiles = requiredSourceFiles.map((relativePath) => {
    const path = join(root, relativePath);
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`Product AdKit source file is missing: ${relativePath}`);
    }
    return path;
  });
  runPython(["-m", "py_compile", ...sourceFiles]);
}

function installFrozenTests() {
  const root = sourceRoot();
  const destination = join(root, "tests");
  if (existsSync(destination) && !statSync(destination).isDirectory()) {
    throw new Error("Candidate tests path must be a directory.");
  }
  mkdirSync(destination, { recursive: true });
  for (const testFile of allFrozenTests) {
    const trustedTest = join(frozenTestsDirectory, testFile);
    if (!existsSync(trustedTest) || !statSync(trustedTest).isFile()) {
      throw new Error(`Trusted frozen test asset is missing: ${testFile}`);
    }
    copyFileSync(trustedTest, join(destination, testFile));
  }
  return destination;
}

function runFrozenTests(testFiles, metric) {
  const root = sourceRoot();
  const testsDirectory = installFrozenTests();
  const output = runPython([
    frozenSuiteRunner,
    "--source-dir",
    root,
    "--tests-dir",
    testsDirectory,
    ...(metric ? ["--metric", metric] : []),
    ...testFiles.map((testFile) => `--test=${testFile}`),
  ]);
  if (!metric) return;
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(output)) {
    throw new Error("Trusted frozen suite did not emit one non-negative numeric metric.");
  }
  process.stdout.write(`${output}\n`);
}

switch (scenario) {
  case "source-contract":
    assertSourceContract();
    break;
  case "frozen-product-contracts":
    runFrozenTests(frozenContractTests);
    break;
  case "model-off-person-guard":
    runFrozenTests(personGuardTests);
    break;
  case "p95-latency":
    runFrozenTests(allFrozenTests, "latency-ms");
    break;
  case "peak-memory":
    runFrozenTests(allFrozenTests, "peak-memory-mb");
    break;
  default:
    throw new Error(`Unknown Product AdKit probe scenario: ${scenario ?? "missing"}`);
}
