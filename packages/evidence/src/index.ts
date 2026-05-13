import { mkdir, writeFile } from "node:fs/promises";
import { basename, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";

export type EvidenceKind = "log" | "screenshot" | "video" | "test-output" | "link" | "other";

export interface EvidenceArtifact {
  readonly artifactId: string;
  readonly runId: string;
  readonly issueId?: string | null;
  readonly kind: EvidenceKind;
  readonly uri: string;
  readonly label: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

export interface EvidenceStoreOptions {
  readonly root: string;
}

export class EvidenceStore {
  private readonly root: string;

  constructor(options: EvidenceStoreOptions) {
    this.root = resolve(options.root);
  }

  async createRunDirectory(runId: string, child = "artifacts"): Promise<string> {
    const dir = resolve(this.root, sanitizeFilename(runId), sanitizeFilename(child));
    assertInsideRoot(this.root, dir);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async writeTextArtifact(input: {
    readonly runId: string;
    readonly issueId?: string | null;
    readonly kind: EvidenceKind;
    readonly label: string;
    readonly filename: string;
    readonly content: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): Promise<EvidenceArtifact> {
    const artifactId = randomUUID();
    const safeFilename = sanitizeFilename(input.filename);
    const dir = resolve(this.root, sanitizeFilename(input.runId));
    assertInsideRoot(this.root, dir);
    await mkdir(dir, { recursive: true });
    const path = resolve(dir, `${artifactId}-${safeFilename}`);
    assertInsideRoot(this.root, path);
    await writeFile(path, input.content, "utf8");

    return {
      artifactId,
      runId: input.runId,
      issueId: input.issueId ?? null,
      kind: input.kind,
      uri: path,
      label: input.label,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
  }

  recordFileArtifact(input: {
    readonly runId: string;
    readonly issueId?: string | null;
    readonly kind: EvidenceKind;
    readonly label: string;
    readonly path: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }): EvidenceArtifact {
    const uri = resolve(input.path);
    assertInsideRoot(this.root, uri);
    return {
      artifactId: randomUUID(),
      runId: input.runId,
      issueId: input.issueId ?? null,
      kind: input.kind,
      uri,
      label: input.label,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
  }
}

function assertInsideRoot(root: string, path: string): void {
  const rel = relative(resolve(root), resolve(path));
  if (rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"))) return;
  throw new Error(`Evidence path escapes evidence root: ${path}`);
}

export function sanitizeFilename(filename: string): string {
  const base = basename(filename).replace(/[^A-Za-z0-9._-]/g, "_");
  return base === "" || base === "." || base === ".." ? "artifact.txt" : base;
}
