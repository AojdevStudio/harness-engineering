import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readPrTemplate } from "../src/index.ts";

describe("readPrTemplate", () => {
  test("returns null when no PR template exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-pr-template-"));
    try {
      await mkdir(join(root, ".github"), { recursive: true });
      expect(await readPrTemplate(root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reads uppercase template path and parses H2 sections", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-pr-template-"));
    try {
      await mkdir(join(root, ".github"), { recursive: true });
      await writeFile(
        join(root, ".github", "PULL_REQUEST_TEMPLATE.md"),
        "Preamble\n\n## Description\nKeep this text.\n\n## Testing\n- [ ] Run tests\n",
      );

      const template = await readPrTemplate(root);
      expect(template?.sections).toEqual([
        { header: "Description", body: "Keep this text." },
        { header: "Testing", body: "- [ ] Run tests" },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("falls back to lowercase template path", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-pr-template-"));
    try {
      await mkdir(join(root, ".github"), { recursive: true });
      await writeFile(join(root, ".github", "pull_request_template.md"), "## Summary\nlowercase path\n");

      const template = await readPrTemplate(root);
      expect(template?.raw).toContain("lowercase path");
      expect(template?.sections).toEqual([{ header: "Summary", body: "lowercase path" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
