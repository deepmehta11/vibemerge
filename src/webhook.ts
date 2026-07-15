import { verifyGithubWebhookSignature } from "./crypto.js";

export interface DeliveryLedger {
  registerDelivery(deliveryId: string, now?: number): boolean;
}

export interface DurableWebhookInbox {
  enqueueWebhook(
    deliveryId: string,
    eventName: string,
    body: string,
    now?: number,
  ): boolean | "inbox_full";
}

export type WebhookAcceptance =
  | { accepted: true; deliveryId: string }
  | { accepted: false; reason: "invalid_signature" | "missing_delivery" | "duplicate_delivery" };

export type WebhookQueueAcceptance =
  | { accepted: true; deliveryId: string }
  | {
      accepted: false;
      reason:
        | "invalid_signature"
        | "missing_delivery"
        | "duplicate_delivery"
        | "missing_event"
        | "inbox_full";
    };

/** Authentication and idempotency boundary for a future GitHub App HTTP route. */
export function acceptGitHubDelivery(
  input: { body: string; signature?: string; deliveryId?: string },
  secret: string,
  ledger: DeliveryLedger,
): WebhookAcceptance {
  if (!verifyGithubWebhookSignature(input.body, input.signature, secret)) {
    return { accepted: false, reason: "invalid_signature" };
  }
  if (!input.deliveryId) {
    return { accepted: false, reason: "missing_delivery" };
  }
  if (!ledger.registerDelivery(input.deliveryId)) {
    return { accepted: false, reason: "duplicate_delivery" };
  }
  return { accepted: true, deliveryId: input.deliveryId };
}

/**
 * The durable path for an HTTP webhook: verify the raw request before parsing,
 * then atomically persist the delivery prior to returning HTTP 202.
 */
export function queueGitHubDelivery(
  input: { body: string; signature?: string; deliveryId?: string; eventName?: string },
  secret: string,
  inbox: DurableWebhookInbox,
): WebhookQueueAcceptance {
  if (!verifyGithubWebhookSignature(input.body, input.signature, secret)) {
    return { accepted: false, reason: "invalid_signature" };
  }
  if (!input.deliveryId) {
    return { accepted: false, reason: "missing_delivery" };
  }
  if (!input.eventName) {
    return { accepted: false, reason: "missing_event" };
  }
  const queued = inbox.enqueueWebhook(input.deliveryId, input.eventName, input.body);
  if (queued === "inbox_full") {
    return { accepted: false, reason: "inbox_full" };
  }
  if (!queued) {
    return { accepted: false, reason: "duplicate_delivery" };
  }
  return { accepted: true, deliveryId: input.deliveryId };
}
