import path from "node:path";

import ts from "typescript";

export interface RepositoryFile {
  path: string;
  content: string;
}

export interface ImpactMapperLimits {
  maxDiffBytes: number;
  maxFiles: number;
  maxFileBytes: number;
  maxTotalFileBytes: number;
  maxHunks: number;
  maxChangedLines: number;
  maxTraversalDepth: number;
  maxReportedPaths: number;
}

export interface ImpactMapperInput {
  diff: string;
  repositoryFiles: readonly RepositoryFile[];
  limits?: Partial<ImpactMapperLimits>;
}

export type DiffFileChange = "added" | "modified" | "deleted" | "renamed" | "binary";
export type FileClassification =
  | "source"
  | "test"
  | "configuration"
  | "documentation"
  | "generated"
  | "asset"
  | "unknown";
export type HunkClassification =
  | "import_surface"
  | "export_surface"
  | "declaration"
  | "control_flow"
  | "data_model"
  | "test"
  | "configuration"
  | "documentation"
  | "unknown";

export interface DiffLineChange {
  kind: "added" | "removed";
  line: number;
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
  classifications: HunkClassification[];
  changes: DiffLineChange[];
}

export interface DiffFileImpact {
  oldPath: string | null;
  newPath: string | null;
  change: DiffFileChange;
  classifications: FileClassification[];
  hunks: DiffHunk[];
}

export type ChangedSymbolKind =
  | "function"
  | "method"
  | "constructor"
  | "getter"
  | "setter"
  | "arrow_function"
  | "function_expression"
  | "module";

export interface SymbolReference {
  id: string;
  path: string;
  name: string;
  line: number;
}

export interface ChangedSymbolImpact extends SymbolReference {
  kind: ChangedSymbolKind;
  exported: boolean;
  defaultExport: boolean;
  startLine: number;
  endLine: number;
  changedLines: number[];
  changeKinds: HunkClassification[];
  importers: string[];
  callers: SymbolReference[];
}

export interface AffectedFile {
  path: string;
  reasons: string[];
}

export type WorkflowKind = "cli" | "server" | "worker" | "job" | "route" | "test" | "script" | "module";

export interface WorkflowEntrypoint extends SymbolReference {
  kind: WorkflowKind;
  reason: string;
  distance: number;
}

export type UnresolvedImpactKind =
  | "binary_change"
  | "computed_dispatch"
  | "deleted_source"
  | "dynamic_import"
  | "dynamic_require"
  | "eval"
  | "missing_changed_file"
  | "parse_error"
  | "reflection"
  | "traversal_limit"
  | "unsupported_source_language"
  | "unresolved_relative_import";

export interface UnresolvedImpactPath {
  kind: UnresolvedImpactKind;
  path: string;
  line: number;
  expression: string;
  reason: string;
}

export interface ImpactMapStats {
  repositoryFiles: number;
  repositoryBytes: number;
  diffFiles: number;
  hunks: number;
  changedLines: number;
  parsedSourceFiles: number;
  analyzedSymbols: number;
}

export interface ImpactMap {
  schemaVersion: 1;
  status: "complete" | "blocked";
  diffFiles: DiffFileImpact[];
  changedSymbols: ChangedSymbolImpact[];
  affectedFiles: AffectedFile[];
  workflows: WorkflowEntrypoint[];
  unresolvedPaths: UnresolvedImpactPath[];
  stats: ImpactMapStats;
}

export class ImpactMapperInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImpactMapperInputError";
  }
}

const defaultLimits: ImpactMapperLimits = {
  maxDiffBytes: 1_048_576,
  maxFiles: 5_000,
  maxFileBytes: 2_097_152,
  maxTotalFileBytes: 33_554_432,
  maxHunks: 5_000,
  maxChangedLines: 50_000,
  maxTraversalDepth: 12,
  maxReportedPaths: 1_000,
};

const typeScriptExtensions = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const pythonExtensions = new Set([".py", ".pyi"]);
const supportedSourceExtensions = new Set([...typeScriptExtensions, ...pythonExtensions]);
const unsupportedExecutableExtensions = new Set([
  ".c", ".cc", ".cpp", ".cs", ".go", ".h", ".hpp", ".java", ".kt", ".kts",
  ".php", ".rb", ".rs", ".scala", ".sh", ".bash", ".swift",
]);
const sourceExtensions = new Set([...supportedSourceExtensions, ...unsupportedExecutableExtensions]);
const generatedSegments = new Set(["dist", "build", "coverage", "generated", "vendor", "node_modules"]);

interface MutableDiffFile {
  oldPath: string | null;
  newPath: string | null;
  change: DiffFileChange;
  binary: boolean;
  hunks: MutableDiffHunk[];
}

interface MutableDiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  section: string;
  changes: DiffLineChange[];
}

interface InternalSymbol {
  id: string;
  path: string;
  name: string;
  simpleName: string;
  className: string | null;
  kind: ChangedSymbolKind;
  exported: boolean;
  defaultExport: boolean;
  startLine: number;
  endLine: number;
}

interface ParsedRepositorySource {
  path: string;
  sourceFile: ts.SourceFile;
  symbols: InternalSymbol[];
}

interface ParsedPythonSource {
  path: string;
  content: string;
  codeLines: string[];
  lineCount: number;
  symbols: InternalSymbol[];
}

interface ImportedBinding {
  targetPath: string;
  importedName: string;
  namespace: boolean;
}

interface CallEdge {
  caller: SymbolReference;
  calleeId: string;
}

function effectiveLimits(overrides: Partial<ImpactMapperLimits> | undefined): ImpactMapperLimits {
  const limits = { ...defaultLimits, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ImpactMapperInputError(`Impact mapper limit ${name} must be a positive safe integer.`);
    }
  }
  return limits;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizedRepositoryPath(value: string): string {
  const slashPath = value.replaceAll("\\", "/");
  if (slashPath.length === 0 || slashPath.startsWith("/") || /^[A-Za-z]:\//.test(slashPath)) {
    throw new ImpactMapperInputError(`Repository path must be relative: ${JSON.stringify(value)}.`);
  }
  const normalized = path.posix.normalize(slashPath).replace(/^\.\//, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new ImpactMapperInputError(`Repository path escapes the repository: ${JSON.stringify(value)}.`);
  }
  return normalized;
}

function decodeGitQuotedPath(token: string): string {
  if (!token.startsWith("\"") || !token.endsWith("\"")) return token;
  const value = token.slice(1, -1);
  let decoded = "";
  let bytes: number[] = [];
  const flushBytes = (): void => {
    if (bytes.length > 0) {
      decoded += Buffer.from(bytes).toString("utf8");
      bytes = [];
    }
  };
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      flushBytes();
      decoded += character ?? "";
      continue;
    }
    const escaped = value[index + 1];
    if (escaped === undefined) {
      flushBytes();
      decoded += "\\";
      continue;
    }
    const octal = /^[0-7]$/.test(escaped)
      ? /^([0-7]{1,3})/.exec(value.slice(index + 1))?.[1]
      : undefined;
    if (octal) {
      bytes.push(Number.parseInt(octal, 8));
      index += octal.length;
      continue;
    }
    flushBytes();
    const escapes: Readonly<Record<string, string>> = {
      "\\": "\\",
      "\"": "\"",
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      v: "\v",
    };
    decoded += escapes[escaped] ?? escaped;
    index += 1;
  }
  flushBytes();
  return decoded;
}

function stripGitPrefix(value: string): string {
  return value.startsWith("a/") || value.startsWith("b/") ? value.slice(2) : value;
}

function parseDiffGitHeader(line: string): [string, string] | null {
  const match = /^diff --git ("(?:\\.|[^"])*"|\S+) ("(?:\\.|[^"])*"|\S+)$/.exec(line);
  if (!match?.[1] || !match[2]) return null;
  return [stripGitPrefix(decodeGitQuotedPath(match[1])), stripGitPrefix(decodeGitQuotedPath(match[2]))];
}

function parseMarkerPath(line: string): string | null {
  const raw = line.slice(4).split("\t", 1)[0] ?? "";
  if (raw === "/dev/null") return null;
  return stripGitPrefix(decodeGitQuotedPath(raw));
}

function fileClassifications(filePath: string): FileClassification[] {
  const lower = filePath.toLowerCase();
  const extension = path.posix.extname(lower);
  const segments = lower.split("/");
  const classes = new Set<FileClassification>();
  if (segments.some((segment) => generatedSegments.has(segment))) classes.add("generated");
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(lower) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(lower)) {
    classes.add("test");
  }
  if (sourceExtensions.has(extension)) classes.add("source");
  if (/\.(?:json|ya?ml|toml|ini|env|config)$/.test(lower) || /(^|\/)(?:package-lock\.json|package\.json|tsconfig[^/]*\.json)$/.test(lower)) {
    classes.add("configuration");
  }
  if (/\.(?:md|mdx|rst|txt|adoc)$/.test(lower) || /(^|\/)docs?(\/|$)/.test(lower)) classes.add("documentation");
  if (/\.(?:png|jpe?g|gif|webp|svg|ico|mp3|mp4|mov|pdf|woff2?|ttf)$/.test(lower)) classes.add("asset");
  if (classes.size === 0) classes.add("unknown");
  return [...classes].sort();
}

function hunkClassifications(filePath: string, hunk: MutableDiffHunk): HunkClassification[] {
  const text = hunk.changes.map((change) => change.content).join("\n");
  const fileClasses = fileClassifications(filePath);
  const classes = new Set<HunkClassification>();
  if (fileClasses.includes("test")) classes.add("test");
  if (fileClasses.includes("configuration")) classes.add("configuration");
  if (fileClasses.includes("documentation")) classes.add("documentation");
  if (/\b(?:import|export)\b|\brequire\s*\(|\bmodule\.exports\b/.test(text)) classes.add("import_surface");
  if (/\bexport\b|\bmodule\.exports\b|\bexports\./.test(text)) classes.add("export_surface");
  if (/\b(?:function|def|class|interface|type|enum|const|let|var)\b|=>/.test(text)) classes.add("declaration");
  if (/\b(?:if|else|switch|case|for|while|catch|throw|return|await|Promise\.(?:all|race))\b|&&|\|\||\?\?/.test(text)) {
    classes.add("control_flow");
  }
  if (/\b(?:interface|type|enum|schema|migration|CREATE\s+TABLE|ALTER\s+TABLE)\b/i.test(text)) classes.add("data_model");
  if (classes.size === 0) classes.add("unknown");
  return [...classes].sort();
}

export function parseUnifiedDiff(
  diff: string,
  limitOverrides?: Partial<ImpactMapperLimits>,
): DiffFileImpact[] {
  const limits = effectiveLimits(limitOverrides);
  if (byteLength(diff) > limits.maxDiffBytes) {
    throw new ImpactMapperInputError(`Unified diff exceeds ${limits.maxDiffBytes} bytes.`);
  }
  const lines = diff.replaceAll("\r\n", "\n").split("\n");
  const files: MutableDiffFile[] = [];
  let currentFile: MutableDiffFile | undefined;
  let currentHunk: MutableDiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  let hunkCount = 0;
  let changedLineCount = 0;
  const assertHunkComplete = (): void => {
    if (!currentHunk) return;
    const expectedOldEnd = currentHunk.oldStart + currentHunk.oldCount;
    const expectedNewEnd = currentHunk.newStart + currentHunk.newCount;
    if (oldLine !== expectedOldEnd || newLine !== expectedNewEnd) {
      throw new ImpactMapperInputError(
        `Malformed unified diff hunk at -${currentHunk.oldStart},+${currentHunk.newStart}: declared line counts do not match its body.`,
      );
    }
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    const header = parseDiffGitHeader(line);
    if (header) {
      assertHunkComplete();
      currentFile = {
        oldPath: normalizedRepositoryPath(header[0]),
        newPath: normalizedRepositoryPath(header[1]),
        change: "modified",
        binary: false,
        hunks: [],
      };
      files.push(currentFile);
      if (files.length > limits.maxFiles) {
        throw new ImpactMapperInputError(`Unified diff exceeds ${limits.maxFiles} files.`);
      }
      currentHunk = undefined;
      continue;
    }
    const previousHunkComplete = currentHunk !== undefined
      && oldLine >= currentHunk.oldStart + currentHunk.oldCount
      && newLine >= currentHunk.newStart + currentHunk.newCount;
    if (
      line.startsWith("--- ")
      && (lines[lineIndex + 1] ?? "").startsWith("+++ ")
      && (!currentFile || previousHunkComplete)
    ) {
      assertHunkComplete();
      currentFile = {
        oldPath: parseMarkerPath(line),
        newPath: null,
        change: parseMarkerPath(line) === null ? "added" : "modified",
        binary: false,
        hunks: [],
      };
      files.push(currentFile);
      if (files.length > limits.maxFiles) {
        throw new ImpactMapperInputError(`Unified diff exceeds ${limits.maxFiles} files.`);
      }
      currentHunk = undefined;
    }
    if (!currentFile) continue;
    if (line.startsWith("new file mode ")) currentFile.change = "added";
    if (line.startsWith("deleted file mode ")) currentFile.change = "deleted";
    if (line.startsWith("rename from ")) {
      currentFile.oldPath = normalizedRepositoryPath(decodeGitQuotedPath(line.slice(12)));
      currentFile.change = "renamed";
    }
    if (line.startsWith("rename to ")) {
      currentFile.newPath = normalizedRepositoryPath(decodeGitQuotedPath(line.slice(10)));
      currentFile.change = "renamed";
    }
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      currentFile.binary = true;
      currentFile.change = "binary";
    }
    if (line.startsWith("--- ")) {
      currentFile.oldPath = parseMarkerPath(line);
      if (currentFile.oldPath === null) currentFile.change = "added";
      continue;
    }
    if (line.startsWith("+++ ")) {
      currentFile.newPath = parseMarkerPath(line);
      if (currentFile.newPath === null) currentFile.change = "deleted";
      else if (currentFile.oldPath === null) currentFile.change = "added";
      continue;
    }
    const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:\s?(.*))?$/.exec(line);
    if (hunkHeader) {
      assertHunkComplete();
      const oldStart = Number(hunkHeader[1]);
      const oldCount = hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]);
      const newStart = Number(hunkHeader[3]);
      const newCount = hunkHeader[4] === undefined ? 1 : Number(hunkHeader[4]);
      if (![oldStart, oldCount, newStart, newCount].every(Number.isSafeInteger)) {
        throw new ImpactMapperInputError("Unified diff hunk contains an unsafe line number.");
      }
      currentHunk = {
        oldStart,
        oldCount,
        newStart,
        newCount,
        section: hunkHeader[5] ?? "",
        changes: [],
      };
      currentFile.hunks.push(currentHunk);
      hunkCount += 1;
      if (hunkCount > limits.maxHunks) throw new ImpactMapperInputError(`Unified diff exceeds ${limits.maxHunks} hunks.`);
      oldLine = oldStart;
      newLine = newStart;
      continue;
    }
    if (!currentHunk || line === "\\ No newline at end of file") continue;
    if (line.startsWith("+")) {
      currentHunk.changes.push({ kind: "added", line: newLine, content: line.slice(1) });
      newLine += 1;
      changedLineCount += 1;
    } else if (line.startsWith("-")) {
      currentHunk.changes.push({ kind: "removed", line: oldLine, content: line.slice(1) });
      oldLine += 1;
      changedLineCount += 1;
    } else if (line.startsWith(" ")) {
      oldLine += 1;
      newLine += 1;
    }
    if (changedLineCount > limits.maxChangedLines) {
      throw new ImpactMapperInputError(`Unified diff exceeds ${limits.maxChangedLines} changed lines.`);
    }
  }
  assertHunkComplete();
  if (diff.trim().length > 0 && files.length === 0) {
    throw new ImpactMapperInputError("Input does not contain a recognizable unified diff file header.");
  }

  return files.map((file) => {
    const effectivePath = file.newPath ?? file.oldPath;
    return {
      oldPath: file.oldPath,
      newPath: file.newPath,
      change: file.binary ? "binary" : file.change,
      classifications: fileClassifications(effectivePath ?? "unknown"),
      hunks: file.hunks.map((hunk) => ({
        ...hunk,
        classifications: hunkClassifications(effectivePath ?? "unknown", hunk),
      })),
    };
  });
}

function scriptKind(filePath: string): ts.ScriptKind {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if ([".js", ".mjs", ".cjs"].includes(extension)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some((modifier) => modifier.kind === kind) ?? false;
}

function nearestClassName(node: ts.Node): string | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if ((ts.isClassDeclaration(current) || ts.isClassExpression(current)) && current.name) return current.name.text;
    current = current.parent;
  }
  return null;
}

function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name) && (ts.isStringLiteral(name.expression) || ts.isNumericLiteral(name.expression))) {
    return name.expression.text;
  }
  return null;
}

function declarationName(node: ts.FunctionExpression | ts.ArrowFunction): string | null {
  if (ts.isFunctionExpression(node) && node.name) return node.name.text;
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) return propertyNameText(parent.name);
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (ts.isIdentifier(parent.left)) return parent.left.text;
    if (ts.isPropertyAccessExpression(parent.left)) return parent.left.name.text;
  }
  return null;
}

function exportState(node: ts.Node): { exported: boolean; defaultExport: boolean } {
  let current: ts.Node | undefined = node;
  while (current && !ts.isSourceFile(current)) {
    if (hasModifier(current, ts.SyntaxKind.ExportKeyword)) {
      return { exported: true, defaultExport: hasModifier(current, ts.SyntaxKind.DefaultKeyword) };
    }
    if (ts.isVariableDeclaration(current) && ts.isVariableStatement(current.parent.parent)) {
      const statement = current.parent.parent;
      if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
        return { exported: true, defaultExport: hasModifier(statement, ts.SyntaxKind.DefaultKeyword) };
      }
    }
    current = current.parent;
  }
  return { exported: false, defaultExport: false };
}

function symbolDescriptor(node: ts.Node, sourceFile: ts.SourceFile, filePath: string): InternalSymbol | null {
  let name: string | null = null;
  let kind: ChangedSymbolKind | null = null;
  if (ts.isFunctionDeclaration(node)) {
    name = node.name?.text ?? (hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default" : null);
    kind = "function";
  } else if (ts.isMethodDeclaration(node)) {
    name = propertyNameText(node.name);
    kind = "method";
  } else if (ts.isConstructorDeclaration(node)) {
    name = "constructor";
    kind = "constructor";
  } else if (ts.isGetAccessorDeclaration(node)) {
    name = propertyNameText(node.name);
    kind = "getter";
  } else if (ts.isSetAccessorDeclaration(node)) {
    name = propertyNameText(node.name);
    kind = "setter";
  } else if (ts.isArrowFunction(node)) {
    name = declarationName(node);
    kind = "arrow_function";
  } else if (ts.isFunctionExpression(node)) {
    name = declarationName(node);
    kind = "function_expression";
  }
  if (!name || !kind) return null;
  const className = nearestClassName(node);
  const qualifiedName = className ? `${className}.${name}` : name;
  const startLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const endLine = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  const state = exportState(node);
  const id = `${filePath}#${qualifiedName}@${startLine}`;
  return {
    id,
    path: filePath,
    name: qualifiedName,
    simpleName: name,
    className,
    kind,
    exported: state.exported,
    defaultExport: state.defaultExport,
    startLine,
    endLine,
  };
}

function collectSymbols(sourceFile: ts.SourceFile, filePath: string): InternalSymbol[] {
  const symbols: InternalSymbol[] = [];
  const visit = (node: ts.Node): void => {
    const descriptor = symbolDescriptor(node, sourceFile, filePath);
    if (descriptor) symbols.push(descriptor);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return symbols.sort((left, right) => left.startLine - right.startLine || left.id.localeCompare(right.id));
}

function boundedText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 200);
}

function sourceReference(symbol: InternalSymbol | undefined, filePath: string, line: number): SymbolReference {
  return symbol
    ? { id: symbol.id, path: symbol.path, name: symbol.name, line }
    : { id: `${filePath}#<module>`, path: filePath, name: "<module>", line };
}

function containingSymbol(symbols: readonly InternalSymbol[], line: number): InternalSymbol | undefined {
  return symbols
    .filter((symbol) => symbol.startLine <= line && symbol.endLine >= line)
    .sort((left, right) => (left.endLine - left.startLine) - (right.endLine - right.startLine) || left.id.localeCompare(right.id))[0];
}

function sourceFileLine(sourceFile: ts.SourceFile, node: ts.Node): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

function moduleCandidates(fromPath: string, specifier: string): string[] {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  const extension = path.posix.extname(base);
  const candidates = new Set<string>([base]);
  if (!extension) {
    for (const suffix of typeScriptExtensions) candidates.add(`${base}${suffix}`);
    for (const suffix of typeScriptExtensions) candidates.add(`${base}/index${suffix}`);
  } else if ([".js", ".jsx", ".mjs", ".cjs"].includes(extension)) {
    const stem = base.slice(0, -extension.length);
    for (const suffix of [".ts", ".tsx", ".mts", ".cts"]) candidates.add(`${stem}${suffix}`);
  }
  return [...candidates];
}

function resolveModule(fromPath: string, specifier: string, files: ReadonlyMap<string, string>): string | null {
  if (!specifier.startsWith(".")) return null;
  for (const candidate of moduleCandidates(fromPath, specifier)) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function importedTargetSymbols(
  binding: ImportedBinding,
  property: string | null,
  symbolsByFile: ReadonlyMap<string, InternalSymbol[]>,
): InternalSymbol[] {
  const symbols = symbolsByFile.get(binding.targetPath) ?? [];
  const targetName = property ?? binding.importedName;
  if (targetName === "default") {
    return symbols.filter((symbol) => symbol.defaultExport || (symbol.exported && symbol.simpleName === "default"));
  }
  const candidates = symbols.filter((symbol) => symbol.simpleName === targetName && (symbol.exported || symbol.className !== null));
  if (property && !binding.namespace && binding.importedName !== "default") {
    const classMembers = candidates.filter((symbol) => symbol.className === binding.importedName);
    if (classMembers.length > 0) return classMembers;
  }
  return candidates;
}

interface PythonParseIssue {
  line: number;
  expression: string;
  reason: string;
}

interface ParsedPythonResult {
  source: ParsedPythonSource;
  issues: PythonParseIssue[];
}

function maskPythonStringsAndComments(content: string): { codeLines: string[]; issues: PythonParseIssue[] } {
  const codeLines: string[] = [];
  const issues: PythonParseIssue[] = [];
  let tripleQuote: "'''" | "\"\"\"" | null = null;
  for (const [lineIndex, rawLine] of content.split("\n").entries()) {
    const characters = [...rawLine];
    let index = 0;
    while (index < characters.length) {
      if (tripleQuote) {
        const rest = characters.slice(index).join("");
        const closingOffset = rest.indexOf(tripleQuote);
        if (closingOffset < 0) {
          for (let cursor = index; cursor < characters.length; cursor += 1) characters[cursor] = " ";
          index = characters.length;
          continue;
        }
        const closingEnd = index + closingOffset + tripleQuote.length;
        for (let cursor = index; cursor < closingEnd; cursor += 1) characters[cursor] = " ";
        index = closingEnd;
        tripleQuote = null;
        continue;
      }
      if (characters[index] === "#") {
        for (let cursor = index; cursor < characters.length; cursor += 1) characters[cursor] = " ";
        break;
      }
      const rest = characters.slice(index).join("");
      const openingTriple = rest.startsWith("'''") ? "'''" : rest.startsWith("\"\"\"") ? "\"\"\"" : null;
      if (openingTriple) {
        for (let cursor = index; cursor < index + openingTriple.length; cursor += 1) characters[cursor] = " ";
        index += openingTriple.length;
        tripleQuote = openingTriple;
        continue;
      }
      const quote = characters[index];
      if (quote !== "'" && quote !== "\"") {
        index += 1;
        continue;
      }
      characters[index] = " ";
      index += 1;
      let closed = false;
      while (index < characters.length) {
        const character = characters[index];
        characters[index] = " ";
        if (character === "\\") {
          index += 1;
          if (index < characters.length) characters[index] = " ";
        } else if (character === quote) {
          closed = true;
          index += 1;
          break;
        }
        index += 1;
      }
      if (!closed && !rawLine.endsWith("\\")) {
        issues.push({
          line: lineIndex + 1,
          expression: rawLine.trim().slice(0, 200),
          reason: "An unterminated Python string prevents conservative static analysis.",
        });
      }
    }
    codeLines.push(characters.join(""));
  }
  if (tripleQuote) {
    issues.push({
      line: Math.max(1, codeLines.length),
      expression: tripleQuote,
      reason: "An unterminated Python triple-quoted string prevents conservative static analysis.",
    });
  }
  return { codeLines, issues };
}

function leadingPythonIndent(line: string): number {
  return /^ */.exec(line)?.[0].length ?? 0;
}

function pythonDeclarationHeaderEnd(lines: readonly string[], startIndex: number): number | null {
  let parentheses = 0;
  let brackets = 0;
  let braces = 0;
  for (let lineIndex = startIndex; lineIndex < Math.min(lines.length, startIndex + 50); lineIndex += 1) {
    const line = lines[lineIndex] ?? "";
    for (const character of line) {
      if (character === "(") parentheses += 1;
      else if (character === ")") parentheses -= 1;
      else if (character === "[") brackets += 1;
      else if (character === "]") brackets -= 1;
      else if (character === "{") braces += 1;
      else if (character === "}") braces -= 1;
      if (parentheses < 0 || brackets < 0 || braces < 0) return null;
    }
    if (parentheses === 0 && brackets === 0 && braces === 0 && line.trimEnd().endsWith(":")) {
      return lineIndex;
    }
  }
  return null;
}

function parsePythonSource(filePath: string, content: string): ParsedPythonResult {
  const masked = maskPythonStringsAndComments(content);
  const issues = [...masked.issues];
  const declarations: Array<{
    type: "class" | "function";
    name: string;
    indent: number;
    startLine: number;
    endLine: number;
  }> = [];
  for (const [lineIndex, line] of masked.codeLines.entries()) {
    if (/^\s*\t/.test(line)) {
      issues.push({
        line: lineIndex + 1,
        expression: line.trim().slice(0, 200),
        reason: "Tab-indented Python cannot be mapped safely by the conservative indentation parser.",
      });
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const functionStart = /^( *)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/.exec(line);
    const classStart = /^( *)class\s+([A-Za-z_]\w*)\b/.exec(line);
    const functionMatch = functionStart && pythonDeclarationHeaderEnd(masked.codeLines, lineIndex) !== null
      ? functionStart
      : null;
    const classMatch = classStart && pythonDeclarationHeaderEnd(masked.codeLines, lineIndex) !== null
      ? classStart
      : null;
    if (functionMatch?.[2]) {
      declarations.push({
        type: "function",
        name: functionMatch[2],
        indent: functionMatch[1]?.length ?? 0,
        startLine: lineIndex + 1,
        endLine: masked.codeLines.length,
      });
    } else if (classMatch?.[2]) {
      declarations.push({
        type: "class",
        name: classMatch[2],
        indent: classMatch[1]?.length ?? 0,
        startLine: lineIndex + 1,
        endLine: masked.codeLines.length,
      });
    } else if (/^(?:async\s+)?def\b|^class\b/.test(trimmed)) {
      issues.push({
        line: lineIndex + 1,
        expression: trimmed.slice(0, 200),
        reason: "A multiline or malformed Python declaration cannot be mapped conservatively.",
      });
    }
    if (/^(?:from|import)\b/.test(trimmed) && (trimmed.endsWith("\\") || /\bimport\s*\(/.test(trimmed))) {
      issues.push({
        line: lineIndex + 1,
        expression: trimmed.slice(0, 200),
        reason: "A multiline Python import cannot be resolved by the conservative dependency parser.",
      });
    }
  }
  for (const declaration of declarations) {
    for (let lineIndex = declaration.startLine; lineIndex < masked.codeLines.length; lineIndex += 1) {
      const line = masked.codeLines[lineIndex] ?? "";
      if (line.trim().length === 0) continue;
      if (leadingPythonIndent(line) <= declaration.indent) {
        declaration.endLine = lineIndex;
        break;
      }
    }
  }
  const classes = declarations.filter((declaration) => declaration.type === "class");
  const symbols: InternalSymbol[] = declarations
    .filter((declaration) => declaration.type === "function")
    .map((declaration): InternalSymbol => {
      const containingClass = classes
        .filter((candidate) =>
          candidate.startLine < declaration.startLine
          && candidate.endLine >= declaration.endLine
          && candidate.indent < declaration.indent)
        .sort((left, right) => right.indent - left.indent || right.startLine - left.startLine)[0];
      const className = containingClass?.name ?? null;
      const qualifiedName = className ? `${className}.${declaration.name}` : declaration.name;
      return {
        id: `${filePath}#${qualifiedName}@${declaration.startLine}`,
        path: filePath,
        name: qualifiedName,
        simpleName: declaration.name,
        className,
        kind: className ? "method" : "function",
        exported: !declaration.name.startsWith("_"),
        defaultExport: false,
        startLine: declaration.startLine,
        endLine: Math.max(declaration.startLine, declaration.endLine),
      };
    })
    .sort((left, right) => left.startLine - right.startLine || left.id.localeCompare(right.id));
  return {
    source: {
      path: filePath,
      content,
      codeLines: masked.codeLines,
      lineCount: Math.max(1, masked.codeLines.length),
      symbols,
    },
    issues,
  };
}

function pythonModuleCandidates(fromPath: string, moduleName: string): string[] {
  const relativeMatch = /^(\.*)([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)?$/.exec(moduleName);
  if (!relativeMatch) return [];
  const dots = relativeMatch[1]?.length ?? 0;
  const modulePath = (relativeMatch[2] ?? "").replaceAll(".", "/");
  const roots: string[] = [];
  if (dots > 0) {
    let packageRoot = path.posix.dirname(fromPath);
    for (let level = 1; level < dots; level += 1) packageRoot = path.posix.dirname(packageRoot);
    roots.push(path.posix.join(packageRoot, modulePath));
  } else {
    roots.push(modulePath);
    roots.push(path.posix.join(path.posix.dirname(fromPath), modulePath));
  }
  const candidates = new Set<string>();
  for (const root of roots.filter((value) => value.length > 0 && value !== ".")) {
    candidates.add(`${root}.py`);
    candidates.add(`${root}.pyi`);
    candidates.add(`${root}/__init__.py`);
    candidates.add(`${root}/__init__.pyi`);
  }
  return [...candidates];
}

function resolvePythonModule(
  fromPath: string,
  moduleName: string,
  files: ReadonlyMap<string, string>,
): string | null {
  for (const candidate of pythonModuleCandidates(fromPath, moduleName)) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function isRepositoryLocalPythonModule(moduleName: string, files: ReadonlyMap<string, string>): boolean {
  if (moduleName.startsWith(".")) return true;
  const root = moduleName.split(".")[0];
  if (!root) return false;
  return [...files.keys()].some((filePath) =>
    pythonExtensions.has(path.posix.extname(filePath).toLowerCase())
    && (filePath === `${root}.py` || filePath === `${root}.pyi` || filePath.startsWith(`${root}/`)));
}

function workflowKind(filePath: string, symbolName: string): WorkflowKind | null {
  const lowerPath = filePath.toLowerCase();
  const lowerName = symbolName.toLowerCase().replaceAll("_", "");
  if (/(^|\/)(?:test|tests|__tests__|spec)(\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.pyi?$|_test\.pyi?$/.test(lowerPath)) return "test";
  if (/(^|\/)(?:bin|cli)(\/|$)/.test(lowerPath) || /(?:^|\.)(?:cli|command)$/.test(lowerName)) return "cli";
  if (/(?:^|\/)(?:app|server|serve|main|index)(?:\.[cm]?[jt]sx?|\.pyi?)$/.test(lowerPath) || /(?:^|\.)(?:serve|server|start|main)$/.test(lowerName)) return "server";
  if (/(^|\/)(?:workers?|consumers?)(\/|$)/.test(lowerPath) || /(?:^|\.)(?:worker|consume|processmessage)$/.test(lowerName)) return "worker";
  if (/(^|\/)(?:jobs?|queues?)(\/|$)/.test(lowerPath) || /(?:^|\.)(?:job|runjob|processjob|enqueue)$/.test(lowerName)) return "job";
  if (/(^|\/)(?:routes?|handlers?|controllers?)(\/|$)/.test(lowerPath) || /(?:^|\.)(?:handler|handle|route|controller)$/.test(lowerName)) return "route";
  if (/(^|\/)scripts?(\/|$)/.test(lowerPath)) return "script";
  return null;
}

function sortUnresolved(paths: Iterable<UnresolvedImpactPath>): UnresolvedImpactPath[] {
  return [...paths].sort((left, right) =>
    left.path.localeCompare(right.path)
      || left.line - right.line
      || left.kind.localeCompare(right.kind)
      || left.expression.localeCompare(right.expression));
}

function unresolvedKey(item: UnresolvedImpactPath): string {
  return `${item.path}\u0000${item.line}\u0000${item.kind}\u0000${item.expression}`;
}

function addUnresolved(
  items: Map<string, UnresolvedImpactPath>,
  item: UnresolvedImpactPath,
  limits: ImpactMapperLimits,
): void {
  items.set(unresolvedKey(item), item);
  if (items.size > limits.maxReportedPaths) {
    throw new ImpactMapperInputError(`Impact analysis exceeds ${limits.maxReportedPaths} unresolved paths.`);
  }
}

export function mapImpact(input: ImpactMapperInput): ImpactMap {
  const limits = effectiveLimits(input.limits);
  const diffFiles = parseUnifiedDiff(input.diff, limits);
  if (input.repositoryFiles.length > limits.maxFiles) {
    throw new ImpactMapperInputError(`Repository snapshot exceeds ${limits.maxFiles} files.`);
  }
  const repositoryFiles = new Map<string, string>();
  let repositoryBytes = 0;
  for (const file of input.repositoryFiles) {
    const filePath = normalizedRepositoryPath(file.path);
    if (repositoryFiles.has(filePath)) throw new ImpactMapperInputError(`Duplicate repository file: ${filePath}.`);
    const size = byteLength(file.content);
    if (size > limits.maxFileBytes) throw new ImpactMapperInputError(`Repository file ${filePath} exceeds ${limits.maxFileBytes} bytes.`);
    repositoryBytes += size;
    if (repositoryBytes > limits.maxTotalFileBytes) {
      throw new ImpactMapperInputError(`Repository snapshot exceeds ${limits.maxTotalFileBytes} bytes.`);
    }
    repositoryFiles.set(filePath, file.content);
  }

  const unresolved = new Map<string, UnresolvedImpactPath>();
  const parsedSources = new Map<string, ParsedRepositorySource>();
  const parsedPythonSources = new Map<string, ParsedPythonSource>();
  const symbolsByFile = new Map<string, InternalSymbol[]>();
  for (const [filePath, content] of [...repositoryFiles.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const extension = path.posix.extname(filePath).toLowerCase();
    if (pythonExtensions.has(extension)) {
      const parsed = parsePythonSource(filePath, content);
      parsedPythonSources.set(filePath, parsed.source);
      symbolsByFile.set(filePath, parsed.source.symbols);
      for (const issue of parsed.issues) {
        addUnresolved(unresolved, {
          kind: "parse_error",
          path: filePath,
          line: issue.line,
          expression: issue.expression,
          reason: issue.reason,
        }, limits);
      }
      continue;
    }
    if (!typeScriptExtensions.has(extension)) continue;
    const sourceFile = ts.createSourceFile(filePath, content, ts.ScriptTarget.Latest, true, scriptKind(filePath));
    const symbols = collectSymbols(sourceFile, filePath);
    parsedSources.set(filePath, { path: filePath, sourceFile, symbols });
    symbolsByFile.set(filePath, symbols);
    const diagnostics = (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? [];
    for (const diagnostic of diagnostics) {
      const position = diagnostic.start ?? 0;
      const line = sourceFile.getLineAndCharacterOfPosition(position).line + 1;
      addUnresolved(unresolved, {
        kind: "parse_error",
        path: filePath,
        line,
        expression: ts.flattenDiagnosticMessageText(diagnostic.messageText, " ").slice(0, 200),
        reason: "The source snapshot could not be parsed completely, so its impact graph is incomplete.",
      }, limits);
    }
  }

  const changedSymbolData = new Map<string, {
    symbol: InternalSymbol;
    changedLines: Set<number>;
    changeKinds: Set<HunkClassification>;
  }>();
  const changedModuleData = new Map<string, { changedLines: Set<number>; changeKinds: Set<HunkClassification> }>();
  const changedPaths = new Set<string>();

  for (const diffFile of diffFiles) {
    const effectivePath = diffFile.newPath ?? diffFile.oldPath;
    if (!effectivePath) continue;
    changedPaths.add(effectivePath);
    if (diffFile.change === "binary") {
      addUnresolved(unresolved, {
        kind: "binary_change",
        path: effectivePath,
        line: 0,
        expression: "binary diff",
        reason: "Binary changes cannot be mapped to executable symbols.",
      }, limits);
      continue;
    }
    const isSource = diffFile.classifications.includes("source");
    if (diffFile.change === "deleted" && isSource) {
      addUnresolved(unresolved, {
        kind: "deleted_source",
        path: effectivePath,
        line: 0,
        expression: "deleted source file",
        reason: "The candidate snapshot cannot recover deleted symbol bodies from a partial unified diff.",
      }, limits);
      continue;
    }
    if (!isSource) continue;
    const extension = path.posix.extname(effectivePath).toLowerCase();
    if (unsupportedExecutableExtensions.has(extension)) {
      addUnresolved(unresolved, {
        kind: "unsupported_source_language",
        path: effectivePath,
        line: 0,
        expression: extension,
        reason: "The changed executable language has no conservative impact mapper and cannot be skipped safely.",
      }, limits);
      continue;
    }
    const parsed = parsedSources.get(effectivePath);
    const parsedPython = parsedPythonSources.get(effectivePath);
    if (!parsed && !parsedPython) {
      addUnresolved(unresolved, {
        kind: "missing_changed_file",
        path: effectivePath,
        line: 0,
        expression: "missing repository snapshot",
        reason: "A changed source file was not supplied by the controller.",
      }, limits);
      continue;
    }
    const sourceLineCount = parsed
      ? parsed.sourceFile.getLineAndCharacterOfPosition(parsed.sourceFile.getEnd()).line + 1
      : parsedPython?.lineCount ?? 1;
    const symbols = parsed?.symbols ?? parsedPython?.symbols ?? [];
    for (const hunk of diffFile.hunks) {
      const addedLines = hunk.changes.filter((change) => change.kind === "added").map((change) => change.line);
      const linesToMap = addedLines.length > 0
        ? addedLines
        : hunk.changes.some((change) => change.kind === "removed")
          ? [Math.max(1, Math.min(hunk.newStart, sourceLineCount))]
          : [];
      for (const changedLine of linesToMap) {
        let symbol = containingSymbol(symbols, changedLine);
        if (!symbol && hunk.section) {
          const sectionMatches = symbols.filter((candidate) => hunk.section.includes(candidate.simpleName));
          if (sectionMatches.length === 1) symbol = sectionMatches[0];
        }
        if (symbol) {
          const entry = changedSymbolData.get(symbol.id) ?? {
            symbol,
            changedLines: new Set<number>(),
            changeKinds: new Set<HunkClassification>(),
          };
          entry.changedLines.add(changedLine);
          for (const classification of hunk.classifications) entry.changeKinds.add(classification);
          changedSymbolData.set(symbol.id, entry);
        } else {
          const entry = changedModuleData.get(effectivePath) ?? {
            changedLines: new Set<number>(),
            changeKinds: new Set<HunkClassification>(),
          };
          entry.changedLines.add(changedLine);
          for (const classification of hunk.classifications) entry.changeKinds.add(classification);
          changedModuleData.set(effectivePath, entry);
        }
      }
    }
  }

  const importers = new Map<string, Set<string>>();
  const importedBindingsByFile = new Map<string, Map<string, ImportedBinding>>();
  const callEdges: CallEdge[] = [];

  for (const parsed of parsedSources.values()) {
    const bindings = new Map<string, ImportedBinding>();
    const instanceBindings = new Map<string, ImportedBinding>();
    const recordDependency = (specifier: string, node: ts.Node): string | null => {
      const targetPath = resolveModule(parsed.path, specifier, repositoryFiles);
      if (specifier.startsWith(".") && !targetPath) {
        addUnresolved(unresolved, {
          kind: "unresolved_relative_import",
          path: parsed.path,
          line: sourceFileLine(parsed.sourceFile, node),
          expression: specifier.slice(0, 200),
          reason: "A relative module dependency was absent from the controller-provided snapshot.",
        }, limits);
      }
      if (targetPath) {
        const sources = importers.get(targetPath) ?? new Set<string>();
        sources.add(parsed.path);
        importers.set(targetPath, sources);
      }
      return targetPath;
    };

    const collectImports = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
        const targetPath = recordDependency(node.moduleSpecifier.text, node.moduleSpecifier);
        if (targetPath && node.importClause) {
          if (node.importClause.name) bindings.set(node.importClause.name.text, { targetPath, importedName: "default", namespace: false });
          const namedBindings = node.importClause.namedBindings;
          if (namedBindings && ts.isNamespaceImport(namedBindings)) {
            bindings.set(namedBindings.name.text, { targetPath, importedName: "*", namespace: true });
          } else if (namedBindings) {
            for (const element of namedBindings.elements) {
              bindings.set(element.name.text, {
                targetPath,
                importedName: element.propertyName?.text ?? element.name.text,
                namespace: false,
              });
            }
          }
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        recordDependency(node.moduleSpecifier.text, node.moduleSpecifier);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const expression = node.moduleReference.expression;
        if (expression && ts.isStringLiteral(expression)) {
          const targetPath = recordDependency(expression.text, expression);
          if (targetPath) bindings.set(node.name.text, { targetPath, importedName: "*", namespace: true });
        }
      } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isNewExpression(node.initializer)) {
        const expression = node.initializer.expression;
        if (ts.isIdentifier(expression)) {
          const binding = bindings.get(expression.text);
          if (binding) instanceBindings.set(node.name.text, binding);
        }
      }
      ts.forEachChild(node, collectImports);
    };
    collectImports(parsed.sourceFile);
    importedBindingsByFile.set(parsed.path, bindings);

    const localByName = new Map<string, InternalSymbol[]>();
    for (const symbol of parsed.symbols) {
      const candidates = localByName.get(symbol.simpleName) ?? [];
      candidates.push(symbol);
      localByName.set(symbol.simpleName, candidates);
    }
    const addCallTargets = (node: ts.CallExpression, targets: readonly InternalSymbol[]): void => {
      const line = sourceFileLine(parsed.sourceFile, node);
      const caller = sourceReference(containingSymbol(parsed.symbols, line), parsed.path, line);
      for (const target of targets) callEdges.push({ caller, calleeId: target.id });
    };
    const inspectCalls = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        if (expression.kind === ts.SyntaxKind.ImportKeyword) {
          const argument = node.arguments[0];
          if (!argument || !ts.isStringLiteralLike(argument)) {
            addUnresolved(unresolved, {
              kind: "dynamic_import",
              path: parsed.path,
              line: sourceFileLine(parsed.sourceFile, node),
              expression: boundedText(node, parsed.sourceFile),
              reason: "A non-literal dynamic import prevents deterministic dependency resolution.",
            }, limits);
          } else {
            recordDependency(argument.text, argument);
          }
        } else if (ts.isIdentifier(expression)) {
          if (expression.text === "require") {
            const argument = node.arguments[0];
            if (!argument || !ts.isStringLiteralLike(argument)) {
              addUnresolved(unresolved, {
                kind: "dynamic_require",
                path: parsed.path,
                line: sourceFileLine(parsed.sourceFile, node),
                expression: boundedText(node, parsed.sourceFile),
                reason: "A non-literal require prevents deterministic dependency resolution.",
              }, limits);
            } else {
              recordDependency(argument.text, argument);
            }
          } else if (expression.text === "eval" || expression.text === "Function") {
            addUnresolved(unresolved, {
              kind: expression.text === "eval" ? "eval" : "reflection",
              path: parsed.path,
              line: sourceFileLine(parsed.sourceFile, node),
              expression: boundedText(node, parsed.sourceFile),
              reason: "Runtime code construction cannot be mapped to a closed static call graph.",
            }, limits);
          } else {
            const binding = bindings.get(expression.text);
            addCallTargets(node, binding
              ? importedTargetSymbols(binding, null, symbolsByFile)
              : localByName.get(expression.text) ?? []);
          }
        } else if (ts.isPropertyAccessExpression(expression)) {
          const receiver = expression.expression;
          const property = expression.name.text;
          if (ts.isIdentifier(receiver) && receiver.text === "Reflect") {
            addUnresolved(unresolved, {
              kind: "reflection",
              path: parsed.path,
              line: sourceFileLine(parsed.sourceFile, node),
              expression: boundedText(node, parsed.sourceFile),
              reason: "Reflective invocation prevents deterministic target resolution.",
            }, limits);
          } else if (property === "call" || property === "apply" || property === "bind") {
            addUnresolved(unresolved, {
              kind: "reflection",
              path: parsed.path,
              line: sourceFileLine(parsed.sourceFile, node),
              expression: boundedText(node, parsed.sourceFile),
              reason: "Indirect function invocation prevents deterministic target resolution.",
            }, limits);
          } else if (ts.isIdentifier(receiver)) {
            const binding = bindings.get(receiver.text) ?? instanceBindings.get(receiver.text);
            if (binding) {
              addCallTargets(node, importedTargetSymbols(binding, property, symbolsByFile));
            }
          } else if (receiver.kind === ts.SyntaxKind.ThisKeyword) {
            const line = sourceFileLine(parsed.sourceFile, node);
            const caller = containingSymbol(parsed.symbols, line);
            const targets = parsed.symbols.filter((symbol) => symbol.className === caller?.className && symbol.simpleName === property);
            addCallTargets(node, targets);
          }
        } else if (ts.isElementAccessExpression(expression)) {
          const argument = expression.argumentExpression;
          if (!argument || (!ts.isStringLiteralLike(argument) && !ts.isNumericLiteral(argument))) {
            addUnresolved(unresolved, {
              kind: "computed_dispatch",
              path: parsed.path,
              line: sourceFileLine(parsed.sourceFile, node),
              expression: boundedText(node, parsed.sourceFile),
              reason: "A computed call target cannot be resolved to a deterministic symbol.",
            }, limits);
          }
        }
      } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") {
        addUnresolved(unresolved, {
          kind: "reflection",
          path: parsed.path,
          line: sourceFileLine(parsed.sourceFile, node),
          expression: boundedText(node, parsed.sourceFile),
          reason: "Runtime code construction cannot be mapped to a closed static call graph.",
        }, limits);
      }
      ts.forEachChild(node, inspectCalls);
    };
    inspectCalls(parsed.sourceFile);
  }

  for (const parsed of parsedPythonSources.values()) {
    const bindings = new Map<string, ImportedBinding>();
    const instanceBindings = new Map<string, ImportedBinding>();
    const recordDependency = (moduleName: string, line: number): string | null => {
      const targetPath = resolvePythonModule(parsed.path, moduleName, repositoryFiles);
      if (!targetPath && isRepositoryLocalPythonModule(moduleName, repositoryFiles)) {
        addUnresolved(unresolved, {
          kind: "unresolved_relative_import",
          path: parsed.path,
          line,
          expression: moduleName.slice(0, 200),
          reason: "A repository-local Python module dependency was absent from the controller-provided snapshot.",
        }, limits);
      }
      if (targetPath) {
        const sources = importers.get(targetPath) ?? new Set<string>();
        sources.add(parsed.path);
        importers.set(targetPath, sources);
      }
      return targetPath;
    };

    for (const [lineIndex, codeLine] of parsed.codeLines.entries()) {
      const line = lineIndex + 1;
      const trimmed = codeLine.trim();
      if (trimmed.length === 0) continue;
      const fromMatch = /^from\s+((?:\.+)?[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*|\.+)\s+import\s+(.+)$/.exec(trimmed);
      if (fromMatch?.[1] && fromMatch[2]) {
        const moduleName = fromMatch[1];
        const importedItems = fromMatch[2].split(",").map((item) => item.trim()).filter(Boolean);
        for (const item of importedItems) {
          const itemMatch = /^([A-Za-z_]\w*|\*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(item);
          if (!itemMatch?.[1]) {
            addUnresolved(unresolved, {
              kind: "parse_error",
              path: parsed.path,
              line,
              expression: trimmed.slice(0, 200),
              reason: "The Python import binding cannot be resolved conservatively.",
            }, limits);
            continue;
          }
          const importedName = itemMatch[1];
          const targetPath = /^\.+$/.test(moduleName)
            ? recordDependency(`${moduleName}${importedName}`, line)
            : recordDependency(moduleName, line);
          if (targetPath && importedName !== "*") {
            bindings.set(itemMatch[2] ?? importedName, {
              targetPath,
              importedName,
              namespace: false,
            });
          }
        }
        continue;
      }
      const importMatch = /^import\s+(.+)$/.exec(trimmed);
      if (importMatch?.[1]) {
        for (const item of importMatch[1].split(",").map((entry) => entry.trim()).filter(Boolean)) {
          const itemMatch = /^([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?:\s+as\s+([A-Za-z_]\w*))?$/.exec(item);
          if (!itemMatch?.[1]) {
            addUnresolved(unresolved, {
              kind: "parse_error",
              path: parsed.path,
              line,
              expression: trimmed.slice(0, 200),
              reason: "The Python import binding cannot be resolved conservatively.",
            }, limits);
            continue;
          }
          const targetPath = recordDependency(itemMatch[1], line);
          if (targetPath) {
            bindings.set(itemMatch[2] ?? itemMatch[1].split(".")[0]!, {
              targetPath,
              importedName: "*",
              namespace: true,
            });
          }
        }
      } else if (/^(?:from|import)\b/.test(trimmed)) {
        addUnresolved(unresolved, {
          kind: "parse_error",
          path: parsed.path,
          line,
          expression: trimmed.slice(0, 200),
          reason: "The Python import statement cannot be resolved conservatively.",
        }, limits);
      }
    }

    for (const codeLine of parsed.codeLines) {
      const instanceMatch = /^\s*([A-Za-z_]\w*)\s*=\s*([A-Za-z_]\w*)\s*\(/.exec(codeLine);
      const constructorBinding = instanceMatch?.[2] ? bindings.get(instanceMatch[2]) : undefined;
      if (instanceMatch?.[1] && constructorBinding) instanceBindings.set(instanceMatch[1], constructorBinding);
    }
    const localByName = new Map<string, InternalSymbol[]>();
    for (const symbol of parsed.symbols) {
      const candidates = localByName.get(symbol.simpleName) ?? [];
      candidates.push(symbol);
      localByName.set(symbol.simpleName, candidates);
    }
    const addCallTargets = (line: number, targets: readonly InternalSymbol[]): void => {
      const caller = sourceReference(containingSymbol(parsed.symbols, line), parsed.path, line);
      for (const target of targets) callEdges.push({ caller, calleeId: target.id });
    };
    const skippedCalls = new Set(["and", "assert", "class", "def", "del", "elif", "except", "for", "if", "import", "lambda", "not", "or", "raise", "return", "while", "with", "yield"]);
    for (const [lineIndex, codeLine] of parsed.codeLines.entries()) {
      const line = lineIndex + 1;
      const trimmed = codeLine.trim();
      if (trimmed.length === 0) continue;
      const dynamicPatterns: Array<{ pattern: RegExp; kind: UnresolvedImpactKind; reason: string }> = [
        { pattern: /\b__import__\s*\(/, kind: "dynamic_import", reason: "Python __import__ prevents deterministic dependency resolution." },
        { pattern: /\bimportlib\.import_module\s*\(/, kind: "dynamic_import", reason: "Python importlib.import_module prevents deterministic dependency resolution." },
        { pattern: /\bgetattr\s*\(/, kind: "reflection", reason: "Python getattr prevents deterministic call-target resolution." },
        { pattern: /\b(?:eval|exec)\s*\(/, kind: "eval", reason: "Python runtime code execution cannot be mapped to a closed static call graph." },
      ];
      for (const dynamic of dynamicPatterns) {
        if (dynamic.pattern.test(codeLine)) {
          addUnresolved(unresolved, {
            kind: dynamic.kind,
            path: parsed.path,
            line,
            expression: trimmed.slice(0, 200),
            reason: dynamic.reason,
          }, limits);
        }
      }
      if (/^(?:from|import)\b/.test(trimmed) || /^(?:async\s+)?def\b|^class\b/.test(trimmed)) continue;
      for (const match of codeLine.matchAll(/\b([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\(/g)) {
        const expression = match[1];
        if (!expression || skippedCalls.has(expression)) continue;
        const parts = expression.split(".");
        if (parts.length === 1) {
          const binding = bindings.get(expression);
          addCallTargets(line, binding
            ? importedTargetSymbols(binding, null, symbolsByFile)
            : localByName.get(expression) ?? []);
          continue;
        }
        const receiver = parts[0];
        const property = parts[1];
        if (!receiver || !property) continue;
        const caller = containingSymbol(parsed.symbols, line);
        if (receiver === "self" || receiver === "cls") {
          addCallTargets(line, parsed.symbols.filter((symbol) =>
            symbol.className === caller?.className && symbol.simpleName === property));
          continue;
        }
        const binding = bindings.get(receiver) ?? instanceBindings.get(receiver);
        if (binding) addCallTargets(line, importedTargetSymbols(binding, property, symbolsByFile));
      }
    }
  }

  callEdges.sort((left, right) => left.calleeId.localeCompare(right.calleeId) || left.caller.id.localeCompare(right.caller.id) || left.caller.line - right.caller.line);
  const callersByCallee = new Map<string, SymbolReference[]>();
  for (const edge of callEdges) {
    const callers = callersByCallee.get(edge.calleeId) ?? [];
    if (!callers.some((caller) => caller.id === edge.caller.id && caller.line === edge.caller.line)) callers.push(edge.caller);
    callersByCallee.set(edge.calleeId, callers);
  }

  const moduleSymbols: InternalSymbol[] = [...changedModuleData.entries()].map(([filePath]) => ({
    id: `${filePath}#<module>`,
    path: filePath,
    name: "<module>",
    simpleName: "<module>",
    className: null,
    kind: "module",
    exported: true,
    defaultExport: false,
    startLine: 1,
    endLine: parsedSources.get(filePath)?.sourceFile.getLineAndCharacterOfPosition(parsedSources.get(filePath)?.sourceFile.getEnd() ?? 0).line
      ?? parsedPythonSources.get(filePath)?.lineCount
      ?? 1,
  }));

  const changedInternal = [
    ...[...changedSymbolData.values()].map((entry) => entry.symbol),
    ...moduleSymbols,
  ].sort((left, right) => left.id.localeCompare(right.id));
  const symbolById = new Map<string, InternalSymbol>();
  for (const symbols of symbolsByFile.values()) for (const symbol of symbols) symbolById.set(symbol.id, symbol);
  for (const symbol of moduleSymbols) symbolById.set(symbol.id, symbol);

  const affectedReasons = new Map<string, Set<string>>();
  const addAffected = (filePath: string, reason: string): void => {
    const reasons = affectedReasons.get(filePath) ?? new Set<string>();
    reasons.add(reason);
    affectedReasons.set(filePath, reasons);
  };
  for (const changedPath of changedPaths) addAffected(changedPath, "changed_file");

  const workflows = new Map<string, WorkflowEntrypoint>();
  const queue: Array<{ id: string; distance: number }> = changedInternal.map((symbol) => ({ id: symbol.id, distance: 0 }));
  const visitedDistance = new Map<string, number>(queue.map((item) => [item.id, item.distance]));
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const symbol = symbolById.get(current.id);
    if (symbol) {
      addAffected(symbol.path, current.distance === 0 ? "changed_symbol" : `calls_changed_behavior:${current.distance}`);
      const kind = workflowKind(symbol.path, symbol.name);
      if (kind) {
        workflows.set(`${symbol.id}:${kind}`, {
          id: symbol.id,
          path: symbol.path,
          name: symbol.name,
          line: symbol.startLine,
          kind,
          reason: current.distance === 0 ? "Changed workflow entrypoint." : "Calls changed behavior.",
          distance: current.distance,
        });
      }
    }
    for (const caller of callersByCallee.get(current.id) ?? []) {
      addAffected(caller.path, `calls:${current.id}`);
      const nextDistance = current.distance + 1;
      const kind = workflowKind(caller.path, caller.name);
      if (kind) {
        workflows.set(`${caller.id}:${kind}`, {
          ...caller,
          kind,
          reason: "Calls changed behavior.",
          distance: nextDistance,
        });
      }
      if (caller.name === "<module>") continue;
      if (nextDistance > limits.maxTraversalDepth) {
        addUnresolved(unresolved, {
          kind: "traversal_limit",
          path: caller.path,
          line: caller.line,
          expression: caller.name,
          reason: `Caller traversal exceeded the configured depth of ${limits.maxTraversalDepth}.`,
        }, limits);
        continue;
      }
      const previousDistance = visitedDistance.get(caller.id);
      if (previousDistance === undefined || nextDistance < previousDistance) {
        visitedDistance.set(caller.id, nextDistance);
        queue.push({ id: caller.id, distance: nextDistance });
      }
    }
  }

  for (const changed of changedInternal) {
    for (const importer of importers.get(changed.path) ?? []) {
      addAffected(importer, `imports:${changed.path}`);
      const kind = workflowKind(importer, "<module>");
      if (kind) {
        workflows.set(`${importer}#<module>:${kind}`, {
          id: `${importer}#<module>`,
          path: importer,
          name: "<module>",
          line: 1,
          kind,
          reason: "Imports changed behavior.",
          distance: 1,
        });
      }
    }
  }

  const changedSymbols: ChangedSymbolImpact[] = changedInternal.map((symbol) => {
    const symbolData = changedSymbolData.get(symbol.id);
    const moduleData = changedModuleData.get(symbol.path);
    const data = symbol.kind === "module" ? moduleData : symbolData;
    const directCallers = [...(callersByCallee.get(symbol.id) ?? [])]
      .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line || left.id.localeCompare(right.id));
    return {
      id: symbol.id,
      path: symbol.path,
      name: symbol.name,
      line: symbol.startLine,
      kind: symbol.kind,
      exported: symbol.exported,
      defaultExport: symbol.defaultExport,
      startLine: symbol.startLine,
      endLine: Math.max(symbol.startLine, symbol.endLine),
      changedLines: [...(data?.changedLines ?? [])].sort((left, right) => left - right),
      changeKinds: [...(data?.changeKinds ?? [])].sort(),
      importers: [...(importers.get(symbol.path) ?? [])].sort(),
      callers: directCallers,
    };
  });

  const relevantRanges = new Map<string, Array<{ startLine: number; endLine: number }>>();
  for (const symbolId of visitedDistance.keys()) {
    const symbol = symbolById.get(symbolId);
    if (!symbol) continue;
    const ranges = relevantRanges.get(symbol.path) ?? [];
    ranges.push({ startLine: symbol.startLine, endLine: symbol.endLine });
    relevantRanges.set(symbol.path, ranges);
  }
  const alwaysCritical = new Set<UnresolvedImpactKind>([
    "binary_change",
    "deleted_source",
    "missing_changed_file",
    "unsupported_source_language",
    "unresolved_relative_import",
  ]);
  const relevantUnresolved = [...unresolved.values()].filter((item) => {
    if (item.kind === "traversal_limit") return true;
    if (alwaysCritical.has(item.kind) && changedPaths.has(item.path)) return true;
    return (relevantRanges.get(item.path) ?? []).some(
      ({ startLine, endLine }) => item.line >= startLine && item.line <= endLine,
    );
  });
  const sortedUnresolved = sortUnresolved(relevantUnresolved);
  const stats: ImpactMapStats = {
    repositoryFiles: repositoryFiles.size,
    repositoryBytes,
    diffFiles: diffFiles.length,
    hunks: diffFiles.reduce((count, file) => count + file.hunks.length, 0),
    changedLines: diffFiles.reduce((count, file) => count + file.hunks.reduce((subtotal, hunk) => subtotal + hunk.changes.length, 0), 0),
    parsedSourceFiles: parsedSources.size + parsedPythonSources.size,
    analyzedSymbols: [...symbolsByFile.values()].reduce((count, symbols) => count + symbols.length, 0),
  };
  const workflowValues = [...workflows.values()];
  const pathsWithSpecificWorkflows = new Set(
    workflowValues.filter(({ name }) => name !== "<module>").map(({ path: workflowPath }) => workflowPath),
  );
  const reportedWorkflows = workflowValues
    .filter((workflow) => workflow.name !== "<module>" || !pathsWithSpecificWorkflows.has(workflow.path))
    .sort((left, right) => left.distance - right.distance || left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
  return {
    schemaVersion: 1,
    status: sortedUnresolved.length === 0 ? "complete" : "blocked",
    diffFiles,
    changedSymbols,
    affectedFiles: [...affectedReasons.entries()]
      .map(([filePath, reasons]) => ({ path: filePath, reasons: [...reasons].sort() }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    workflows: reportedWorkflows,
    unresolvedPaths: sortedUnresolved,
    stats,
  };
}
