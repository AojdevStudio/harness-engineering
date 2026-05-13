#!/usr/bin/env bun

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import ts from "typescript";

interface ExportDocStatus {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly name: string;
  readonly documented: boolean;
  readonly internal: boolean;
}

const sourceRoots = ["packages", "apps"];
const ignored = new Set(["node_modules", ".symphony", "dist", "docs"]);

async function main(): Promise<void> {
  const outputPath = outputArg(process.argv);
  const failOnMissing = process.argv.includes("--fail-on-missing");
  const files = await sourceFiles(process.cwd());
  const statuses = (await Promise.all(files.map(analyzeFile))).flat();
  const report = renderReport(statuses);
  const missingCount = statuses.filter((status) => !status.internal && !status.documented).length;

  if (outputPath) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, report);
    console.log(`Wrote ${outputPath}`);
    if (failOnMissing && missingCount > 0) process.exit(1);
    return;
  }

  process.stdout.write(report);
  if (failOnMissing && missingCount > 0) process.exit(1);
}

function outputArg(argv: readonly string[]): string | undefined {
  const index = argv.indexOf("--write");
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value) throw new Error("--write requires a path");
  return value;
}

async function sourceFiles(root: string): Promise<readonly string[]> {
  const files: string[] = [];
  for (const sourceRoot of sourceRoots) {
    await collect(join(root, sourceRoot), files);
  }
  return files.sort();
}

async function collect(path: string, files: string[]): Promise<void> {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      await collect(child, files);
    } else if (entry.isFile() && child.endsWith(".ts") && !child.endsWith(".test.ts")) {
      files.push(child);
    }
  }
}

async function analyzeFile(path: string): Promise<readonly ExportDocStatus[]> {
  const source = await readFile(path, "utf8");
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const statuses: ExportDocStatus[] = [];

  for (const statement of sourceFile.statements) {
    if (!isDocumentableExport(statement)) continue;
    const name = declarationName(statement);
    if (!name) continue;
    const comments = leadingDocComments(source, statement);
    const { line } = sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile));
    statuses.push({
      file: relative(process.cwd(), path),
      line: line + 1,
      kind: declarationKind(statement),
      name,
      documented: comments.length > 0,
      internal: comments.some((comment) => comment.includes("@internal")),
    });
  }

  return statuses;
}

function isDocumentableExport(node: ts.Node): boolean {
  if (!hasExportModifier(node)) return false;
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableStatement(node)
  );
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && Boolean(ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function declarationName(node: ts.Node): string | undefined {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.map((declaration) => declaration.name.getText()).join(", ");
  }
  if ("name" in node && node.name && ts.isIdentifier(node.name)) return node.name.text;
  return undefined;
}

function declarationKind(node: ts.Node): string {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isVariableStatement(node)) {
    const flags = node.declarationList.flags;
    if ((flags & ts.NodeFlags.Const) !== 0) return "const";
    if ((flags & ts.NodeFlags.Let) !== 0) return "let";
    return "var";
  }
  return "export";
}

function leadingDocComments(source: string, node: ts.Node): readonly string[] {
  const comments = ts.getLeadingCommentRanges(source, node.pos) ?? [];
  return comments
    .map((comment) => source.slice(comment.pos, comment.end))
    .filter((comment) => comment.startsWith("/**"));
}

function renderReport(statuses: readonly ExportDocStatus[]): string {
  const publicStatuses = statuses.filter((status) => !status.internal);
  const documented = publicStatuses.filter((status) => status.documented).length;
  const missing = publicStatuses.filter((status) => !status.documented);
  const coverage = publicStatuses.length === 0 ? 100 : (documented / publicStatuses.length) * 100;
  const byFile = groupByFile(missing);

  const lines = [
    "# API Documentation Report",
    "",
    "Generated by `bun run docs:api:report`.",
    "",
    "## Summary",
    "",
    `- Public exported declarations scanned: ${publicStatuses.length}`,
    `- Documented public declarations: ${documented}`,
    `- Missing documentation: ${missing.length}`,
    `- Current documentation coverage: ${coverage.toFixed(2)}%`,
    "",
    "This report is a backlog, not a CI failure. See [API Documentation Policy](api-documentation-policy.md) and [ADR 0001](adr/0001-api-documentation-policy.md).",
    "",
    "## Missing Documentation By File",
    "",
  ];

  if (missing.length === 0) {
    lines.push("No missing public API documentation found.", "");
    return `${lines.join("\n")}\n`;
  }

  for (const [file, items] of byFile) {
    lines.push(`### ${file}`, "");
    for (const item of items) {
      lines.push(`- Line ${item.line}: \`${item.kind} ${item.name}\``);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function groupByFile(statuses: readonly ExportDocStatus[]): readonly [string, readonly ExportDocStatus[]][] {
  const groups = new Map<string, ExportDocStatus[]>();
  for (const status of statuses) {
    const group = groups.get(status.file) ?? [];
    group.push(status);
    groups.set(status.file, group);
  }
  return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
}

await main();
