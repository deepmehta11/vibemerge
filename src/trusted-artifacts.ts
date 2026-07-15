import { canonicalJson, sha256, sha256Bytes } from "./crypto.js";

export type TrustedWorkspaceFile = string | Uint8Array;

export interface TrustedArtifactDigestInput {
  /** Exact E2B template build selector: <template>:<build-id>. */
  template: string;
  /** Controller-owned command executed after the trusted files are mounted. */
  command: string;
  /** Every static controller-mounted workspace artifact, keyed by final path. */
  workspaceFiles: Record<string, TrustedWorkspaceFile>;
}

/**
 * Fixture harnesses do not have a mounted E2B artifact bundle. Keeping their
 * deterministic sentinel separate makes that limitation explicit without
 * changing the fixture test path into a production configuration surface.
 */
export const FIXTURE_TRUSTED_ARTIFACT_DIGEST = sha256(
  canonicalJson({ schemaVersion: 1, source: "fixture-harness" }),
);

const immutableBuildReference = /^[^\s:]+:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * E2B template names and tags are mutable. The E2B SDK accepts a specific
 * build as `<template>:<build_id>`; production startup therefore rejects
 * aliases such as `base`, `my-template`, and `my-template:latest`.
 */
export function assertImmutableE2BTemplate(template: string): string {
  if (!immutableBuildReference.test(template)) {
    throw new Error(
      "MERGEPROOF_E2B_TEMPLATE must pin an immutable E2B build as <template>:<build-id>; template names and tags are not accepted.",
    );
  }
  return template;
}

function bytesFor(value: TrustedWorkspaceFile): Uint8Array {
  return typeof value === "string" ? Buffer.from(value, "utf8") : value;
}

/**
 * Produces a path-sorted, byte-exact identity for all controller-owned E2B
 * execution inputs. Raw artifacts are never retained in the digest payload.
 */
export function trustedArtifactDigest(input: TrustedArtifactDigestInput): string {
  const template = assertImmutableE2BTemplate(input.template);
  if (input.command.trim().length === 0) {
    throw new Error("MERGEPROOF_HARNESS_COMMAND must not be empty.");
  }
  const files = Object.entries(input.workspaceFiles)
    .map(([path, content]) => {
      if (!path.startsWith("/workspace/")) {
        throw new Error(`Trusted artifact path must stay below /workspace: ${path}`);
      }
      return { path, sha256: sha256Bytes(bytesFor(content)) };
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  if (files.length === 0) {
    throw new Error("At least one trusted E2B workspace artifact is required.");
  }
  return sha256(
    canonicalJson({
      schemaVersion: 1,
      template,
      command: input.command,
      files,
    }),
  );
}
