import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openSymphonyDatabase } from "@symphony/db";
import { createServer, escapeHtml } from "./index.ts";

describe("createServer", () => {
  test("serves state API with bearer auth", async () => {
    const db = openSymphonyDatabase();
    try {
      db.createRun({ runId: "run-1", issueId: "issue-1", identifier: "ABC-1" });
      const server = createServer({ db, token: "secret" });

      const unauthorizedResp = await server.fetch(new Request("http://local/api/v1/state"));
      expect(unauthorizedResp.status).toBe(401);

      const response = await server.fetch(new Request("http://local/api/v1/state", { headers: { authorization: "Bearer secret" } }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as { runs: Array<{ runId: string }> };
      expect(body.runs[0]?.runId).toBe("run-1");
    } finally {
      db.close();
    }
  });

  test("serves binary evidence with matching content type", async () => {
    const root = await mkdtemp(join(tmpdir(), "symphony-server-evidence-"));
    const db = openSymphonyDatabase();
    try {
      const path = join(root, "proof.webm");
      await writeFile(path, "video");
      db.createRun({ runId: "run-1", issueId: "issue-1", identifier: "ABC-1" });
      db.recordEvidence({ artifactId: "artifact-1", runId: "run-1", issueId: "issue-1", kind: "video", uri: path, label: "Video" });
      const server = createServer({ db, token: "secret" });

      const response = await server.fetch(new Request("http://local/api/v1/evidence/artifact-1", { headers: { authorization: "Bearer secret" } }));

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("video/webm");
      expect(await response.text()).toBe("video");
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("serves dashboard without auth", async () => {
    const db = openSymphonyDatabase();
    try {
      const server = createServer({ db, token: "secret" });
      const response = await server.fetch(new Request("http://local/"));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Symphony");
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// P0: fail-closed auth (no token configured)
// ---------------------------------------------------------------------------
describe("fail-closed auth (no token)", () => {
  test("returns 401 when no token configured and allowInsecure not set", async () => {
    const db = openSymphonyDatabase();
    try {
      const server = createServer({ db });
      const response = await server.fetch(new Request("http://local/api/v1/runs"));
      expect(response.status).toBe(401);
    } finally {
      db.close();
    }
  });

  test("returns 401 when no token and allowInsecure is explicitly false", async () => {
    const db = openSymphonyDatabase();
    try {
      const server = createServer({ db, allowInsecure: false });
      const response = await server.fetch(new Request("http://local/api/v1/runs"));
      expect(response.status).toBe(401);
    } finally {
      db.close();
    }
  });

  test("allows access when no token and allowInsecure is true", async () => {
    const db = openSymphonyDatabase();
    try {
      const server = createServer({ db, allowInsecure: true });
      const response = await server.fetch(new Request("http://local/api/v1/runs"));
      expect(response.status).toBe(200);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// P1-A: constant-time bearer comparison
// ---------------------------------------------------------------------------
describe("constant-time bearer comparison", () => {
  test("rejects a token that is the correct length but wrong content", async () => {
    const db = openSymphonyDatabase();
    try {
      // "secret" is 6 chars; "xxxxxx" is also 6 chars but wrong
      const server = createServer({ db, token: "secret" });
      const response = await server.fetch(
        new Request("http://local/api/v1/runs", { headers: { authorization: "Bearer xxxxxx" } }),
      );
      expect(response.status).toBe(401);
    } finally {
      db.close();
    }
  });

  test("rejects a token that is shorter than the configured token", async () => {
    const db = openSymphonyDatabase();
    try {
      const server = createServer({ db, token: "longsecret" });
      const response = await server.fetch(
        new Request("http://local/api/v1/runs", { headers: { authorization: "Bearer short" } }),
      );
      expect(response.status).toBe(401);
    } finally {
      db.close();
    }
  });

  test("rejects a token that is longer than the configured token", async () => {
    const db = openSymphonyDatabase();
    try {
      const server = createServer({ db, token: "short" });
      const response = await server.fetch(
        new Request("http://local/api/v1/runs", { headers: { authorization: "Bearer muchlongertoken" } }),
      );
      expect(response.status).toBe(401);
    } finally {
      db.close();
    }
  });

  test("accepts the correct token", async () => {
    const db = openSymphonyDatabase();
    try {
      const server = createServer({ db, token: "correcttoken" });
      const response = await server.fetch(
        new Request("http://local/api/v1/runs", { headers: { authorization: "Bearer correcttoken" } }),
      );
      expect(response.status).toBe(200);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// P1-B: pause-and-drain replaces /cancel
// ---------------------------------------------------------------------------
describe("control endpoints", () => {
  test("/api/v1/control/pause-and-drain returns action: pause-and-drain", async () => {
    const db = openSymphonyDatabase();
    try {
      const server = createServer({ db, allowInsecure: true });
      const response = await server.fetch(
        new Request("http://local/api/v1/control/pause-and-drain", { method: "POST" }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; action: string; note: string };
      expect(body.ok).toBe(true);
      expect(body.action).toBe("pause-and-drain");
      expect(typeof body.note).toBe("string");
      expect(body.note.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("/api/v1/control/cancel is gone (404)", async () => {
    const db = openSymphonyDatabase();
    try {
      const server = createServer({ db, allowInsecure: true });
      const response = await server.fetch(
        new Request("http://local/api/v1/control/cancel", { method: "POST" }),
      );
      expect(response.status).toBe(404);
    } finally {
      db.close();
    }
  });

  test("/api/v1/control/pause returns action: pause", async () => {
    const db = openSymphonyDatabase();
    try {
      const server = createServer({ db, allowInsecure: true });
      const response = await server.fetch(
        new Request("http://local/api/v1/control/pause", { method: "POST" }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; action: string };
      expect(body.action).toBe("pause");
    } finally {
      db.close();
    }
  });

  test("/api/v1/control/resume returns action: resume", async () => {
    const db = openSymphonyDatabase();
    try {
      const server = createServer({ db, allowInsecure: true });
      const response = await server.fetch(
        new Request("http://local/api/v1/control/resume", { method: "POST" }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as { ok: boolean; action: string };
      expect(body.action).toBe("resume");
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// P2: escapeHtml helper
// ---------------------------------------------------------------------------
describe("escapeHtml", () => {
  test("escapes ampersands", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  test("escapes less-than and greater-than", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  test("escapes double quotes", () => {
    expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
  });

  test("escapes single quotes", () => {
    expect(escapeHtml("it's")).toBe("it&#39;s");
  });

  test("escapes all special chars in one string", () => {
    expect(escapeHtml(`<div class="a" data-x='y'>a & b</div>`)).toBe(
      "&lt;div class=&quot;a&quot; data-x=&#39;y&#39;&gt;a &amp; b&lt;/div&gt;",
    );
  });

  test("returns plain strings unchanged", () => {
    expect(escapeHtml("hello world")).toBe("hello world");
  });
});
