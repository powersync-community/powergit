export type PowerSyncImportStatus = 'queued' | 'running' | 'success' | 'error'

export type PowerSyncImportStepStatus = 'pending' | 'active' | 'done' | 'error'

export interface PowerSyncImportStep {
  id: string
  label: string
  status: PowerSyncImportStepStatus
  detail?: string | null
}

export type PowerSyncImportLogLevel = 'info' | 'warn' | 'error'

export interface PowerSyncImportLogEntry {
  id: string
  level: PowerSyncImportLogLevel
  message: string
  timestamp: string
}

export interface PowerSyncImportJobResult {
  orgId: string
  repoId: string
  branch?: string | null
  defaultBranch?: string | null
}

export interface PowerSyncImportJob {
  id: string
  status: PowerSyncImportStatus
  createdAt: string
  updatedAt: string
  repoUrl: string
  orgId: string
  repoId: string
  branch?: string | null
  steps: PowerSyncImportStep[]
  logs: PowerSyncImportLogEntry[]
  error?: string | null
  result?: PowerSyncImportJobResult | null
}
