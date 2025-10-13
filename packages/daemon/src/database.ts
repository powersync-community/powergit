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

export interface CreateDatabaseOptions {
  dbPath: string;
  readWorkerCount?: number;
}

export interface ConnectOptions {
  connector: PowerSyncBackendConnector;
  dbPath: string;
  includeDefaultStreams?: boolean;
  reconnectDelayMs?: number;
}

function isSchemaMismatchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  return message.includes('schema mismatch') || message.includes('schema differences');
}

async function removeLocalReplica(dbPath: string): Promise<void> {
  await fs.rm(dbPath, { force: true });
  await fs.mkdir(dirname(dbPath), { recursive: true });
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

  let resetOnce = false;
  while (true) {
    try {
      await database.init();
      break;
    } catch (error) {
      if (resetOnce) {
        throw error;
      }
      resetOnce = true;
      await database.close({ disconnect: true }).catch(() => undefined);
      await removeLocalReplica(options.dbPath).catch(() => undefined);
    }
  }
  return database;
}

export async function connectWithSchemaRecovery(
  database: PowerSyncDatabase,
  { connector, dbPath, includeDefaultStreams = false, reconnectDelayMs = 1_000 }: ConnectOptions,
): Promise<void> {
  while (true) {
    try {
      await database.connect(connector, {
        clientImplementation: SyncClientImplementation.RUST,
        includeDefaultStreams,
      });
      await database.waitForReady();
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

      console.error('[powersync-daemon] failed to connect to PowerSync backend', error);
      await delay(reconnectDelayMs).catch(() => undefined);
    }
  }
}
