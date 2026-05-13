import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const outputDir = process.env.SYMPHONY_EVIDENCE_DIR;
const issueIdentifier = process.env.SYMPHONY_ISSUE_IDENTIFIER ?? "unknown";

if (!outputDir) throw new Error("SYMPHONY_EVIDENCE_DIR is required");
await mkdir(outputDir, { recursive: true });

const appPath = resolve(process.cwd(), "fake-app.html");
const specPath = join(outputDir, "playwright-evidence.spec.cjs");
const playwrightOutputPath = join(outputDir, "playwright-output.txt");
const artifactRoot = join(outputDir, "playwright-artifacts");
const screenshotPath = join(outputDir, "final-state.png");

await writeFile(
  specPath,
  `const { test, expect } = require('@playwright/test');

test.use({ video: 'on' });

test('Symphony UI evidence for ${issueIdentifier}', async ({ page }) => {
  await page.goto(${JSON.stringify(`file://${appPath}`)});
  await expect(page.locator('[data-testid="status"]')).toHaveText('Done by agent');
  await expect(page.locator('[data-testid="issue"]')).toHaveText(${JSON.stringify(issueIdentifier)});
  await page.screenshot({ path: ${JSON.stringify(screenshotPath)}, fullPage: true });
});
`,
  "utf8",
);

const proc = Bun.spawn([resolve(repoRoot, "node_modules/.bin/playwright"), "test", "playwright-evidence.spec.cjs", "--output", artifactRoot, "--reporter=line"], {
  cwd: outputDir,
  env: { ...process.env, NODE_PATH: resolve(repoRoot, "node_modules") },
  stdout: "pipe",
  stderr: "pipe",
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
await writeFile(playwrightOutputPath, stdout + stderr, "utf8");
if (exitCode !== 0) throw new Error(`Playwright evidence failed with exit code ${exitCode}`);

const videoPath = await findFirstFile(artifactRoot, "video.webm");
if (!videoPath) throw new Error("Playwright did not produce video.webm");
await copyFile(videoPath, join(outputDir, "ui-proof.webm"));

async function findFirstFile(root: string, name: string): Promise<string | null> {
  for await (const entry of new Bun.Glob("**/*").scan({ cwd: root, absolute: true, onlyFiles: true })) {
    if (entry.endsWith(`/${name}`)) return entry;
  }
  return null;
}
