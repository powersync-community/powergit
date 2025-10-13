import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { promises as fs } from 'node:fs';

export interface DaemonConfig {
  /** Absolute path to the daemon SQLite replica. */
  dbPath: string;
  /** PowerSync service endpoint (https://host). */
  endpoint?: string;
  /** PowerSync JWT or service token. */
  token?: string;
  /** Optional explicit stream identifiers to subscribe on start. */
  initialStreams: readonly string[];
  /** Hostname/interface the RPC server should bind to. */
  host: string;
  /** Port for the RPC server. */
  port: number;
  /** Optional Supabase credentials for the writer. */
  supabase?: {
    url: string;
    serviceRoleKey: string;
    schema?: string;
  };
}

export interface ResolveDaemonConfigOptions {
  dbPath?: string;
  endpoint?: string;
  token?: string;
  initialStreams?: readonly string[];
  host?: string;
  port?: number;
  supabaseUrl?: string;
  supabaseServiceRoleKey?: string;
  supabaseSchema?: string;
}

const DEFAULT_DB_RELATIVE_PATH = '.powersync/daemon/powersync-daemon.db';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 5030;

function resolveEnvList(value?: string): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function ensureDirectoryExists(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function resolveDaemonConfig(options: ResolveDaemonConfigOptions = {}): Promise<DaemonConfig> {
  const dbPath = resolve(options.dbPath ?? process.env.POWERSYNC_DAEMON_DB_PATH ?? resolve(homedir(), DEFAULT_DB_RELATIVE_PATH));
  await ensureDirectoryExists(dirname(dbPath));

  const endpoint = options.endpoint ?? process.env.POWERSYNC_DAEMON_ENDPOINT ?? process.env.POWERSYNC_ENDPOINT ?? undefined;
  const token = options.token ?? process.env.POWERSYNC_DAEMON_TOKEN ?? process.env.POWERSYNC_TOKEN ?? undefined;

  const explicitStreams = options.initialStreams ?? resolveEnvList(process.env.POWERSYNC_DAEMON_STREAMS);

  const host = options.host ?? process.env.POWERSYNC_DAEMON_HOST ?? DEFAULT_HOST;
  const rawPort = options.port ?? (process.env.POWERSYNC_DAEMON_PORT ? Number(process.env.POWERSYNC_DAEMON_PORT) : undefined);
  const port = Number.isFinite(rawPort) && rawPort! > 0 ? Number(rawPort) : DEFAULT_PORT;

  const supabaseUrl =
    options.supabaseUrl ??
    process.env.POWERSYNC_DAEMON_SUPABASE_URL ??
    process.env.POWERSYNC_SUPABASE_URL ??
    undefined;
  const supabaseServiceRoleKey =
    options.supabaseServiceRoleKey ??
    process.env.POWERSYNC_DAEMON_SUPABASE_SERVICE_ROLE_KEY ??
    process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY ??
    undefined;
  const supabaseSchema =
    options.supabaseSchema ??
    process.env.POWERSYNC_DAEMON_SUPABASE_SCHEMA ??
    process.env.POWERSYNC_SUPABASE_SCHEMA ??
    undefined;

  const supabase =
    supabaseUrl && supabaseServiceRoleKey
      ? { url: supabaseUrl, serviceRoleKey: supabaseServiceRoleKey, schema: supabaseSchema }
      : undefined;

  return {
    dbPath,
    endpoint,
    token,
    initialStreams: explicitStreams,
    host,
    port,
    supabase,
  };
}
