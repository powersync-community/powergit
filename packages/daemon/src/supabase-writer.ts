import { setTimeout as delay } from 'node:timers/promises';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { CrudTransaction, CrudEntry } from '@powersync/common';
import type { PowerSyncDatabase } from '@powersync/node';

export interface SupabaseWriterConfig {
  url: string;
  serviceRoleKey: string;
  schema?: string;
}

export interface SupabaseWriterOptions {
  database: PowerSyncDatabase;
  config: SupabaseWriterConfig;
  pollIntervalMs?: number;
  retryDelayMs?: number;
  batchSize?: number;
}

interface TableMetadata {
  table: string;
  conflictTarget: string;
  transform?: (row: Record<string, unknown>) => Record<string, unknown>;
}

const TABLES: Record<string, TableMetadata> = {
  refs: { table: 'raw_refs', conflictTarget: 'id' },
  commits: { table: 'raw_commits', conflictTarget: 'id' },
  file_changes: { table: 'raw_file_changes', conflictTarget: 'id' },
  objects: {
    table: 'raw_objects',
    conflictTarget: 'id',
  },
};

export class SupabaseWriter {
  private readonly database: PowerSyncDatabase;
  private readonly pollIntervalMs: number;
  private readonly retryDelayMs: number;
  private readonly batchSize: number;
  private readonly supabase: SupabaseClient;
  private running = false;
  private loop: Promise<void> | null = null;

  constructor(options: SupabaseWriterOptions) {
    this.database = options.database;
    this.pollIntervalMs = options.pollIntervalMs ?? 750;
    this.retryDelayMs = options.retryDelayMs ?? 1_500;
    this.batchSize = Math.max(1, options.batchSize ?? 32);
    this.supabase = createClient(options.config.url, options.config.serviceRoleKey, {
      auth: { persistSession: false },
      db: { schema: options.config.schema ?? 'public' },
      global: {
        headers: {
          Authorization: `Bearer ${options.config.serviceRoleKey}`,
        },
      },
    }) as SupabaseClient;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.runLoop().catch((error) => {
      console.error('[powersync-daemon] supabase writer stopped unexpectedly', error);
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loop) {
      await this.loop.catch(() => undefined);
      this.loop = null;
    }
  }

  private async runLoop(): Promise<void> {
    while (this.running) {
      const transactions = await this.fetchTransactions();
      if (transactions.length === 0) {
        await delay(this.pollIntervalMs).catch(() => undefined);
        continue;
      }

      for (const tx of transactions) {
        if (!this.running) return;
        let processed = false;
        while (!processed && this.running) {
          try {
            await this.applyTransaction(tx);
            await tx.complete();
            processed = true;
          } catch (error) {
            console.error('[powersync-daemon] supabase writer failed to apply transaction', error);
            await delay(this.retryDelayMs).catch(() => undefined);
          }
        }
      }
    }
  }

  private async fetchTransactions(): Promise<CrudTransaction[]> {
    const collected: CrudTransaction[] = [];
    for (let i = 0; i < this.batchSize; i += 1) {
      const next = await this.database.getNextCrudTransaction();
      if (!next) break;
      collected.push(next);
    }
    return collected;
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
        console.warn(`[powersync-daemon] supabase writer skipping unknown table ${tableName}`);
        continue;
      }

      const upserts: Record<string, unknown>[] = [];
      const deletes: Record<string, unknown>[] = [];

      for (const entry of entries) {
        const row = this.buildRow(entry);
        if (!row) continue;

        if (entry.op === 'DELETE') {
          deletes.push(row);
        } else {
          const transformed = metadata.transform ? metadata.transform(row) : row;
          upserts.push(transformed);
        }
      }

      if (upserts.length > 0) {
        await this.applyUpserts(metadata.table, metadata.conflictTarget, upserts);
      }
      if (deletes.length > 0) {
        await this.applyDeletes(metadata.table, deletes);
      }
    }
  }

  private buildRow(entry: CrudEntry): Record<string, unknown> | null {
    const source =
      entry.op === 'DELETE'
        ? entry.previousValues ?? entry.opData
        : entry.opData ?? entry.previousValues;
    const base: Record<string, unknown> = source && typeof source === 'object' ? { ...source } : {};
    if (typeof base.id !== 'string' && entry.id) {
      base.id = entry.id;
    }
    if (typeof base.id !== 'string') return null;
    return base;
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
    const { error } = await this.supabase.from(table).upsert(sanitized, { onConflict: conflictTarget });
    if (error) {
      throw new Error(`Supabase upsert failed for ${table}: ${error.message}`);
    }
  }

  private async applyDeletes(table: string, rows: Record<string, unknown>[]): Promise<void> {
    for (const row of rows) {
      const id = typeof row.id === 'string' ? row.id : null;
      if (!id) continue;
      const { error } = await this.supabase.from(table).delete().match({ id });
      if (error) {
        throw new Error(`Supabase delete failed for ${table}: ${error.message}`);
      }
    }
  }
}
