import path from "node:path";

import type { RepositoryFile } from "./impact-mapper.js";

export interface RepositorySnapshotRequest {
  /** Exact GitHub `owner/repository` coordinate. */
  repository: string;
  /** Full, lowercase Git object id. Abbreviated or symbolic refs are rejected. */
  sha: string;
  /** Installation token with read-only Contents permission. */
  githubReadToken: string;
}

export interface RepositorySnapshotProvider {
  fetchFiles(input: RepositorySnapshotRequest): Promise<RepositoryFile[]>;
}

export interface RepositorySnapshotLimits {
  maxTreeEntries: number;
  maxSourceFiles: number;
  maxFileBytes: number;
  maxTotalFileBytes: number;
  maxCommitResponseBytes: number;
  maxTreeResponseBytes: number;
  maxPathBytes: number;
  maxConcurrentBlobRequests: number;
  requestTimeoutMs: number;
}

export class RepositorySnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositorySnapshotError";
  }
}

const defaultLimits: RepositorySnapshotLimits = {
  maxTreeEntries: 100_000,
  maxSourceFiles: 5_000,
  maxFileBytes: 2 * 1024 * 1024,
  maxTotalFileBytes: 32 * 1024 * 1024,
  maxCommitResponseBytes: 256 * 1024,
  maxTreeResponseBytes: 16 * 1024 * 1024,
  maxPathBytes: 1_024,
  maxConcurrentBlobRequests: 8,
  requestTimeoutMs: 30_000,
};

const sourceExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".py",
  ".pyi",
  ".ts",
  ".tsx",
]);

type GitCommitResponse = {
  sha?: unknown;
  tree?: { sha?: unknown } | null;
};

type GitTreeEntry = {
  path?: unknown;
  mode?: unknown;
  type?: unknown;
  sha?: unknown;
  size?: unknown;
};

type GitTreeResponse = {
  sha?: unknown;
  truncated?: unknown;
  tree?: unknown;
};

type GitBlobResponse = {
  sha?: unknown;
  size?: unknown;
  encoding?: unknown;
  content?: unknown;
};

interface SelectedBlob {
  path: string;
  sha: string;
  size: number;
}

const fullObjectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const repositorySegmentPattern = /^[A-Za-z0-9_.-]{1,100}$/;
const strictBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function effectiveLimits(overrides: Partial<RepositorySnapshotLimits> | undefined): RepositorySnapshotLimits {
  const limits = { ...defaultLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RepositorySnapshotError(`Repository snapshot limit ${name} must be a positive safe integer.`);
    }
  }
  if (limits.maxConcurrentBlobRequests > 32) {
    throw new RepositorySnapshotError("Repository snapshot blob concurrency cannot exceed 32.");
  }
  if (limits.requestTimeoutMs > 300_000) {
    throw new RepositorySnapshotError("Repository snapshot request timeout cannot exceed five minutes.");
  }
  return limits;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatedCoordinates(input: RepositorySnapshotRequest): {
  repositoryPath: string;
  sha: string;
  token: string;
} {
  const segments = input.repository.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) =>
      !repositorySegmentPattern.test(segment) || segment === "." || segment === ".."
    )
  ) {
    throw new RepositorySnapshotError("GitHub repository must be an exact owner/repository coordinate.");
  }
  if (!fullObjectIdPattern.test(input.sha)) {
    throw new RepositorySnapshotError("Repository snapshot SHA must be a full, lowercase Git object id.");
  }
  if (
    typeof input.githubReadToken !== "string" ||
    input.githubReadToken.length === 0 ||
    input.githubReadToken.length > 4_096 ||
    /[\r\n]/.test(input.githubReadToken)
  ) {
    throw new RepositorySnapshotError("GitHub repository snapshot token is invalid.");
  }
  return {
    repositoryPath: segments.map((segment) => encodeURIComponent(segment)).join("/"),
    sha: input.sha,
    token: input.githubReadToken,
  };
}

function normalizedSafePath(value: unknown, maxPathBytes: number): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new RepositorySnapshotError("GitHub tree contains an invalid path.");
  }
  if (
    Buffer.byteLength(value, "utf8") > maxPathBytes ||
    value.startsWith("/") ||
    value.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new RepositorySnapshotError("GitHub tree contains an unsafe path.");
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    /^[A-Za-z]:\//.test(normalized)
  ) {
    throw new RepositorySnapshotError("GitHub tree contains an unsafe path.");
  }
  return normalized;
}

function exactObjectId(value: unknown, label: string): string {
  if (typeof value !== "string" || !fullObjectIdPattern.test(value)) {
    throw new RepositorySnapshotError(`GitHub ${label} response contains an invalid object id.`);
  }
  return value;
}

function boundedNonnegativeSize(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new RepositorySnapshotError(`GitHub ${label} response contains an invalid byte size.`);
  }
  return value;
}

function decodeBase64(value: unknown): Buffer {
  if (typeof value !== "string") {
    throw new RepositorySnapshotError("GitHub blob response does not contain base64 content.");
  }
  // GitHub may line-wrap base64 JSON content. No other whitespace is accepted.
  const compact = value.replace(/[\r\n]/g, "");
  if (!strictBase64Pattern.test(compact)) {
    throw new RepositorySnapshotError("GitHub blob response contains malformed base64 content.");
  }
  return Buffer.from(compact, "base64");
}

function decodeSourceText(content: Buffer): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new RepositorySnapshotError("GitHub source blob is not valid UTF-8 text.");
  }
  if (decoded.includes("\u0000")) {
    throw new RepositorySnapshotError("GitHub source blob contains a null byte.");
  }
  return decoded.replace(/\r\n?/g, "\n");
}

async function readBoundedBody(response: Response, maxBytes: number, label: string): Promise<string> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (Number.isFinite(parsedLength) && parsedLength > maxBytes) {
      throw new RepositorySnapshotError(`GitHub ${label} response exceeds its byte limit.`);
    }
  }
  if (!response.body) {
    throw new RepositorySnapshotError(`GitHub ${label} response has no body.`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RepositorySnapshotError(`GitHub ${label} response exceeds its byte limit.`);
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await mapper(value);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Builds an impact-mapper snapshot from GitHub's immutable Git object APIs.
 *
 * The provider resolves the exact commit, verifies its root tree, rejects a
 * truncated recursive tree, then verifies every selected blob against the
 * tree's object id and size. It never executes repository-controlled data.
 */
export class GitHubRestRepositorySnapshotProvider implements RepositorySnapshotProvider {
  private readonly limits: RepositorySnapshotLimits;

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
    limitOverrides?: Partial<RepositorySnapshotLimits>,
  ) {
    this.limits = effectiveLimits(limitOverrides);
  }

  async fetchFiles(input: RepositorySnapshotRequest): Promise<RepositoryFile[]> {
    const coordinates = validatedCoordinates(input);
    const prefix = `/repos/${coordinates.repositoryPath}/git`;
    const untrustedCommit = await this.requestJson(
      `${prefix}/commits/${coordinates.sha}`,
      coordinates.token,
      this.limits.maxCommitResponseBytes,
      "commit",
    );
    if (!isRecord(untrustedCommit)) {
      throw new RepositorySnapshotError("GitHub commit response is not an object.");
    }
    const commit = untrustedCommit as GitCommitResponse;
    const returnedCommitSha = exactObjectId(commit.sha, "commit");
    if (returnedCommitSha !== coordinates.sha) {
      throw new RepositorySnapshotError("GitHub commit response is not bound to the requested SHA.");
    }
    const treeSha = exactObjectId(commit.tree?.sha, "commit tree");
    const untrustedTree = await this.requestJson(
      `${prefix}/trees/${treeSha}?recursive=1`,
      coordinates.token,
      this.limits.maxTreeResponseBytes,
      "tree",
    );
    if (!isRecord(untrustedTree)) {
      throw new RepositorySnapshotError("GitHub tree response is not an object.");
    }
    const tree = untrustedTree as GitTreeResponse;
    if (exactObjectId(tree.sha, "tree") !== treeSha) {
      throw new RepositorySnapshotError("GitHub tree response is not bound to the commit tree SHA.");
    }
    if (tree.truncated !== false) {
      throw new RepositorySnapshotError("GitHub recursive tree is truncated; impact analysis must fail closed.");
    }
    if (!Array.isArray(tree.tree)) {
      throw new RepositorySnapshotError("GitHub tree response does not contain a tree array.");
    }
    if (tree.tree.length > this.limits.maxTreeEntries) {
      throw new RepositorySnapshotError("GitHub tree exceeds the configured entry limit.");
    }

    const selected: SelectedBlob[] = [];
    const seenPaths = new Set<string>();
    let declaredTotalBytes = 0;
    for (const untrustedEntry of tree.tree) {
      if (typeof untrustedEntry !== "object" || untrustedEntry === null || Array.isArray(untrustedEntry)) {
        throw new RepositorySnapshotError("GitHub tree contains an invalid entry.");
      }
      const entry = untrustedEntry as GitTreeEntry;
      const entryPath = normalizedSafePath(entry.path, this.limits.maxPathBytes);
      if (seenPaths.has(entryPath)) {
        throw new RepositorySnapshotError("GitHub tree contains duplicate paths.");
      }
      seenPaths.add(entryPath);

      if (entry.type !== "blob") continue;
      const extension = path.posix.extname(entryPath).toLowerCase();
      if (!sourceExtensions.has(extension)) continue;
      if (entry.mode !== "100644" && entry.mode !== "100755") {
        throw new RepositorySnapshotError("GitHub source path is not a regular file blob.");
      }
      const blobSha = exactObjectId(entry.sha, "tree blob");
      const blobSize = boundedNonnegativeSize(entry.size, "tree blob");
      if (blobSize > this.limits.maxFileBytes) {
        throw new RepositorySnapshotError("GitHub source file exceeds the configured per-file byte limit.");
      }
      declaredTotalBytes += blobSize;
      if (!Number.isSafeInteger(declaredTotalBytes) || declaredTotalBytes > this.limits.maxTotalFileBytes) {
        throw new RepositorySnapshotError("GitHub source snapshot exceeds the configured total byte limit.");
      }
      selected.push({ path: entryPath, sha: blobSha, size: blobSize });
      if (selected.length > this.limits.maxSourceFiles) {
        throw new RepositorySnapshotError("GitHub source snapshot exceeds the configured file-count limit.");
      }
    }

    selected.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const blobCache = new Map<string, Promise<Buffer>>();
    const files = await mapWithConcurrency(
      selected,
      this.limits.maxConcurrentBlobRequests,
      async (entry): Promise<RepositoryFile> => {
        let contentPromise = blobCache.get(entry.sha);
        if (!contentPromise) {
          contentPromise = this.fetchBlob(prefix, coordinates.token, entry.sha, entry.size);
          blobCache.set(entry.sha, contentPromise);
        }
        const content = await contentPromise;
        if (content.byteLength !== entry.size) {
          throw new RepositorySnapshotError("GitHub tree and blob byte sizes do not match.");
        }
        return { path: entry.path, content: decodeSourceText(content) };
      },
    );
    return files;
  }

  private async fetchBlob(prefix: string, token: string, expectedSha: string, expectedSize: number): Promise<Buffer> {
    const responseLimit = Math.ceil(this.limits.maxFileBytes * 4 / 3) + 64 * 1024;
    const untrustedBlob = await this.requestJson(
      `${prefix}/blobs/${expectedSha}`,
      token,
      responseLimit,
      "blob",
    );
    if (!isRecord(untrustedBlob)) {
      throw new RepositorySnapshotError("GitHub blob response is not an object.");
    }
    const blob = untrustedBlob as GitBlobResponse;
    if (exactObjectId(blob.sha, "blob") !== expectedSha) {
      throw new RepositorySnapshotError("GitHub blob response is not bound to the tree blob SHA.");
    }
    const blobSize = boundedNonnegativeSize(blob.size, "blob");
    if (blobSize !== expectedSize || blobSize > this.limits.maxFileBytes) {
      throw new RepositorySnapshotError("GitHub tree and blob byte sizes do not match.");
    }
    if (blob.encoding !== "base64") {
      throw new RepositorySnapshotError("GitHub blob response uses an unsupported encoding.");
    }
    const content = decodeBase64(blob.content);
    if (content.byteLength !== blobSize) {
      throw new RepositorySnapshotError("GitHub blob content does not match its declared byte size.");
    }
    return content;
  }

  private async requestJson(pathValue: string, token: string, maxBytes: number, label: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.apiBase}${pathValue}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2026-03-10",
        },
        signal: AbortSignal.timeout(this.limits.requestTimeoutMs),
      });
    } catch {
      // Fetch implementations can throw arbitrary messages. Do not propagate
      // them because they can contain credentials or response diagnostics.
      throw new RepositorySnapshotError(`GitHub ${label} request failed.`);
    }
    if (!response.ok) {
      // Deliberately do not include GitHub's response body: upstream proxies
      // sometimes reflect request headers into diagnostics.
      throw new RepositorySnapshotError(`GitHub ${label} request failed with status ${response.status}.`);
    }
    let raw: string;
    try {
      raw = await readBoundedBody(response, maxBytes, label);
    } catch (error) {
      if (error instanceof RepositorySnapshotError) throw error;
      throw new RepositorySnapshotError(`GitHub ${label} response body could not be read.`);
    }
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new RepositorySnapshotError(`GitHub ${label} response is not valid JSON.`);
    }
  }
}
