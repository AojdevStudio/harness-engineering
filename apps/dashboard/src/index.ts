export interface DashboardRoute {
  readonly path: string;
  readonly label: string;
}

export const dashboardRoutes: readonly DashboardRoute[] = [
  { path: "/", label: "Runs" },
  { path: "/evidence", label: "Evidence" },
  { path: "/config", label: "Config" },
];
