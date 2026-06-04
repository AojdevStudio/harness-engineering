import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

describe("CLI package metadata", () => {
  test("root package exposes a direct symphony bin for local linking", async () => {
    const rootPackage = JSON.parse(await readFile(resolve(import.meta.dir, "../../../package.json"), "utf8")) as {
      readonly bin?: Record<string, string>;
    };

    expect(rootPackage.bin?.symphony).toBe("./apps/cli/src/main.ts");
  });

  test("workspace CLI package keeps the same executable entrypoint", async () => {
    const cliPackage = JSON.parse(await readFile(resolve(import.meta.dir, "../package.json"), "utf8")) as {
      readonly bin?: Record<string, string>;
    };

    expect(cliPackage.bin?.symphony).toBe("./src/main.ts");
  });
});
