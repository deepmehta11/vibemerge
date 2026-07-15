import type { GitHubSourceArchiveProvider } from "./e2b-harness.js";

/** Downloads a bounded GitHub tarball on the controller, before E2B starts. */
export class GitHubRestSourceArchiveProvider implements GitHubSourceArchiveProvider {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
    private readonly maxArchiveBytes = 100 * 1024 * 1024,
  ) {}

  async fetchArchive(input: {
    repository: string;
    sha: string;
    githubReadToken: string;
  }): Promise<Uint8Array> {
    const response = await this.fetchImpl(
      `${this.apiBase}/repos/${input.repository}/tarball/${encodeURIComponent(input.sha)}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${input.githubReadToken}`,
          "X-GitHub-Api-Version": "2026-03-10",
        },
        redirect: "follow",
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub source archive ${response.status}: ${(await response.text()).slice(0, 500)}`);
    }
    const contentLength = response.headers.get("content-length");
    if (contentLength && Number(contentLength) > this.maxArchiveBytes) {
      throw new Error("GitHub source archive exceeds the configured size limit.");
    }
    if (!response.body) {
      throw new Error("GitHub source archive did not include a response body.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > this.maxArchiveBytes) {
          await reader.cancel();
          throw new Error("GitHub source archive exceeds the configured size limit.");
        }
        chunks.push(next.value);
      }
    } finally {
      reader.releaseLock();
    }
    const archive = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      archive.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return archive;
  }
}
