import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const allowedMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]);
const allowedKinds = new Set(["primary", "positive_control", "negative_control"]);
const maxInputBytes = 1024 * 1024;
const maxResponseBytes = 64 * 1024;
const missing = Symbol("missing");

function fail(message) {
  throw new Error(message);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object.`);
  return value;
}

function boundedString(value, label, max = 1_000, allowEmpty = false) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > max || /[\r\n\0]/.test(value)) {
    fail(`${label} must be a bounded string.`);
  }
  return value;
}

function boundedArray(value, label, max) {
  if (!Array.isArray(value) || value.length > max) fail(`${label} must be a bounded array.`);
  return value;
}

function readJson(path, label) {
  if (!isAbsolute(path) || statSync(path).size > maxInputBytes) fail(`${label} is missing or too large.`);
  return JSON.parse(readFileSync(path, "utf8"));
}

function safeRelativeDirectory(sourceDir, value) {
  boundedString(value, "application.cwd", 240);
  if (isAbsolute(value) || value.split(/[\\/]/).includes("..")) fail("application.cwd escapes source.");
  const target = resolve(sourceDir, value);
  const fromSource = relative(resolve(sourceDir), target);
  if (fromSource.startsWith("..") || isAbsolute(fromSource)) fail("application.cwd escapes source.");
  return target;
}

function safeEndpointPath(value, label) {
  boundedString(value, label, 500);
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("://") || value.split("/").includes("..")) {
    fail(`${label} must stay on loopback.`);
  }
  return value;
}

function endpointUrl(origin, path) {
  const url = new URL(safeEndpointPath(path, "endpoint.path"), origin);
  if (url.origin !== origin || url.username || url.password) fail("Replay endpoint escaped loopback origin.");
  return url;
}

function parseProfile(raw, sourceDir) {
  const profile = object(raw, "Replay profile");
  if (profile.schemaVersion !== 1) fail("Unsupported replay profile schema.");
  const application = object(profile.application, "application");
  if (
    !(
      (application.runtime === "node" && application.executable === "node") ||
      (application.runtime === "python" && application.executable === "python3")
    )
  ) fail("Replay profile must use a controller-owned runtime.");
  if (!Number.isSafeInteger(application.port) || application.port < 1_024 || application.port > 65_535) {
    fail("application.port is invalid.");
  }
  const args = boundedArray(application.args, "application.args", 20).map((entry, index) =>
    boundedString(entry, `application.args[${index}]`, 500));
  const env = object(application.env ?? {}, "application.env");
  const parsedEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || /(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|API_KEY)/.test(name)) {
      fail("application.env contains a forbidden name.");
    }
    parsedEnv[name] = boundedString(value, `application.env.${name}`, 1_000, true);
  }
  const health = parseEndpoint(application.health, "application.health", new Set(["GET", "HEAD"]));
  if (!Number.isSafeInteger(application.health.timeoutMs) || application.health.timeoutMs < 100 || application.health.timeoutMs > 60_000) {
    fail("application.health.timeoutMs is invalid.");
  }
  if (!Number.isSafeInteger(application.health.intervalMs) || application.health.intervalMs < 25 || application.health.intervalMs > 2_000) {
    fail("application.health.intervalMs is invalid.");
  }
  if (!Number.isSafeInteger(application.shutdownGraceMs) || application.shutdownGraceMs < 0 || application.shutdownGraceMs > 10_000) {
    fail("application.shutdownGraceMs is invalid.");
  }
  const fixtures = new Map();
  for (const [index, entry] of boundedArray(profile.fixtures, "fixtures", 50).entries()) {
    const fixture = object(entry, `fixtures[${index}]`);
    const id = boundedString(fixture.id, `fixtures[${index}].id`, 80);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || fixtures.has(id)) fail("Fixture identifiers are invalid or duplicated.");
    fixtures.set(id, {
      setupEndpoint: parseEndpoint(fixture.setupEndpoint, `fixtures[${index}].setupEndpoint`),
      stateEndpoint: parseEndpoint(fixture.stateEndpoint, `fixtures[${index}].stateEndpoint`),
    });
  }
  return {
    application: {
      runtime: application.runtime,
      cwd: safeRelativeDirectory(sourceDir, application.cwd),
      args,
      env: parsedEnv,
      port: application.port,
      health: { ...health, timeoutMs: application.health.timeoutMs, intervalMs: application.health.intervalMs },
      shutdownGraceMs: application.shutdownGraceMs,
    },
    fixtures,
  };
}

function parseEndpoint(raw, label, methods = allowedMethods) {
  const endpoint = object(raw, label);
  if (!methods.has(endpoint.method)) fail(`${label}.method is unsupported.`);
  if (!Number.isSafeInteger(endpoint.expectedStatus) || endpoint.expectedStatus < 100 || endpoint.expectedStatus > 599) {
    fail(`${label}.expectedStatus is invalid.`);
  }
  return {
    method: endpoint.method,
    path: safeEndpointPath(endpoint.path, `${label}.path`),
    expectedStatus: endpoint.expectedStatus,
  };
}

function parseExperiments(raw, selector, profile) {
  const plan = object(raw, "Proof plan");
  if (plan.schemaVersion !== 1 || plan.status === "blocked") fail("Proof plan is blocked or unsupported.");
  const experiments = boundedArray(plan.experiments, "experiments", 64)
    .map((entry, index) => parseExperiment(entry, `experiments[${index}]`, profile))
    .filter((entry) => selector.startsWith("experiment:")
      ? entry.id === selector.slice("experiment:".length)
      : entry.kind === selector);
  if (experiments.length === 0) fail(`Proof plan contains no experiment for ${selector}.`);
  return experiments;
}

function parseExperiment(raw, label, profile) {
  const experiment = object(raw, label);
  const id = boundedString(experiment.id, `${label}.id`, 160);
  const kind = boundedString(experiment.kind, `${label}.kind`, 40);
  if (!allowedKinds.has(kind)) fail(`${label}.kind is unsupported.`);
  const fixtures = boundedArray(experiment.fixtures, `${label}.fixtures`, 8).map((entry, index) => {
    const binding = object(entry, `${label}.fixtures[${index}]`);
    const name = boundedString(binding.name, `${label}.fixtures[${index}].name`, 80);
    const fixtureId = boundedString(binding.fixtureId, `${label}.fixtures[${index}].fixtureId`, 128);
    const trusted = profile.fixtures.get(fixtureId);
    if (!trusted) fail(`${label} references an unregistered fixture.`);
    const sameEndpoint = (left, right) => left.method === right.method && left.path === right.path && left.expectedStatus === right.expectedStatus;
    if (!sameEndpoint(binding.setupEndpoint, trusted.setupEndpoint) ||
        !sameEndpoint(binding.stateEndpoint, trusted.stateEndpoint)) {
      fail(`${label} tried to alter trusted fixture endpoints.`);
    }
    return { name, fixtureId, parameters: binding.parameters ?? {}, ...trusted };
  });
  if (new Set(fixtures.map(({ name }) => name)).size !== fixtures.length) fail(`${label} repeats a fixture alias.`);
  const requests = boundedArray(experiment.requests, `${label}.requests`, 8).map((entry, index) => {
    const request = object(entry, `${label}.requests[${index}]`);
    if (!allowedMethods.has(request.method) || request.method === "HEAD") fail(`${label} request method is unsupported.`);
    return {
      id: boundedString(request.id, `${label}.requests[${index}].id`, 80),
      method: request.method,
      path: safeEndpointPath(request.path, `${label}.requests[${index}].path`),
      query: boundedArray(request.query ?? [], `${label}.requests[${index}].query`, 16).map((value) => object(value, "query")),
      ...(request.body === undefined ? {} : { body: request.body }),
    };
  });
  const assertions = boundedArray(experiment.assertions, `${label}.assertions`, 24).map((entry) => object(entry, "assertion"));
  return { id, kind, fixtures, requests, assertions };
}

function placeholderValues(fixtures) {
  const values = new Map();
  const ambiguous = new Set();
  for (const fixture of fixtures) {
    for (const [key, value] of Object.entries(object(fixture.parameters, "fixture.parameters"))) {
      if (!["string", "number", "boolean"].includes(typeof value)) continue;
      if (values.has(key) && values.get(key) !== value) ambiguous.add(key);
      values.set(key, value);
    }
  }
  for (const key of ambiguous) values.delete(key);
  return values;
}

function substituteString(value, values) {
  return String(value).replace(/\{([a-z][a-z0-9_-]*)\}/g, (_match, key) => {
    if (!values.has(key)) fail(`Replay placeholder ${key} has no unique fixture value.`);
    return encodeURIComponent(String(values.get(key)));
  });
}

function substituteJson(value, values, depth = 0) {
  if (depth > 5) fail("Replay JSON is too deeply nested.");
  if (typeof value === "string") {
    const exact = /^\{([a-z][a-z0-9_-]*)\}$/.exec(value);
    if (exact && values.has(exact[1])) return values.get(exact[1]);
    return substituteString(value, values);
  }
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (Array.isArray(value)) return value.map((entry) => substituteJson(entry, values, depth + 1));
  const record = object(value, "request.body");
  return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, substituteJson(entry, values, depth + 1)]));
}

async function boundedFetch(url, options = {}, timeoutMs = 10_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, redirect: "error", signal: controller.signal });
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > maxResponseBytes) {
      await response.body?.cancel();
      fail("Replay response exceeded the evidence limit.");
    }
    const chunks = [];
    let totalBytes = 0;
    if (response.body) {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
          if (totalBytes > maxResponseBytes) {
            await reader.cancel();
            fail("Replay response exceeded the evidence limit.");
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(bytes);
    let json = missing;
    if (text.length > 0) {
      try { json = JSON.parse(text); } catch { json = missing; }
    }
    const headers = {};
    let count = 0;
    for (const [name, value] of response.headers) {
      if (count >= 50) break;
      headers[name.toLowerCase()] = value.slice(0, 1_000);
      count += 1;
    }
    return { status: response.status, json, headers };
  } finally {
    clearTimeout(timer);
  }
}

function requestOptions(method, body) {
  return {
    method,
    ...(body === undefined ? {} : {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  };
}

async function waitForHealth(origin, application, processState) {
  const deadline = Date.now() + application.health.timeoutMs;
  while (Date.now() < deadline) {
    if (processState.exited) fail("Application exited before becoming healthy.");
    try {
      const response = await boundedFetch(
        endpointUrl(origin, application.health.path),
        { method: application.health.method },
        Math.min(2_000, application.health.timeoutMs),
      );
      if (response.status === application.health.expectedStatus) return;
    } catch {
      // A bounded retry loop turns startup races into a deterministic health gate.
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, application.health.intervalMs));
  }
  fail("Application did not become healthy before the trusted timeout.");
}

function pointer(value, rawPointer) {
  if (rawPointer === "") return value;
  if (typeof rawPointer !== "string" || !rawPointer.startsWith("/")) return missing;
  let current = value;
  for (const token of rawPointer.slice(1).split("/").map((entry) => entry.replaceAll("~1", "/").replaceAll("~0", "~"))) {
    if (current === null || typeof current !== "object" || !(token in current)) return missing;
    current = current[token];
  }
  return current;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function predicate(actual, rule) {
  const value = object(rule, "assertion.predicate");
  if (value.operator === "exists") return actual !== missing;
  if (value.operator === "absent") return actual === missing;
  if (actual === missing) return false;
  if (value.operator === "equals") return canonical(actual) === canonical(value.expected);
  if (value.operator === "not_equals") return canonical(actual) !== canonical(value.expected);
  if (value.operator === "contains") {
    if (typeof actual === "string" && typeof value.expected === "string") return actual.includes(value.expected);
    if (Array.isArray(actual)) return actual.some((entry) => canonical(entry) === canonical(value.expected));
    if (actual && typeof actual === "object" && value.expected && typeof value.expected === "object" && !Array.isArray(value.expected)) {
      return Object.entries(value.expected).every(([key, entry]) => key in actual && canonical(actual[key]) === canonical(entry));
    }
  }
  return false;
}

async function executeExperiment(experiment, origin) {
  const values = placeholderValues(experiment.fixtures);
  for (const fixture of experiment.fixtures) {
    const response = await boundedFetch(
      endpointUrl(origin, fixture.setupEndpoint.path),
      requestOptions(fixture.setupEndpoint.method, { name: fixture.name, parameters: fixture.parameters }),
    );
    if (response.status !== fixture.setupEndpoint.expectedStatus) {
      return { pass: false, failures: [`fixture:${fixture.name}:setup-status-${response.status}`], assertions: 0 };
    }
  }

  const responses = new Map();
  for (const request of experiment.requests) {
    const url = endpointUrl(origin, substituteString(request.path, values));
    for (const entry of request.query) {
      const name = boundedString(entry.name, "query.name", 80);
      const value = substituteString(boundedString(entry.value, "query.value", 1_000, true), values);
      url.searchParams.append(name, value);
    }
    responses.set(request.id, await boundedFetch(
      url,
      requestOptions(request.method, request.body === undefined ? undefined : substituteJson(request.body, values)),
    ));
  }

  const states = new Map();
  const failures = [];
  for (const assertion of experiment.assertions) {
    const id = boundedString(assertion.id, "assertion.id", 80);
    let ok = false;
    if (assertion.kind === "response_status") {
      ok = responses.get(assertion.requestId)?.status === assertion.expectedStatus;
    } else if (assertion.kind === "response_json") {
      ok = predicate(pointer(responses.get(assertion.requestId)?.json ?? missing, assertion.path), assertion.predicate);
    } else if (assertion.kind === "response_header") {
      const actual = responses.get(assertion.requestId)?.headers?.[String(assertion.name).toLowerCase()] ?? missing;
      ok = predicate(actual, assertion.predicate);
    } else if (assertion.kind === "state") {
      const fixture = experiment.fixtures.find(({ name }) => name === assertion.fixture);
      if (!fixture) fail(`Assertion ${id} references an unknown fixture alias.`);
      if (!states.has(fixture.name)) {
        const url = endpointUrl(origin, fixture.stateEndpoint.path);
        let body;
        if (fixture.stateEndpoint.method === "GET" || fixture.stateEndpoint.method === "HEAD") {
          url.searchParams.set("name", fixture.name);
        } else {
          body = { name: fixture.name };
        }
        const response = await boundedFetch(url, requestOptions(fixture.stateEndpoint.method, body));
        states.set(fixture.name, response.status === fixture.stateEndpoint.expectedStatus ? response.json : missing);
      }
      ok = predicate(pointer(states.get(fixture.name), assertion.path), assertion.predicate);
    } else {
      fail(`Assertion ${id} has an unsupported kind.`);
    }
    if (!ok) failures.push(id);
  }
  return { pass: failures.length === 0, failures, assertions: experiment.assertions.length };
}

async function stopApplication(child, graceMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signalGroup = (signal) => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      child.kill(signal);
    }
  };
  signalGroup("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolvePromise) => child.once("exit", () => resolvePromise(true))),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), graceMs)),
  ]);
  if (!exited) signalGroup("SIGKILL");
}

async function main() {
  const sourceDir = process.env.MERGEPROOF_SOURCE_DIR;
  const planPath = process.env.MERGEPROOF_PROOF_PLAN_PATH;
  const profilePath = process.env.MERGEPROOF_REPLAY_PROFILE_PATH;
  const selector = process.argv[2] ?? "primary";
  if (!sourceDir || !planPath || !profilePath) fail("Replay probe inputs are not mounted.");
  if (!allowedKinds.has(selector) && !selector.startsWith("experiment:")) fail("Replay selector is unsupported.");

  const profile = parseProfile(readJson(profilePath, "Replay profile"), sourceDir);
  const experiments = parseExperiments(readJson(planPath, "Proof plan"), selector, profile);
  const origin = `http://127.0.0.1:${profile.application.port}`;
  const processState = { exited: false, output: "" };
  const executable = profile.application.runtime === "node" ? process.execPath : "python3";
  const child = spawn(executable, profile.application.args, {
    cwd: profile.application.cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      LANG: process.env.LANG ?? "C.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "C.UTF-8",
      TZ: "UTC",
      PORT: String(profile.application.port),
      ...profile.application.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const capture = (chunk) => {
    if (processState.output.length < 4_000) processState.output += String(chunk).slice(0, 4_000 - processState.output.length);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  child.once("exit", () => { processState.exited = true; });

  try {
    await waitForHealth(origin, profile.application, processState);
    const results = [];
    for (const experiment of experiments) results.push({ id: experiment.id, kind: experiment.kind, ...(await executeExperiment(experiment, origin)) });
    const successful = results.every((result) => result.kind === "negative_control" ? !result.pass : result.pass);
    const summary = {
      selector,
      phase: process.env.MERGEPROOF_PHASE ?? "candidate",
      experiments: results.map((result) => ({
        id: result.id,
        observed: result.pass ? "pass" : "fail",
        assertions: result.assertions,
        failures: result.failures.slice(0, 12),
      })),
    };
    process.stdout.write(`MERGEPROOF_REPLAY=${JSON.stringify(summary)}`);
    if (!successful) process.exitCode = 1;
  } finally {
    await stopApplication(child, profile.application.shutdownGraceMs);
  }
}

main().catch((error) => {
  process.stderr.write(error instanceof Error ? error.message : "HTTP replay failed.");
  process.exitCode = 1;
});
