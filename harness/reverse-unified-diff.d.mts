export interface ReverseAblationHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: Array<{ kind: " " | "+" | "-"; text: string }>;
}

export interface ReverseAblationFile {
  path: string;
  hunks: ReverseAblationHunk[];
}

export function parseReverseAblationDiff(diff: string): ReverseAblationFile[];
export function applyReverseUnifiedDiff(sourceRoot: string, diff: string): string[];
