import { promises as fs } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { PowerSyncDatabase } from '@powersync/node'
import { AppSchema } from './schema.js'

const DEFAULT_DB_RELATIVE_PATH = '.psgit/psgit.db'

export interface CliDatabaseOptions {
  /** Absolute path to the SQLite database file. Defaults to ~/.psgit/psgit.db */
  dbPath?: string
}

export function getDefaultDatabasePath(): string {
  return resolve(homedir(), DEFAULT_DB_RELATIVE_PATH)
}

export async function ensureDirectory(targetPath: string): Promise<void> {
  await fs.mkdir(targetPath, { recursive: true })
}

export async function createPowerSyncDatabase(options: CliDatabaseOptions = {}): Promise<PowerSyncDatabase> {
  const dbPath = options.dbPath ?? getDefaultDatabasePath()
  await ensureDirectory(dirname(dbPath))

  const database = new PowerSyncDatabase({
    schema: AppSchema,
    database: {
      dbFilename: dbPath,
      openWorker: (_, workerOptions) => new Worker(new URL('./worker.js', import.meta.url), workerOptions),
    },
  })

  await database.init()
  return database
}
