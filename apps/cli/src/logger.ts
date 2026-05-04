type Level = "debug" | "info" | "warn" | "error";

function log(level: Level, msg: string, fields?: Record<string, unknown>): void {
  process.stderr.write(
    JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(fields ?? {}) }) + "\n",
  );
}

export const logger = {
  info: (msg: string, fields?: Record<string, unknown>) => log("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => log("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => log("error", msg, fields),
};
