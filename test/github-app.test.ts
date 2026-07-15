import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createGitHubAppJwt,
  GitHubAppInstallationTokenProvider,
} from "../src/github-app.js";
import { parseGitHubWebhook, parsePullRequestWebhook } from "../src/github-webhook-event.js";

test("GitHub App JWT is RS256 signed with a clock-skewed short lifetime", () => {
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const now = new Date("2026-07-14T18:00:00.000Z");
  const jwt = createGitHubAppJwt({
    appId: "12345",
    privateKeyPem: keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    now,
  });
  const [header, payload, signature] = jwt.split(".");
  assert.ok(header && payload && signature);
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      keys.publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
  );
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
    iat: number;
    exp: number;
    iss: string;
  };
  const seconds = Math.floor(now.getTime() / 1_000);
  assert.deepEqual(decoded, { iat: seconds - 60, exp: seconds + 9 * 60, iss: "12345" });
});

test("merge-group webhook parser keeps only signed queue revision coordinates", () => {
  const parsed = parseGitHubWebhook("delivery-group", "merge_group", {
    action: "checks_requested",
    installation: { id: 99 },
    repository: { id: 101, full_name: "acme/checkout-service" },
    merge_group: { base_sha: "abcdef1", head_sha: "1234567", untrusted: "ignored" },
  });
  assert.deepEqual(parsed, {
    kind: "merge_group",
    trigger: {
      deliveryId: "delivery-group",
      installationId: 99,
      repository: "acme/checkout-service",
      repositoryId: 101,
      baseSha: "abcdef1",
      headSha: "1234567",
    },
  });
});

test("installation tokens are down-scoped to one repository and requested permissions", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const provider = new GitHubAppInstallationTokenProvider(
    "12345",
    keys.privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ token: "installation-token", expires_at: "2026-07-14T19:00:00Z" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    },
  );
  const minted = await provider.mint({
    installationId: 99,
    repository: "acme/checkout-service",
    permissions: { contents: "read", pull_requests: "read" },
  });

  assert.deepEqual(minted, { token: "installation-token", expiresAt: "2026-07-14T19:00:00Z" });
  assert.equal(calls[0]?.url, "https://api.github.com/app/installations/99/access_tokens");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    repositories: ["checkout-service"],
    permissions: { contents: "read", pull_requests: "read" },
  });
});

test("pull-request webhook parser uses payload only as a trigger", () => {
  const parsed = parsePullRequestWebhook("delivery-1", "pull_request", {
    action: "synchronize",
    number: 42,
    installation: { id: 99 },
    repository: { id: 101, full_name: "acme/checkout-service" },
    pull_request: { head: { sha: "untrusted-payload-sha" } },
  });
  assert.deepEqual(parsed, {
    kind: "trigger",
    trigger: {
      deliveryId: "delivery-1",
      action: "synchronize",
      installationId: 99,
      repository: "acme/checkout-service",
      repositoryId: 101,
      pullRequest: 42,
    },
  });
  assert.deepEqual(
    parsePullRequestWebhook("delivery-2", "push", {}),
    { kind: "ignored", reason: "Unsupported webhook event." },
  );
});

test("pull-request edited deliveries re-evaluate the live PR instead of trusting the body", () => {
  const parsed = parsePullRequestWebhook("delivery-edited", "pull_request", {
    action: "edited",
    number: 42,
    installation: { id: 99 },
    repository: { id: 101, full_name: "acme/checkout-service" },
    pull_request: { body: "untrusted edited text" },
  });

  assert.deepEqual(parsed, {
    kind: "trigger",
    trigger: {
      deliveryId: "delivery-edited",
      action: "edited",
      installationId: 99,
      repository: "acme/checkout-service",
      repositoryId: 101,
      pullRequest: 42,
    },
  });
});

test("draft and closed PR deliveries re-evaluate live state so queued entries can be revoked", () => {
  for (const action of ["converted_to_draft", "closed"] as const) {
    const parsed = parsePullRequestWebhook(`delivery-${action}`, "pull_request", {
      action,
      number: 42,
      installation: { id: 99 },
      repository: { id: 101, full_name: "acme/checkout-service" },
      pull_request: { state: "untrusted" },
    });
    assert.deepEqual(parsed, {
      kind: "trigger",
      trigger: {
        deliveryId: `delivery-${action}`,
        action,
        installationId: 99,
        repository: "acme/checkout-service",
        repositoryId: 101,
        pullRequest: 42,
      },
    });
  }
});

test("linked-issue edits carry only signed coordinates to the queue resolver", () => {
  const parsed = parseGitHubWebhook("issue-edited", "issues", {
    action: "edited",
    installation: { id: 99 },
    repository: { id: 101, full_name: "acme/checkout-service" },
    issue: { number: 42, title: "untrusted title", body: "untrusted body" },
  });

  assert.deepEqual(parsed, {
    kind: "linked_issue",
    trigger: {
      deliveryId: "issue-edited",
      installationId: 99,
      repository: "acme/checkout-service",
      repositoryId: 101,
      issueNumber: 42,
    },
  });
});

test("pull-request review webhook requeues the live PR after approval changes", () => {
  const parsed = parseGitHubWebhook("review-1", "pull_request_review", {
    action: "submitted",
    number: 42,
    installation: { id: 9 },
    repository: { id: 10, full_name: "acme/checkout-service" },
    pull_request: { number: 42 },
  });

  assert.deepEqual(parsed, {
    kind: "pull_request",
    trigger: {
      deliveryId: "review-1",
      action: "review_submitted",
      installationId: 9,
      repository: "acme/checkout-service",
      repositoryId: 10,
      pullRequest: 42,
    },
  });
});

test("completed PR-associated checks requeue every linked PR once", () => {
  const parsed = parseGitHubWebhook("check-1", "check_run", {
    action: "completed",
    installation: { id: 9 },
    repository: { id: 10, full_name: "acme/checkout-service" },
    check_run: {
      status: "completed",
      name: "ci / test",
      app: { id: 77 },
      pull_requests: [{ number: 42 }, { number: 7 }, { number: 42 }, { number: 0 }],
    },
  }, {
    checkRunPolicy: {
      requiredChecks: ["ci / test"],
      requiredCheckAppIds: { "ci / test": 77 },
      ownAppId: 99,
      ownCheckName: "MergeProof / evidence",
    },
  });

  assert.deepEqual(parsed, {
    kind: "pull_requests",
    triggers: [
      {
        deliveryId: "check-1",
        action: "check_completed",
        installationId: 9,
        repository: "acme/checkout-service",
        repositoryId: 10,
        pullRequest: 42,
      },
      {
        deliveryId: "check-1",
        action: "check_completed",
        installationId: 9,
        repository: "acme/checkout-service",
        repositoryId: 10,
        pullRequest: 7,
      },
    ],
  });
});

test("check-run filtering ignores MergeProof's own, unrelated, and wrong-source checks", () => {
  const base = {
    action: "completed",
    installation: { id: 9 },
    repository: { id: 10, full_name: "acme/checkout-service" },
    check_run: {
      status: "completed",
      pull_requests: [{ number: 42 }],
    },
  };
  const options = {
    checkRunPolicy: {
      requiredChecks: ["ci / test"],
      requiredCheckAppIds: { "ci / test": 77 },
      ownAppId: 99,
      ownCheckName: "MergeProof / evidence",
    },
  };

  assert.deepEqual(
    parseGitHubWebhook("self", "check_run", {
      ...base,
      check_run: { ...base.check_run, name: "MergeProof / evidence", app: { id: 99 } },
    }, options),
    { kind: "ignored", reason: "MergeProof's own Check Run does not trigger verification." },
  );
  assert.deepEqual(
    parseGitHubWebhook("unrelated", "check_run", {
      ...base,
      check_run: { ...base.check_run, name: "lint", app: { id: 77 } },
    }, options),
    { kind: "ignored", reason: "Completed Check Run is not a configured merge requirement." },
  );
  assert.deepEqual(
    parseGitHubWebhook("wrong-source", "check_run", {
      ...base,
      check_run: { ...base.check_run, name: "ci / test", app: { id: 999 } },
    }, options),
    { kind: "ignored", reason: "Completed Check Run source does not match the configured GitHub App." },
  );
});

test("incomplete, unassociated, or malformed check runs are ignored", () => {
  const base = {
    installation: { id: 9 },
    repository: { id: 10, full_name: "acme/checkout-service" },
  };
  const ignored = { kind: "ignored", reason: "Webhook lacks a completed PR-associated check run." };

  assert.deepEqual(
    parseGitHubWebhook("check-queued", "check_run", {
      ...base,
      action: "created",
      check_run: { status: "queued", pull_requests: [{ number: 42 }] },
    }),
    ignored,
  );
  assert.deepEqual(
    parseGitHubWebhook("check-running", "check_run", {
      ...base,
      action: "completed",
      check_run: { status: "in_progress", pull_requests: [{ number: 42 }] },
    }),
    ignored,
  );
  assert.deepEqual(
    parseGitHubWebhook("check-no-pr", "check_run", {
      ...base,
      action: "completed",
      check_run: { status: "completed", pull_requests: [] },
    }),
    ignored,
  );
});

test("GitHub App manifest subscribes to completed check runs", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../config/github-app.manifest.template.json", import.meta.url), "utf8"),
  ) as { default_events?: unknown };
  assert.ok(Array.isArray(manifest.default_events));
  assert.ok(manifest.default_events.includes("check_run"));
  assert.ok(manifest.default_events.includes("issues"));
});
