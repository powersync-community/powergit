// Mock PowerSync Web for build compatibility
export class PowerSyncDatabase {
  constructor(config: any) {
    console.log('Mock PowerSyncDatabase created with config:', config)
  }
  
  async connect() {
    console.log('Mock PowerSyncDatabase connected')
  }
  
  async disconnect() {
    console.log('Mock PowerSyncDatabase disconnected')
  }
  
  get currentStatus() {
    return 'connected'
  }
  
  async execute(sql: string, params?: any[]) {
    console.log('Mock PowerSyncDatabase execute:', sql, params)
    return []
  }
  
  async getAll<T = any>(sql: string, params?: any[]): Promise<T[]> {
    console.log('Mock PowerSyncDatabase getAll:', sql, params)
    return []
  }
  
  async get<T = any>(sql: string, params?: any[]): Promise<T | null> {
    console.log('Mock PowerSyncDatabase get:', sql, params)
    return null
  }
  
  async writeTransaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
    console.log('Mock PowerSyncDatabase writeTransaction')
    return callback({} as any)
  }
  
  onChangeWithCallback(callback: any, options?: any) {
    console.log('Mock PowerSyncDatabase onChangeWithCallback')
    return () => {}
  }
  
  get triggers() {
    return {
      createDiffTrigger: async (config: any) => {
        console.log('Mock createDiffTrigger:', config)
        return () => {}
      }
    }
  }
}

export class Schema {
  constructor(public tables: Record<string, any>) {
    console.log('Mock Schema created with tables:', Object.keys(tables))
  }
}

export class Table {
  constructor(public columns: Record<string, any>) {
    console.log('Mock Table created with columns:', Object.keys(columns))
  }
}

export const column = {
  text: 'TEXT',
  integer: 'INTEGER',
  real: 'REAL',
  blob: 'BLOB'
}

export type AbstractPowerSyncDatabase = PowerSyncDatabase

export class WASQLiteOpenFactory {
  constructor() {
    console.log('Mock WASQLiteOpenFactory created')
  }
}

export class WASQLiteVFS {
  constructor() {
    console.log('Mock WASQLiteVFS created')
  }
}
