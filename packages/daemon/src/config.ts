import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promises as fs } from 'node:fs';

export interface DaemonConfig {
  /** Absolute path to the daemon SQLite replica. */
  dbPath: string;
  /** PowerSync service endpoint (https://host). */
  endpoint?: string;
  /** Optional explicit stream identifiers to subscribe on start. */
  initialStreams: readonly string[];
  /** Hostname/interface the RPC server should bind to. */
  host: string;
  /** Port for the RPC server. */
  port: number;
}

export interface ResolveDaemonConfigOptions {
  dbPath?: string;
  endpoint?: string;
  initialStreams?: readonly string[];
  host?: string;
  port?: number;
}

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5030;

function resolveEnvList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolvePowergitHome(): string {
  const override = process.env.POWERGIT_HOME;
  if (override && override.trim().length > 0) {
    return resolve(override.trim());
  }
  return resolve(homedir(), '.powergit');
}

function sanitizeProfileKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'default';
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function resolveProfileNameFromEnv(): string {
  const candidate = process.env.POWERGIT_PROFILE ?? process.env.STACK_PROFILE ?? process.env.POWERGIT_ACTIVE_PROFILE ?? 'prod';
  const trimmed = String(candidate ?? '').trim();
  return trimmed.length > 0 ? trimmed : 'prod';
}

function resolveDefaultDbPath(): string {
  const profileKey = sanitizeProfileKey(resolveProfileNameFromEnv());
  return resolve(resolvePowergitHome(), 'daemon', profileKey, 'powersync-daemon.db');
}

async function ensureDirectoryExists(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function resolveDaemonConfig(options: ResolveDaemonConfigOptions = {}): Promise<DaemonConfig> {
  const dbPath = resolve(
    options.dbPath ??
      process.env.POWERGIT_DAEMON_DB_PATH ??
      process.env.POWERSYNC_DAEMON_DB_PATH ??
      resolveDefaultDbPath(),
  );
  await ensureDirectoryExists(dirname(dbPath));

  const endpoint = options.endpoint ?? process.env.POWERSYNC_DAEMON_ENDPOINT ?? process.env.POWERSYNC_URL ?? undefined;

  const explicitStreams = options.initialStreams ?? resolveEnvList(process.env.POWERGIT_DAEMON_STREAMS ?? process.env.POWERSYNC_DAEMON_STREAMS);

  const host = options.host ?? process.env.POWERGIT_DAEMON_HOST ?? process.env.POWERSYNC_DAEMON_HOST ?? DEFAULT_HOST;
  const rawPort =
    options.port ??
    (process.env.POWERGIT_DAEMON_PORT ? Number(process.env.POWERGIT_DAEMON_PORT) : undefined) ??
    (process.env.POWERSYNC_DAEMON_PORT ? Number(process.env.POWERSYNC_DAEMON_PORT) : undefined);
  const port = Number.isFinite(rawPort) && rawPort! > 0 ? Number(rawPort) : DEFAULT_PORT;

  return {
    dbPath,
    endpoint,
    initialStreams: explicitStreams,
    host,
    port,
  };
}
