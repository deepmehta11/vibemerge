import assert from "node:assert/strict";
import test from "node:test";

import { GitHubRestSourceArchiveProvider } from "../src/github-source.js";

test("source archive provider downloads the exact SHA with a controller-only read token", async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const provider = new GitHubRestSourceArchiveProvider(async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 });
  });
  const archive = await provider.fetchArchive({
    repository: "acme/checkout-service",
    sha: "merge-123",
    githubReadToken: "read-token",
  });

  assert.deepEqual([...archive], [1, 2, 3, 4]);
  assert.equal(
    calls[0]?.url,
    "https://api.github.com/repos/acme/checkout-service/tarball/merge-123",
  );
  assert.equal(
    new Headers(calls[0]?.init?.headers).get("authorization"),
    "Bearer read-token",
  );
});

test("source archive provider rejects archives exceeding the configured limit", async () => {
  const provider = new GitHubRestSourceArchiveProvider(
    async () =>
      new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { "content-length": "4" },
      }),
    "https://api.github.com",
    3,
  );
  await assert.rejects(
    () =>
      provider.fetchArchive({
        repository: "acme/checkout-service",
        sha: "merge-123",
        githubReadToken: "read-token",
      }),
    /size limit/i,
  );
});

test("source archive provider stops an unbounded streaming response at the configured limit", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3, 4]));
    },
    cancel() {
      cancelled = true;
    },
  });
  const provider = new GitHubRestSourceArchiveProvider(
    async () => new Response(stream, { status: 200 }),
    "https://api.github.com",
    3,
  );

  await assert.rejects(
    () => provider.fetchArchive({ repository: "acme/checkout-service", sha: "merge-123", githubReadToken: "read-token" }),
    /size limit/i,
  );
  assert.equal(cancelled, true);
});
