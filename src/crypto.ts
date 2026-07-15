import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { EvidenceReceipt, PinnedRevision } from "./domain.js";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function normalize(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(normalize);
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const output: Record<string, JsonValue> = {};
    for (const key of Object.keys(record).sort()) {
      const entry = record[key];
      if (entry === undefined) {
        throw new TypeError(`Canonical JSON cannot contain undefined (${key}).`);
      }
      output[key] = normalize(entry);
    }
    return output;
  }

  throw new TypeError(`Canonical JSON cannot contain ${typeof value}.`);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Hash exact artifact bytes rather than a decoded text representation. */
export function sha256Bytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function revisionRunKey(revision: PinnedRevision): string {
  return sha256(canonicalJson(revision));
}

export function sealReceipt(
  receipt: Omit<EvidenceReceipt, "integrityHash">,
): EvidenceReceipt {
  return {
    ...receipt,
    integrityHash: sha256(canonicalJson(receipt)),
  };
}

export function verifyReceipt(receipt: EvidenceReceipt): boolean {
  const { integrityHash, ...unsigned } = receipt;
  return timingSafeEqual(
    Buffer.from(integrityHash, "hex"),
    Buffer.from(sha256(canonicalJson(unsigned)), "hex"),
  );
}

export function githubWebhookSignature(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

export function verifyGithubWebhookSignature(
  body: string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature?.startsWith("sha256=")) {
    return false;
  }

  const expected = Buffer.from(githubWebhookSignature(body, secret));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
