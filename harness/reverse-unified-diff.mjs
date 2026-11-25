import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

const maxDiffBytes = 1024 * 1024;
const maxFileBytes = 2 * 1024 * 1024;

function safePath(root, value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 500 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error("Ablation diff contains an unsafe path.");
  }
  const target = resolve(root, value);
  const fromRoot = relative(resolve(root), target);
  if (fromRoot.startsWith("..") || isAbsolute(fromRoot)) {
    throw new Error("Ablation diff escapes the extracted source tree.");
  }
  return target;
}

function assertDiffPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 500 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value.split("/").includes("..") ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error("Ablation diff contains an unsafe path.");
  }
  return value;
}

function parseCount(value) {
  if (value === undefined) return 1;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Ablation hunk count is invalid.");
  return parsed;
}

export function parseReverseAblationDiff(diff) {
  if (typeof diff !== "string" || Buffer.byteLength(diff, "utf8") > maxDiffBytes) {
    throw new Error("Ablation diff is missing or exceeds the trusted limit.");
  }
  const lines = diff.replaceAll("\r\n", "\n").split("\n");
  const files = [];
  let file;
  let hunk;
  const finishHunk = () => {
    if (!hunk) return;
    const oldCount = hunk.lines.filter(({ kind }) => kind !== "+").length;
    const newCount = hunk.lines.filter(({ kind }) => kind !== "-").length;
    if (oldCount !== hunk.oldCount || newCount !== hunk.newCount) {
      throw new Error("Ablation diff hunk body does not match its declared counts.");
    }
    hunk = undefined;
  };

  for (const line of lines) {
    const header = /^diff --git a\/([^\s]+) b\/([^\s]+)$/.exec(line);
    if (header) {
      finishHunk();
      if (header[1] !== header[2]) throw new Error("Ablation supports modified files only.");
      file = { path: assertDiffPath(header[2]), hunks: [] };
      files.push(file);
      continue;
    }
    if (!file) continue;
    if (/^(?:new file mode|deleted file mode|rename from|rename to|Binary files|GIT binary patch)/.test(line)) {
      throw new Error("Ablation supports text modifications only.");
    }
    if (line.startsWith("--- ") && line !== `--- a/${file.path}`) {
      throw new Error("Ablation old path does not match its diff header.");
    }
    if (line.startsWith("+++ ") && line !== `+++ b/${file.path}`) {
      throw new Error("Ablation new path does not match its diff header.");
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match) {
      finishHunk();
      hunk = {
        oldStart: Number(match[1]),
        oldCount: parseCount(match[2]),
        newStart: Number(match[3]),
        newCount: parseCount(match[4]),
        lines: [],
      };
      if (![hunk.oldStart, hunk.newStart].every((value) => Number.isSafeInteger(value) && value >= 0)) {
        throw new Error("Ablation hunk position is invalid.");
      }
      file.hunks.push(hunk);
      continue;
    }
    if (line === "\\ No newline at end of file") {
      throw new Error("Ablation refuses ambiguous newline-changing patches.");
    }
    if (hunk && /^[ +\-]/.test(line)) hunk.lines.push({ kind: line[0], text: line.slice(1) });
  }
  finishHunk();
  if (files.length === 0 || files.some((entry) => entry.hunks.length === 0)) {
    throw new Error("Ablation diff contains no reversible text hunks.");
  }
  return files;
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Ablation target is not valid UTF-8 text.");
  }
}

/** Reverse-applies a validated PR diff to an extracted candidate snapshot. */
export function applyReverseUnifiedDiff(sourceRoot, diff) {
  const files = parseReverseAblationDiff(diff);
  for (const file of files) {
    const target = safePath(sourceRoot, file.path);
    const bytes = readFileSync(target);
    if (bytes.byteLength > maxFileBytes) throw new Error("Ablation target exceeds the trusted file limit.");
    const text = decodeUtf8(bytes);
    const finalNewline = text.endsWith("\n");
    const candidateLines = text.split("\n");
    if (finalNewline) candidateLines.pop();

    for (const hunk of [...file.hunks].sort((left, right) => right.newStart - left.newStart)) {
      const offset = hunk.newStart === 0 ? 0 : hunk.newStart - 1;
      const expected = hunk.lines.filter(({ kind }) => kind !== "-").map(({ text: value }) => value);
      const replacement = hunk.lines.filter(({ kind }) => kind !== "+").map(({ text: value }) => value);
      const actual = candidateLines.slice(offset, offset + expected.length);
      if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
        throw new Error(`Ablation hunk does not match candidate source at ${file.path}:${hunk.newStart}.`);
      }
      candidateLines.splice(offset, expected.length, ...replacement);
    }
    writeFileSync(target, `${candidateLines.join("\n")}${finalNewline ? "\n" : ""}`, { flag: "w" });
  }
  return files.map(({ path }) => path).sort();
}
