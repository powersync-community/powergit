import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { CrudEntry, CrudTransaction } from '@powersync/common';
import type { AbstractPowerSyncDatabase, PowerSyncDatabase } from '@powersync/node';

export interface SupabaseWriterConfig {
  url: string;
  apiKey: string;
  schema?: string;
  accessToken?: string;
}

export interface SupabaseWriterOptions {
  database?: PowerSyncDatabase;
  config: SupabaseWriterConfig;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  batchSize?: number;
  failureThreshold?: number;
}

interface TableMetadata {
  table: string;
  conflictTarget: string;
}

const TABLES: Record<string, TableMetadata> = {
  refs: { table: 'refs', conflictTarget: 'id' },
  commits: { table: 'commits', conflictTarget: 'id' },
  file_changes: { table: 'file_changes', conflictTarget: 'id' },
  objects: { table: 'objects', conflictTarget: 'id' },
};

export class SupabaseWriter {
  private readonly database?: PowerSyncDatabase;
  private readonly supabase: SupabaseClient;
  private readonly apiKey: string;
  private readonly schema: string;
  private accessToken: string | null;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly failureThreshold: number;
  private readonly debug: boolean;
  private pollTimer: NodeJS.Timeout | null = null;
  private running = false;
  private inFlight: Promise<void> | null = null;
  private consecutiveFailures = 0;

  constructor(options: SupabaseWriterOptions) {
    this.database = options.database;
    const { apiKey, accessToken } = options.config;
    this.apiKey = apiKey;
    this.schema = options.config.schema ?? 'public';
    this.accessToken = accessToken && accessToken.trim().length > 0 ? accessToken.trim() : null;
    this.debug = (process.env.POWERSYNC_SUPABASE_WRITER_DEBUG ?? 'false').toLowerCase() === 'true';

    const scopedFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const headers = new Headers((init && init.headers) ?? {});
      headers.set('apikey', this.apiKey);
      const bearer = this.accessToken ?? this.apiKey;
      headers.set('Authorization', `Bearer ${bearer}`);
      if (this.schema && this.schema !== 'public') {
        headers.set('Accept-Profile', this.schema);
        headers.set('Content-Profile', this.schema);
      }
      return fetch(input, { ...init, headers });
    };

    this.supabase = createClient(options.config.url, apiKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: this.schema },
      global: {
        fetch: scopedFetch,
      },
    }) as SupabaseClient;
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.retryDelayMs = options.retryDelayMs ?? 5_000;
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 5);
  }

  setAccessToken(token: string | null | undefined): void {
    const trimmed = typeof token === 'string' ? token.trim() : '';
    this.accessToken = trimmed.length > 0 ? trimmed : null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNext(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.inFlight) {
      try {
        await this.inFlight;
      } catch {
        // ignore errors during shutdown
      } finally {
        this.inFlight = null;
      }
    }
  }

  private debugLog(message: string, details?: Record<string, unknown>): void {
    if (!this.debug) return;
    if (details) {
      console.debug('[powersync-daemon] supabase writer debug:', message, details);
    } else {
      console.debug('[powersync-daemon] supabase writer debug:', message);
    }
  }

  private sampleIds(rows: Record<string, unknown>[]): string[] {
    return rows
      .map((row) => (typeof row.id === 'string' ? row.id : row.id != null ? String(row.id) : null))
      .filter((id): id is string => Boolean(id))
      .slice(0, 5);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      const execute = async () => {
        try {
          await this.uploadPending();
          this.consecutiveFailures = 0;
          if (this.running) {
            this.scheduleNext(this.pollIntervalMs);
          }
        } catch (error) {
          console.error('[powersync-daemon] supabase upload loop failed', error);
          this.consecutiveFailures += 1;
          if (this.consecutiveFailures >= this.failureThreshold) {
            console.error(
              `[powersync-daemon] supabase writer aborting after ${this.consecutiveFailures} consecutive failures`,
            );
            this.running = false;
            throw error;
          }
          if (this.running) {
            this.scheduleNext(this.retryDelayMs);
          }
        } finally {
          this.inFlight = null;
        }
      };
      this.inFlight = execute();
    }, Math.max(0, delayMs));
  }

  async uploadPending(db?: AbstractPowerSyncDatabase): Promise<void> {
    const targetDb = (db as PowerSyncDatabase | undefined) ?? this.database;
    if (!targetDb) {
      throw new Error('SupabaseWriter requires a database instance');
    }

    while (true) {
      const tx = await targetDb.getNextCrudTransaction();
      if (!tx) break;

      try {
        await this.applyTransaction(tx);
        await tx.complete();
      } catch (error) {
        console.error('[powersync-daemon] supabase upload failed', error);
        throw error;
      }
    }
  }

  private async applyTransaction(tx: CrudTransaction): Promise<void> {
    if (!Array.isArray(tx.crud) || tx.crud.length === 0) {
      return;
    }

    const grouped = new Map<string, CrudEntry[]>();
    for (const entry of tx.crud) {
      if (!entry?.table) continue;
      const target = grouped.get(entry.table) ?? [];
      target.push(entry);
      grouped.set(entry.table, target);
    }

    for (const [tableName, entries] of grouped.entries()) {
      const metadata = TABLES[tableName];
      if (!metadata) {
        console.warn(`[powersync-daemon] skipping Supabase sync for unknown table ${tableName}`);
        continue;
      }

      const upserts = new Map<string, Record<string, unknown>>();
      const deletes = new Map<string, Record<string, unknown>>();

      for (const entry of entries) {
        const row = this.buildRow(entry);
        if (!row) continue;

        if (entry.op === 'DELETE') {
          deletes.set(String(row.id), row);
        } else {
          upserts.set(String(row.id), row);
        }
      }

      const upsertRows = Array.from(upserts.values());
      if (upsertRows.length > 0) {
        this.debugLog(`upserting ${upsertRows.length} rows`, {
          table: metadata.table,
          ids: this.sampleIds(upsertRows),
        });
        try {
          await this.applyUpserts(metadata.table, metadata.conflictTarget, upsertRows);
        } catch (error) {
          this.debugLog('upsert failed', {
            table: metadata.table,
            ids: this.sampleIds(upsertRows),
          });
          throw error;
        }
      }

      const deleteRows = Array.from(deletes.values());
      if (deleteRows.length > 0) {
        this.debugLog(`deleting ${deleteRows.length} rows`, {
          table: metadata.table,
          ids: this.sampleIds(deleteRows),
        });
        try {
          await this.applyDeletes(metadata.table, deleteRows);
        } catch (error) {
          this.debugLog('delete failed', {
            table: metadata.table,
            ids: this.sampleIds(deleteRows),
          });
          throw error;
        }
      }
    }
  }

  private buildRow(entry: CrudEntry): Record<string, unknown> | null {
    const merged: Record<string, unknown> = {};
    const merge = (value: unknown) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return;
      Object.assign(merged, value as Record<string, unknown>);
    };
    if (entry.op === 'DELETE') {
      merge(entry.previousValues);
      merge(entry.opData);
    } else {
      merge(entry.previousValues);
      merge(entry.opData);
    }
    if (typeof merged.id !== 'string' || merged.id.length === 0) {
      if (entry.id && typeof entry.id === 'string' && entry.id.length > 0) {
        merged.id = entry.id;
      }
    }
    if (typeof merged.id !== 'string' || merged.id.length === 0) {
      this.debugLog('skipping entry without id', {
        table: entry.table ?? null,
        op: entry.op,
        entryId: entry.id ?? null,
      });
      return null;
    }
    this.debugLog('built row', {
      table: entry.table ?? null,
      id: merged.id,
      op: entry.op,
    });
    return merged;
  }

  private async applyUpserts(table: string, conflictTarget: string, rows: Record<string, unknown>[]): Promise<void> {
    const sanitized = rows.map((row) => {
      const copy = { ...row };
      if (copy.created_at instanceof Date) {
        copy.created_at = (copy.created_at as Date).toISOString();
      }
      if (copy.updated_at instanceof Date) {
        copy.updated_at = (copy.updated_at as Date).toISOString();
      }
      return copy;
    });

    const maxRowsPerBatch = table === 'objects' ? 1 : 25;
    for (let index = 0; index < sanitized.length; index += maxRowsPerBatch) {
      const slice = sanitized.slice(index, index + maxRowsPerBatch);
      const { error } = await this.supabase.from(table).upsert(slice, { onConflict: conflictTarget });
      if (error) {
        throw new Error(`Supabase upsert failed for ${table}: ${error.message}`);
      }
    }
  }

  private async applyDeletes(table: string, rows: Record<string, unknown>[]): Promise<void> {
    const ids = rows
      .map((row) => (typeof row.id === 'string' ? row.id : null))
      .filter((id): id is string => Boolean(id));

    if (ids.length === 0) {
      return;
    }

    const maxEncodedLength = 1200;
    let currentBatch: string[] = [];
    let currentLength = 0;

    const flush = async () => {
      if (currentBatch.length === 0) return;
      const { error } = await this.supabase
        .from(table)
        .delete()
        .in('id', currentBatch);
      if (error) {
        throw new Error(`Supabase delete failed for ${table}: ${error.message}`);
      }
      currentBatch = [];
      currentLength = 0;
    };

    for (const id of ids) {
      const encodedLength = encodeURIComponent(id).length + 1;
      const projected = currentLength + encodedLength;
      if (currentBatch.length > 0 && projected > maxEncodedLength) {
        await flush();
      }
      currentBatch.push(id);
      currentLength += encodedLength;
    }

    if (currentBatch.length > 0) {
      await flush();
    }
  }
}
