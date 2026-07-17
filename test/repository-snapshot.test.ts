import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubRestRepositorySnapshotProvider,
  RepositorySnapshotError,
  type RepositorySnapshotRequest,
} from "../src/repository-snapshot.js";

const commitSha = "a".repeat(40);
const otherCommitSha = "f".repeat(40);
const treeSha = "b".repeat(40);
const firstBlobSha = "c".repeat(40);
const secondBlobSha = "d".repeat(40);
const token = "installation-read-token";

const request: RepositorySnapshotRequest = {
  repository: "acme/checkout-service",
  sha: commitSha,
  githubReadToken: token,
};

function json(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
}

function blob(sha: string, content: Buffer): Response {
  return json({
    sha,
    size: content.byteLength,
    encoding: "base64",
    content: content.toString("base64"),
  });
}

function commitResponse(sha = commitSha, rootTreeSha = treeSha): Response {
  return json({ sha, tree: { sha: rootTreeSha } });
}

function treeResponse(entries: unknown[], overrides: Record<string, unknown> = {}): Response {
  return json({ sha: treeSha, truncated: false, tree: entries, ...overrides });
}

function regularFile(path: string, sha: string, size: number): Record<string, unknown> {
  return { path, mode: "100644", type: "blob", sha, size };
}

test("fetchFiles binds commit, tree, and blobs to the requested SHA and returns normalized source text", async () => {
  const firstContent = Buffer.from("export const value = 1;\r\n", "utf8");
  const secondContent = Buffer.from("export function run() {\r  return value;\r}\r", "utf8");
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let firstBlobCalls = 0;
  const provider = new GitHubRestRepositorySnapshotProvider(async (url, init) => {
    const stringUrl = String(url);
    calls.push({ url: stringUrl, init });
    if (stringUrl.endsWith(`/git/commits/${commitSha}`)) return commitResponse();
    if (stringUrl.endsWith(`/git/trees/${treeSha}?recursive=1`)) {
      return treeResponse([
        { path: "src", mode: "040000", type: "tree", sha: "e".repeat(40) },
        regularFile("z.js", firstBlobSha, firstContent.byteLength),
        regularFile("README.md", secondBlobSha, secondContent.byteLength),
        regularFile("jobs/run.py", firstBlobSha, firstContent.byteLength),
        regularFile("src/a.ts", secondBlobSha, secondContent.byteLength),
        // Reusing an immutable blob should perform only one API request.
        regularFile("src/copy.cts", firstBlobSha, firstContent.byteLength),
        regularFile("types/api.pyi", secondBlobSha, secondContent.byteLength),
      ]);
    }
    if (stringUrl.endsWith(`/git/blobs/${firstBlobSha}`)) {
      firstBlobCalls += 1;
      return blob(firstBlobSha, firstContent);
    }
    if (stringUrl.endsWith(`/git/blobs/${secondBlobSha}`)) return blob(secondBlobSha, secondContent);
    throw new Error(`Unexpected URL: ${stringUrl}`);
  });

  const files = await provider.fetchFiles(request);

  assert.deepEqual(files, [
    { path: "jobs/run.py", content: "export const value = 1;\n" },
    { path: "src/a.ts", content: "export function run() {\n  return value;\n}\n" },
    { path: "src/copy.cts", content: "export const value = 1;\n" },
    { path: "types/api.pyi", content: "export function run() {\n  return value;\n}\n" },
    { path: "z.js", content: "export const value = 1;\n" },
  ]);
  assert.equal(firstBlobCalls, 1);
  assert.deepEqual(calls.slice(0, 2).map((call) => call.url), [
    `https://api.github.com/repos/acme/checkout-service/git/commits/${commitSha}`,
    `https://api.github.com/repos/acme/checkout-service/git/trees/${treeSha}?recursive=1`,
  ]);
  for (const call of calls) {
    const headers = new Headers(call.init?.headers);
    assert.equal(headers.get("authorization"), `Bearer ${token}`);
    assert.equal(headers.get("accept"), "application/vnd.github+json");
    assert.equal(headers.get("x-github-api-version"), "2026-03-10");
    assert.ok(call.init?.signal instanceof AbortSignal);
  }
});

test("fetchFiles rejects symbolic, abbreviated, uppercase, or malformed repository coordinates before fetching", async () => {
  let fetches = 0;
  const provider = new GitHubRestRepositorySnapshotProvider(async () => {
    fetches += 1;
    return commitResponse();
  });
  const invalidCoordinates: RepositorySnapshotRequest[] = [
    { ...request, repository: "acme/../secret" },
    { ...request, repository: "acme/checkout/service" },
    { ...request, sha: "main" },
    { ...request, sha: commitSha.slice(0, 12) },
    { ...request, sha: commitSha.toUpperCase() },
    { ...request, githubReadToken: "bad\ntoken" },
  ];
  for (const invalid of invalidCoordinates) {
    await assert.rejects(() => provider.fetchFiles(invalid), RepositorySnapshotError);
  }
  assert.equal(fetches, 0);
});

test("fetchFiles fails closed when GitHub does not return the exact commit or root tree", async (context) => {
  await context.test("non-object commit response", async () => {
    const provider = new GitHubRestRepositorySnapshotProvider(async () => json(null));
    await assert.rejects(() => provider.fetchFiles(request), /commit response is not an object/i);
  });

  await context.test("commit mismatch", async () => {
    const provider = new GitHubRestRepositorySnapshotProvider(async () => commitResponse(otherCommitSha));
    await assert.rejects(() => provider.fetchFiles(request), /not bound to the requested SHA/i);
  });

  await context.test("tree mismatch", async () => {
    let call = 0;
    const provider = new GitHubRestRepositorySnapshotProvider(async () => {
      call += 1;
      return call === 1 ? commitResponse() : treeResponse([], { sha: "e".repeat(40) });
    });
    await assert.rejects(() => provider.fetchFiles(request), /not bound to the commit tree SHA/i);
  });

  await context.test("truncated tree", async () => {
    let call = 0;
    const provider = new GitHubRestRepositorySnapshotProvider(async () => {
      call += 1;
      return call === 1 ? commitResponse() : treeResponse([], { truncated: true });
    });
    await assert.rejects(() => provider.fetchFiles(request), /truncated.*fail closed/i);
  });
});

test("fetchFiles rejects unsafe, duplicate, and non-regular source paths", async (context) => {
  const cases: Array<{ name: string; entries: unknown[]; pattern: RegExp }> = [
    {
      name: "traversal",
      entries: [regularFile("../escape.ts", firstBlobSha, 1)],
      pattern: /unsafe path/i,
    },
    {
      name: "backslash",
      entries: [regularFile("src\\escape.ts", firstBlobSha, 1)],
      pattern: /unsafe path/i,
    },
    {
      name: "duplicate",
      entries: [regularFile("src/a.ts", firstBlobSha, 1), regularFile("src/a.ts", secondBlobSha, 1)],
      pattern: /duplicate paths/i,
    },
    {
      name: "source symlink",
      entries: [{ ...regularFile("src/link.ts", firstBlobSha, 1), mode: "120000" }],
      pattern: /not a regular file/i,
    },
  ];
  for (const item of cases) {
    await context.test(item.name, async () => {
      let call = 0;
      const provider = new GitHubRestRepositorySnapshotProvider(async () => {
        call += 1;
        return call === 1 ? commitResponse() : treeResponse(item.entries);
      });
      await assert.rejects(() => provider.fetchFiles(request), item.pattern);
      assert.equal(call, 2);
    });
  }
});

test("fetchFiles applies file-count, per-file, total-byte, tree-entry, and response-body limits before use", async (context) => {
  const twoFiles = [
    regularFile("a.ts", firstBlobSha, 2),
    regularFile("b.ts", secondBlobSha, 2),
  ];
  const limitCases: Array<{
    name: string;
    limits: ConstructorParameters<typeof GitHubRestRepositorySnapshotProvider>[2];
    entries: unknown[];
    pattern: RegExp;
  }> = [
    { name: "file count", limits: { maxSourceFiles: 1 }, entries: twoFiles, pattern: /file-count limit/i },
    { name: "file bytes", limits: { maxFileBytes: 1 }, entries: [twoFiles[0]], pattern: /per-file byte limit/i },
    { name: "total bytes", limits: { maxTotalFileBytes: 3 }, entries: twoFiles, pattern: /total byte limit/i },
    { name: "tree entries", limits: { maxTreeEntries: 1 }, entries: twoFiles, pattern: /entry limit/i },
  ];
  for (const item of limitCases) {
    await context.test(item.name, async () => {
      let call = 0;
      const provider = new GitHubRestRepositorySnapshotProvider(
        async () => {
          call += 1;
          return call === 1 ? commitResponse() : treeResponse(item.entries);
        },
        "https://api.github.com",
        item.limits,
      );
      await assert.rejects(() => provider.fetchFiles(request), item.pattern);
      assert.equal(call, 2, "blob requests must not start before all declared limits pass");
    });
  }

  await context.test("streamed response bytes", async () => {
    let call = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(200));
        controller.enqueue(new Uint8Array(200));
      },
      cancel() {
        cancelled = true;
      },
    });
    const provider = new GitHubRestRepositorySnapshotProvider(
      async () => {
        call += 1;
        return call === 1 ? new Response(stream, { status: 200 }) : treeResponse([]);
      },
      "https://api.github.com",
      { maxCommitResponseBytes: 256 },
    );
    await assert.rejects(() => provider.fetchFiles(request), /commit response exceeds its byte limit/i);
    assert.equal(cancelled, true);
  });
});

test("fetchFiles verifies blob SHA, encoding, declared size, bytes, and UTF-8", async (context) => {
  const oneByteEntry = regularFile("src/a.ts", firstBlobSha, 1);
  const blobCases: Array<{ name: string; response: Response; pattern: RegExp }> = [
    {
      name: "blob SHA",
      response: json({ sha: secondBlobSha, size: 1, encoding: "base64", content: "YQ==" }),
      pattern: /not bound to the tree blob SHA/i,
    },
    {
      name: "encoding",
      response: json({ sha: firstBlobSha, size: 1, encoding: "utf-8", content: "a" }),
      pattern: /unsupported encoding/i,
    },
    {
      name: "declared size",
      response: json({ sha: firstBlobSha, size: 2, encoding: "base64", content: "YQ==" }),
      pattern: /tree and blob byte sizes/i,
    },
    {
      name: "malformed base64",
      response: json({ sha: firstBlobSha, size: 1, encoding: "base64", content: "not base64!" }),
      pattern: /malformed base64/i,
    },
    {
      name: "decoded size",
      response: json({ sha: firstBlobSha, size: 1, encoding: "base64", content: "YWI=" }),
      pattern: /content does not match/i,
    },
    {
      name: "UTF-8",
      response: blob(firstBlobSha, Buffer.from([0xff])),
      pattern: /not valid UTF-8/i,
    },
  ];
  for (const item of blobCases) {
    await context.test(item.name, async () => {
      let call = 0;
      const provider = new GitHubRestRepositorySnapshotProvider(async () => {
        call += 1;
        if (call === 1) return commitResponse();
        if (call === 2) return treeResponse([oneByteEntry]);
        return item.response;
      });
      await assert.rejects(() => provider.fetchFiles(request), item.pattern);
      assert.equal(call, 3);
    });
  }
});

test("fetchFiles never reflects tokens from HTTP bodies, fetch failures, or stream failures", async (context) => {
  await context.test("HTTP body", async () => {
    const provider = new GitHubRestRepositorySnapshotProvider(async () =>
      new Response(`upstream reflected Authorization: Bearer ${token}`, { status: 403 })
    );
    await assert.rejects(
      () => provider.fetchFiles(request),
      (error: unknown) => error instanceof Error && !error.message.includes(token) && /status 403/.test(error.message),
    );
  });

  await context.test("fetch exception", async () => {
    const provider = new GitHubRestRepositorySnapshotProvider(async () => {
      throw new Error(`socket error for ${token}`);
    });
    await assert.rejects(
      () => provider.fetchFiles(request),
      (error: unknown) => error instanceof Error && !error.message.includes(token) && /request failed/.test(error.message),
    );
  });

  await context.test("stream exception", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull() {
        throw new Error(`stream error for ${token}`);
      },
    });
    const provider = new GitHubRestRepositorySnapshotProvider(async () => new Response(stream, { status: 200 }));
    await assert.rejects(
      () => provider.fetchFiles(request),
      (error: unknown) => error instanceof Error && !error.message.includes(token) && /could not be read/.test(error.message),
    );
  });
});
