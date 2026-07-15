import assert from "node:assert/strict";
import test from "node:test";

import { GitHubRestGateway } from "../src/github-gateway.js";

test("GitHub gateway reads later check-run pages before evaluating required checks", async () => {
  const urls: string[] = [];
  const firstPage = Array.from({ length: 100 }, (_, index) => ({
    name: `unrelated-${index}`,
    status: "completed",
    conclusion: "success",
  }));
  const gateway = new GitHubRestGateway("read-token", async (url) => {
    const value = String(url);
    urls.push(value);
    if (value.endsWith("/repos/acme/checkout/pulls/42")) {
      return Response.json({
        node_id: "PR_42",
        state: "open",
        draft: false,
        base: { sha: "base" },
        head: { sha: "head" },
        merge_commit_sha: "merge",
        title: "Fixture",
        body: "Fixture body",
        labels: [{ name: "mergeproof:auto" }],
      });
    }
    if (value.includes("/check-runs?per_page=100&page=1")) {
      return Response.json({ check_runs: firstPage });
    }
    if (value.includes("/check-runs?per_page=100&page=2")) {
      return Response.json({
        check_runs: [{
          name: "ci / required",
          status: "completed",
          conclusion: "success",
          app: { id: 42, slug: "trusted-ci" },
        }],
      });
    }
    if (value.includes("/reviews?per_page=100&page=1")) {
      return Response.json([{
        id: 1,
        state: "APPROVED",
        submitted_at: "2026-07-14T18:00:00Z",
        commit_id: "head",
        user: { id: 7 },
      }]);
    }
    if (value.endsWith("/repos/acme/checkout/pulls/42")) {
      return new Response("diff --git a/a b/a", { status: 200 });
    }
    throw new Error(`Unexpected GitHub request: ${value}`);
  });

  const pullRequest = await gateway.getPullRequest("acme/checkout", 42);

  assert.equal(pullRequest.approvals, 1);
  assert.deepEqual(
    pullRequest.checks.find((check) => check.name === "ci / required"),
    { name: "ci / required", status: "pass", appId: 42, appSlug: "trusted-ci" },
  );
  assert.ok(urls.some((url) => url.includes("/check-runs?per_page=100&page=2")));
});

test("GitHub gateway does not count an approval from an older head SHA", async () => {
  const gateway = new GitHubRestGateway("read-token", async (url) => {
    const value = String(url);
    if (value.endsWith("/repos/acme/checkout/pulls/42")) {
      return Response.json({
        node_id: "PR_42",
        state: "open",
        draft: false,
        base: { sha: "base" },
        head: { sha: "new-head" },
        merge_commit_sha: "merge",
        title: "Fixture",
        body: "Fixture body",
        labels: [],
      });
    }
    if (value.includes("/check-runs?per_page=100&page=1")) {
      return Response.json({ check_runs: [] });
    }
    if (value.includes("/reviews?per_page=100&page=1")) {
      return Response.json([{
        id: 1,
        state: "APPROVED",
        submitted_at: "2026-07-14T18:00:00Z",
        commit_id: "old-head",
        user: { id: 7 },
      }]);
    }
    throw new Error(`Unexpected GitHub request: ${value}`);
  });

  const pullRequest = await gateway.getPullRequest("acme/checkout", 42);
  assert.equal(pullRequest.approvals, 0);
});

test("GitHub gateway retrieves canonical issue data and identifies pull-request-shaped issues", async () => {
  const urls: string[] = [];
  const gateway = new GitHubRestGateway("read-token", async (url) => {
    const value = String(url);
    urls.push(value);
    if (value.endsWith("/repos/acme/checkout/issues/42")) {
      return Response.json({
        number: 42,
        title: "Prevent duplicate settlement",
        body: null,
        pull_request: { url: "https://api.github.com/repos/acme/checkout/pulls/42" },
      });
    }
    throw new Error(`Unexpected GitHub request: ${value}`);
  });

  const issue = await gateway.getIssue("acme/checkout", 42);

  assert.deepEqual(issue, {
    number: 42,
    title: "Prevent duplicate settlement",
    body: "",
    isPullRequest: true,
  });
  assert.deepEqual(urls, ["https://api.github.com/repos/acme/checkout/issues/42"]);
});

test("GitHub gateway resolves and de-duplicates every PR associated with a merge-group commit", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ number: index + 1 }));
  const urls: string[] = [];
  const gateway = new GitHubRestGateway("read-token", async (url) => {
    const value = String(url);
    urls.push(value);
    if (value.includes("/commits/abcdef1/pulls?per_page=100&page=1")) {
      return Response.json(firstPage);
    }
    if (value.includes("/commits/abcdef1/pulls?per_page=100&page=2")) {
      return Response.json([{ number: 100 }, { number: 101 }]);
    }
    throw new Error(`Unexpected GitHub request: ${value}`);
  });

  const pullRequests = await gateway.getPullRequestsForCommit("acme/checkout", "abcdef1");

  assert.equal(pullRequests.length, 101);
  assert.equal(pullRequests[0], 1);
  assert.equal(pullRequests.at(-1), 101);
  assert.ok(urls.some((url) => url.includes("page=2")));
});

test("GitHub gateway reads source-pinned branch-protection Check Runs", async () => {
  const gateway = new GitHubRestGateway(
    "read-token",
    async (url) => {
      assert.match(String(url), /branches\/main\/protection\/required_status_checks$/);
      return new Response(JSON.stringify({
        checks: [
          { context: "ci / test", app_id: 12 },
          { context: "MergeProof / evidence", app_id: 99 },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  );
  assert.deepEqual(
    await gateway.getRequiredStatusChecks("acme/checkout-service", "main"),
    [
      { name: "ci / test", appId: 12 },
      { name: "MergeProof / evidence", appId: 99 },
    ],
  );
});

test("GitHub gateway rejects an oversized PR diff before buffering it in memory", async () => {
  const gateway = new GitHubRestGateway("read-token", async (url, init) => {
    const value = String(url);
    const accept = new Headers(init?.headers).get("accept");
    if (value.endsWith("/repos/acme/checkout/pulls/42") && accept === "application/vnd.github.diff") {
      return new Response("x".repeat(2 * 1024 * 1024 + 1));
    }
    if (value.endsWith("/repos/acme/checkout/pulls/42")) {
      return Response.json({
        node_id: "PR_42",
        state: "open",
        draft: false,
        base: { sha: "base" },
        head: { sha: "head" },
        merge_commit_sha: "merge",
        title: "Fixture",
        body: "Fixture body",
        labels: [],
      });
    }
    if (value.includes("/check-runs?per_page=100&page=1")) {
      return Response.json({ check_runs: [] });
    }
    if (value.includes("/reviews?per_page=100&page=1")) {
      return Response.json([]);
    }
    throw new Error(`Unexpected GitHub request: ${value}`);
  });

  await assert.rejects(
    gateway.getPullRequest("acme/checkout", 42),
    /diff exceeds the 2097152-byte safety limit/,
  );
});
