import { z } from "zod";

import { canonicalJson, sha256 } from "./crypto.js";

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const relativeDirectory = z
  .string()
  .min(1)
  .max(240)
  .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
    message: "Working directory must stay inside the extracted source tree.",
  });
const localPath = z
  .string()
  .min(1)
  .max(500)
  .startsWith("/")
  .refine((value) => !value.startsWith("//") && !value.includes("://") && !/[\r\n\0]/.test(value), {
    message: "Replay endpoints must be bounded localhost-relative paths.",
  });
const argument = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => !/[\r\n\0]/.test(value), {
    message: "Application arguments cannot contain control characters.",
  });
const safeEnvironmentName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
  .refine((value) => !/(?:SECRET|TOKEN|PASSWORD|PRIVATE|CREDENTIAL|API_KEY)/.test(value), {
    message: "Replay profiles cannot carry credential-shaped environment names.",
  });
const safeEnvironmentValue = z
  .string()
  .max(1_000)
  .refine((value) => !/[\0]/.test(value), {
    message: "Replay profile environment values cannot contain NUL bytes.",
  });
const method = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const operationPath = localPath.refine(
  (value) => /^\/(?:[A-Za-z0-9._~-]+|\{[a-z][a-z0-9_-]*\})(?:\/(?:[A-Za-z0-9._~-]+|\{[a-z][a-z0-9_-]*\}))*$/.test(value),
  { message: "Operation paths must use fixed segments or named placeholders." },
);

const profileEndpoint = z
  .object({
    method,
    path: localPath,
    expectedStatus: z.number().int().min(100).max(599),
  })
  .strict();

const applicationCommon = {
  cwd: relativeDirectory,
  args: z.array(argument).min(1).max(20),
  env: z.record(safeEnvironmentName, safeEnvironmentValue).default({}),
  port: z.number().int().min(1_024).max(65_535),
  health: profileEndpoint.extend({
    method: z.enum(["GET", "HEAD"]),
    timeoutMs: z.number().int().min(100).max(60_000),
    intervalMs: z.number().int().min(25).max(2_000),
  }).strict(),
  shutdownGraceMs: z.number().int().min(0).max(10_000),
};

const trustedReplayProfileSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: identifier,
    application: z.discriminatedUnion("runtime", [
      z.object({ runtime: z.literal("node"), executable: z.literal("node"), ...applicationCommon }).strict(),
      z.object({ runtime: z.literal("python"), executable: z.literal("python3"), ...applicationCommon }).strict(),
    ]),
    operations: z
      .array(
        z.object({
          id: identifier,
          method,
          pathTemplate: operationPath,
          allowedQueryKeys: z.array(identifier).max(16),
          allowedBodyKeys: z.array(identifier).max(24),
          maxInvocations: z.number().int().min(1).max(8),
        }).strict(),
      )
      .min(1)
      .max(100)
      .refine((entries) => new Set(entries.map(({ id }) => id)).size === entries.length, {
        message: "Replay operation identifiers must be unique.",
      })
      .refine(
        (entries) => new Set(entries.map(({ method, pathTemplate }) => `${method}:${pathTemplate}`)).size === entries.length,
        { message: "Replay operation method and path pairs must be unique." },
      ),
    fixtures: z
      .array(
        z
          .object({
            id: identifier,
            setupEndpoint: profileEndpoint,
            stateEndpoint: profileEndpoint,
          })
          .strict(),
      )
      .max(50)
      .refine((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length, {
        message: "Replay fixture identifiers must be unique.",
      }),
  })
  .strict();

export type TrustedReplayProfile = z.infer<typeof trustedReplayProfileSchema>;

/**
 * Parses controller-owned application plumbing. Model output never supplies a
 * command, environment variable, port, fixture endpoint, or state endpoint.
 */
export function parseTrustedReplayProfile(value: unknown): TrustedReplayProfile {
  const parsed = trustedReplayProfileSchema.parse(value);
  return {
    ...parsed,
    application: {
      ...parsed.application,
      env: Object.fromEntries(
        Object.entries(parsed.application.env).sort(([left], [right]) => left.localeCompare(right)),
      ),
    },
    operations: parsed.operations
      .map((operation) => ({
        ...operation,
        allowedQueryKeys: [...operation.allowedQueryKeys].sort(),
        allowedBodyKeys: [...operation.allowedBodyKeys].sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    fixtures: [...parsed.fixtures].sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function trustedReplayProfileDigest(profile: TrustedReplayProfile): string {
  return sha256(canonicalJson(parseTrustedReplayProfile(profile)));
}

/** The only origin a replay plan may reach inside its no-egress sandbox. */
export function replayOrigin(profile: TrustedReplayProfile): string {
  return `http://127.0.0.1:${profile.application.port}`;
}
