import { sign } from "node:crypto";

export type GitHubPermission = "read" | "write";

export interface InstallationTokenRequest {
  installationId: number;
  /** Full repository name, e.g. owner/repository. Exactly one per run. */
  repository: string;
  permissions: Record<string, GitHubPermission>;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

export interface InstallationTokenProvider {
  mint(request: InstallationTokenRequest): Promise<InstallationToken>;
}

function base64urlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Creates a GitHub App JWT using only Node crypto. GitHub requires RS256, a
 * clock-skewed iat, and an expiry no more than ten minutes in the future.
 */
export function createGitHubAppJwt(input: {
  appId: string;
  privateKeyPem: string;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const seconds = Math.floor(now.getTime() / 1_000);
  const encodedHeader = base64urlJson({ alg: "RS256", typ: "JWT" });
  const encodedPayload = base64urlJson({
    iat: seconds - 60,
    exp: seconds + 9 * 60,
    iss: input.appId,
  });
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("RSA-SHA256", Buffer.from(unsigned), input.privateKeyPem).toString(
    "base64url",
  );
  return `${unsigned}.${signature}`;
}

type TokenResponse = {
  token?: unknown;
  expires_at?: unknown;
};

/**
 * Mints one uncached, down-scoped installation token per controller action.
 * Keeping this provider separate makes it possible to run verification without
 * ever exposing Contents:write to E2B or an agent process.
 */
export class GitHubAppInstallationTokenProvider implements InstallationTokenProvider {
  constructor(
    private readonly appId: string,
    private readonly privateKeyPem: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly apiBase = "https://api.github.com",
    private readonly now: () => Date = () => new Date(),
  ) {}

  async mint(request: InstallationTokenRequest): Promise<InstallationToken> {
    const separator = request.repository.indexOf("/");
    if (separator <= 0 || separator === request.repository.length - 1) {
      throw new Error("Installation token requires an owner/repository name.");
    }
    const repositoryName = request.repository.slice(separator + 1);
    const jwt = createGitHubAppJwt({
      appId: this.appId,
      privateKeyPem: this.privateKeyPem,
      now: this.now(),
    });
    const response = await this.fetchImpl(
      `${this.apiBase}/app/installations/${request.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: JSON.stringify({
          repositories: [repositoryName],
          permissions: request.permissions,
        }),
      },
    );
    if (!response.ok) {
      throw new Error(
        `GitHub installation token request ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    }
    const body = (await response.json()) as TokenResponse;
    if (typeof body.token !== "string" || typeof body.expires_at !== "string") {
      throw new Error("GitHub installation-token response is missing token or expiration.");
    }
    return { token: body.token, expiresAt: body.expires_at };
  }
}
