import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface DaemonConfig {
  dbFilename?: string;
}

const DEFAULT_DB_FILENAME = "powersync-daemon.db";

export async function startDaemon(config: DaemonConfig = {}) {
  const dbFilename = resolve(config.dbFilename ?? DEFAULT_DB_FILENAME);

  // TODO: wire up PowerSyncDatabase with shared schema and bridge connector.
  console.info(`[powersync-daemon] starting (db: ${dbFilename})`);
  console.info("PowerSync wiring not yet implemented; this is a bootstrap stub.");

  // Placeholder to keep process alive until full implementation lands.
  process.stdin.resume();
}

const isExecutedDirectly = process.argv[1] === fileURLToPath(import.meta.url);

if (isExecutedDirectly) {
  startDaemon().catch((error) => {
    console.error("[powersync-daemon] fatal error", error);
    process.exitCode = 1;
  });
}
