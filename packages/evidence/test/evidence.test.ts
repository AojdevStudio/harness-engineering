import { describe, expect, test } from "bun:test";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EvidenceStore, sanitizeFilename } from "../src/index.ts";

describe("EvidenceStore", () => {
  test("writes text artifacts under run directory", async () => {
    const root = join(tmpdir(), `symphony-evidence-${Date.now()}`);
    try {
      const store = new EvidenceStore({ root });
      const artifact = await store.writeTextArtifact({
        runId: "run-1",
        issueId: "issue-1",
        kind: "test-output",
        label: "Verify output",
        filename: "../verify.log",
        content: "ok",
      });

      expect(artifact.uri).toContain("run-1");
      expect(await readFile(artifact.uri, "utf8")).toBe("ok");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("sanitizes filenames", () => {
    expect(sanitizeFilename("../bad name.log")).toBe("bad_name.log");
    expect(sanitizeFilename("..")).toBe("artifact.txt");
  });

  test("sanitizes run directory names", async () => {
    const root = join(tmpdir(), `symphony-evidence-safe-${Date.now()}`);
    try {
      const store = new EvidenceStore({ root });
      const artifact = await store.writeTextArtifact({
        runId: "../evil",
        issueId: "issue-1",
        kind: "log",
        label: "Log",
        filename: "out.txt",
        content: "safe",
      });

      expect(artifact.uri.startsWith(root)).toBe(true);
      expect(artifact.uri).toContain("/evil/");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
