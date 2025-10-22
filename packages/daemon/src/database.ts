import { promises as fs, accessSync } from 'node:fs';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { PowerSyncBackendConnector } from '@powersync/node';
import { PowerSyncDatabase, SyncClientImplementation } from '@powersync/node';
import { AppSchema } from './schema.js';

const WORKER_MODULE = (() => {
  const jsModule = new URL('./worker.js', import.meta.url);
  try {
    accessSync(fileURLToPath(jsModule));
    return jsModule;
  } catch {
    return new URL('./worker.ts', import.meta.url);
  }
})();

const DEFAULT_CONNECT_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_CONNECT_TIMEOUT_MS ?? '30000', 10);
const DEFAULT_READY_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_READY_TIMEOUT_MS ?? '30000', 10);

export interface CreateDatabaseOptions {
  dbPath: string;
  readWorkerCount?: number;
}

export interface ConnectOptions {
  connector: PowerSyncBackendConnector;
  dbPath: string;
  includeDefaultStreams?: boolean;
  reconnectDelayMs?: number;
  connectTimeoutMs?: number;
  readyTimeoutMs?: number;
}

function isSchemaMismatchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('schema mismatch') || message.includes('schema differences');
}

class PowerSyncTimeoutError extends Error {
  readonly stage: string;

  constructor(stage: string, timeoutMs: number) {
    super(`PowerSync ${stage} timed out after ${timeoutMs}ms`);
    this.name = 'PowerSyncTimeoutError';
    this.stage = stage;
  }
}

async function removeLocalReplica(dbPath: string): Promise<void> {
  await fs.rm(dbPath, { force: true });
  await fs.mkdir(dirname(dbPath), { recursive: true });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, stage: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timer: NodeJS.Timeout | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PowerSyncTimeoutError(stage, timeoutMs)), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function createPowerSyncDatabase(options: CreateDatabaseOptions): Promise<PowerSyncDatabase> {
  const database = new PowerSyncDatabase({
    schema: AppSchema,
    database: {
      dbFilename: options.dbPath,
      readWorkerCount: options.readWorkerCount,
      openWorker: (_, workerOptions) => {
        const execArgv = Array.isArray(workerOptions?.execArgv)
          ? [...workerOptions.execArgv]
          : [];
        if (WORKER_MODULE.pathname.endsWith('.ts')) {
          const hasImport = execArgv.some((arg) => arg.startsWith('--import'));
          if (!hasImport) {
            execArgv.push('--import=tsx/esm');
          }
        }

        return new Worker(WORKER_MODULE, {
          ...workerOptions,
          execArgv,
        });
      },
    },
  });

  await database.init();
  return database;
}

export async function connectWithSchemaRecovery(
  database: PowerSyncDatabase,
  {
    connector,
    dbPath,
    includeDefaultStreams = false,
    reconnectDelayMs = 1_000,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    readyTimeoutMs = DEFAULT_READY_TIMEOUT_MS,
  }: ConnectOptions,
): Promise<void> {
  while (true) {
    try {
      await withTimeout(
        database.connect(connector, { clientImplementation: SyncClientImplementation.RUST, includeDefaultStreams }),
        connectTimeoutMs,
        'connect',
      );
      await withTimeout(database.waitForReady(), readyTimeoutMs, 'waitForReady');
      return;
    } catch (error) {
      if (isSchemaMismatchError(error)) {
        console.warn('[powersync-daemon] detected schema mismatch; resetting local replica');
        await database.close({ disconnect: true }).catch(() => undefined);
        await removeLocalReplica(dbPath).catch((resetError) => {
          console.error('[powersync-daemon] failed to remove local replica during schema recovery', resetError);
          throw resetError;
        });
        await database.init();
        continue;
      }

      if (error instanceof PowerSyncTimeoutError) {
        console.error(`[powersync-daemon] ${error.message}`);
      } else {
        console.error('[powersync-daemon] failed to connect to PowerSync backend', error);
      }

      await database.close({ disconnect: true }).catch(() => undefined);
      await database.init().catch(() => undefined);
      await delay(reconnectDelayMs).catch(() => undefined);
    }
  }
}
