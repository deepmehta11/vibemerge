import { createServer, type IncomingMessage, type Server } from "node:http";

import type { DurableWebhookInbox } from "./webhook.js";
import { queueGitHubDelivery } from "./webhook.js";
import { serveOperatorConsole, type OperatorConsoleConfig } from "./operator-server.js";
import { claimProofDemoPage } from "./demo-page.js";

export interface GitHubWebhookServerConfig {
  secret: string;
  inbox: DurableWebhookInbox;
  maxBodyBytes?: number;
  /** Returns false while this process is draining and must receive no new traffic. */
  isReady?: () => boolean;
  operatorConsole?: OperatorConsoleConfig;
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const contentLength = header(request, "content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new RangeError("Webhook body exceeds the configured limit.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new RangeError("Webhook body exceeds the configured limit.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reply(
  response: import("node:http").ServerResponse,
  status: number,
  body: object,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(body));
}

function isReady(config: GitHubWebhookServerConfig): boolean {
  try {
    return config.isReady?.() ?? true;
  } catch {
    return false;
  }
}

/**
 * Queue-only webhook boundary. It never starts an E2B run on GitHub's HTTP
 * request and only returns 202 after the authenticated delivery is durable.
 */
export function createGitHubWebhookServer(config: GitHubWebhookServerConfig): Server {
  const maxBodyBytes = config.maxBodyBytes ?? 1_000_000;
  return createServer(async (request, response) => {
    if (config.operatorConsole && serveOperatorConsole(request, response, config.operatorConsole)) {
      return;
    }
    if (request.method === "GET" && request.url === "/healthz") {
      reply(response, 200, { status: "ok", service: "mergeproof" });
      return;
    }
    if (request.method === "GET" && request.url === "/demo") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=300",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
      });
      response.end(claimProofDemoPage());
      return;
    }
    if (request.method === "GET" && request.url === "/readyz") {
      const ready = isReady(config);
      reply(response, ready ? 200 : 503, {
        status: ready ? "ready" : "not_ready",
        service: "mergeproof",
      });
      return;
    }
    if (request.method !== "POST" || request.url !== "/webhooks/github") {
      reply(response, 404, { error: "not_found" });
      return;
    }
    // A keep-alive connection can outlive server.close(). Refuse new durable
    // work once shutdown begins so GitHub retries it against a ready replica.
    if (!isReady(config)) {
      reply(response, 503, { accepted: false, reason: "service_draining" }, { "retry-after": "5" });
      return;
    }
    try {
      const body = await readBody(request, maxBodyBytes);
      const signature = header(request, "x-hub-signature-256");
      const deliveryId = header(request, "x-github-delivery");
      const eventName = header(request, "x-github-event");
      const result = queueGitHubDelivery(
        {
          body,
          ...(signature ? { signature } : {}),
          ...(deliveryId ? { deliveryId } : {}),
          ...(eventName ? { eventName } : {}),
        },
        config.secret,
        config.inbox,
      );
      if (result.accepted) {
        reply(response, 202, { accepted: true, deliveryId: result.deliveryId });
        return;
      }
      const status = result.reason === "invalid_signature" ? 401 : result.reason === "inbox_full" ? 503 : 400;
      reply(
        response,
        status,
        { accepted: false, reason: result.reason },
        result.reason === "inbox_full" ? { "retry-after": "5" } : {},
      );
    } catch (error) {
      if (error instanceof RangeError) {
        reply(response, 413, { error: "payload_too_large" });
        return;
      }
      reply(response, 500, { error: "webhook_inbox_unavailable" });
    }
  });
}
