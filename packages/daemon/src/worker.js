import Database from 'better-sqlite3'
import { startPowerSyncWorker } from '@powersync/node/worker.js'

async function loadBetterSqlite3() {
  return Database
}

startPowerSyncWorker({
  loadBetterSqlite3,
})
