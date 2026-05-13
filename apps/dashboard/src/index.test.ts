import { describe, expect, test } from "bun:test";
import { dashboardRoutes, renderDashboardHtml } from "./index.ts";

describe("dashboard shell", () => {
  test("declares operator routes for the required views", () => {
    expect(dashboardRoutes.map((route) => route.path)).toEqual(["/runs", "/events", "/evidence", "/health", "/control"]);
  });

  test("renders a navigable SPA instead of raw JSON dumps", () => {
    const html = renderDashboardHtml();

    expect(html).toContain("Symphony Control Plane");
    expect(html).toContain('id="nav"');
    expect(html).toContain('id="app"');
    expect(html).toContain("data-route");
    expect(html).toContain("window.location.pathname");
    expect(html).toContain("window.history.pushState");
    expect(html).toContain("/api/v1/health");
    expect(html).toContain("/api/v1/control/actions");
    expect(html).toContain("fetchEvidenceBlob");
    expect(html).not.toContain('id="runs">Loading');
    expect(html).not.toContain("JSON.stringify(runs");
  });
});
