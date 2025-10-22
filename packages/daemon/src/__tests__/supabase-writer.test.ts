import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UpdateType, type CrudEntry, type CrudTransaction } from '@powersync/common';
import type { PowerSyncDatabase } from '@powersync/node';

const createClientMock = vi.fn();

interface SupabaseUpsertCall {
  table: string;
  rows: Record<string, unknown>[];
  options?: Record<string, unknown>;
}

interface SupabaseDeleteCall {
  table: string;
  filters: Record<string, unknown>;
}

type SupabaseStub = ReturnType<typeof createSupabaseDouble>;

let currentSupabaseStub: SupabaseStub = createSupabaseDouble();

vi.mock('@supabase/supabase-js', () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

// Import after mocking.
import { SupabaseWriter } from '../supabase-writer.js';

function createSupabaseDouble() {
  const upsertCalls: SupabaseUpsertCall[] = [];
  const deleteCalls: SupabaseDeleteCall[] = [];
  return {
    upsertCalls,
    deleteCalls,
    from(table: string) {
      return {
        upsert: async (rows: Record<string, unknown>[], options?: Record<string, unknown>) => {
          upsertCalls.push({ table, rows, options });
          return { error: null };
        },
        delete: () => ({
          match: async (filters: Record<string, unknown>) => {
            deleteCalls.push({ table, filters });
            return { error: null };
          },
          in: async (column: string, values: string[]) => {
            deleteCalls.push({ table, filters: { column, values } });
            return { error: null };
          },
        }),
      };
    },
  };
}

class FakeDatabase {
  private readonly queue: CrudTransaction[];

  public readonly getNextCrudTransaction = vi.fn(async () => this.queue.shift() ?? null);

  constructor(transactions: CrudTransaction[]) {
    this.queue = [...transactions];
  }
}

function createEntry(partial: Partial<CrudEntry>): CrudEntry {
  return {
    table: '',
    id: '',
    clientId: 0,
    op: UpdateType.PUT,
    opData: {},
    previousValues: undefined,
    metadata: undefined,
    transactionId: undefined,
    ...partial,
  } as CrudEntry;
}

function createTransaction(entries: CrudEntry[]) {
  const complete = vi.fn(async () => undefined);
  const tx = {
    crud: entries,
    complete,
    transactionId: 1,
  } as unknown as CrudTransaction;
  return { tx, complete };
}

async function waitForExpect(assertFn: () => void, timeoutMs = 1_000, intervalMs = 20): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      assertFn();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

describe('SupabaseWriter', () => {
  beforeEach(() => {
    currentSupabaseStub = createSupabaseDouble();
    createClientMock.mockReset();
    createClientMock.mockImplementation(() => currentSupabaseStub);
  });

  it('upserts PowerSync mutations to Supabase with pack bytes normalized', async () => {
    const base64Pack = Buffer.from('fake pack').toString('base64');
    const packEntry = createEntry({
      table: 'objects',
      op: UpdateType.PUT,
      opData: {
        id: 'demo/infra/abcdef1234567890',
        org_id: 'demo',
        repo_id: 'infra',
        pack_oid: 'abcdef1234567890',
        pack_bytes: base64Pack,
        created_at: '2024-01-01T00:00:00Z',
      },
    });

    const refEntry = createEntry({
      table: 'refs',
      op: UpdateType.PUT,
      opData: {
        id: 'demo/infra/refs/heads/main',
        org_id: 'demo',
        repo_id: 'infra',
        name: 'refs/heads/main',
        target_sha: '1111111111111111111111111111111111111111',
        updated_at: '2024-01-01T00:00:00Z',
      },
    });

    const deleteEntry = createEntry({
      table: 'refs',
      op: UpdateType.DELETE,
      previousValues: {
        id: 'demo/infra/refs/heads/old',
        org_id: 'demo',
        repo_id: 'infra',
        name: 'refs/heads/old',
        target_sha: '0000000000000000000000000000000000000000',
        updated_at: '2023-12-31T00:00:00Z',
      },
    });

    const { tx, complete } = createTransaction([packEntry, refEntry, deleteEntry]);
    const database = new FakeDatabase([tx]);

    const writer = new SupabaseWriter({
      database: database as unknown as PowerSyncDatabase,
      config: { url: 'http://example.local', apiKey: 'service-key' },
      pollIntervalMs: 10,
      retryDelayMs: 50,
      batchSize: 4,
    });

    writer.start();

    await waitForExpect(() => {
      expect(complete).toHaveBeenCalledTimes(1);
    });

    await writer.stop();

    const packCall = currentSupabaseStub.upsertCalls.find((call) => call.table === 'objects');
    expect(packCall).toBeTruthy();
    expect(packCall?.rows).toHaveLength(1);
    const packRow = packCall?.rows[0] ?? {};
    expect(packRow).toMatchObject({
      id: 'demo/infra/abcdef1234567890',
      org_id: 'demo',
      repo_id: 'infra',
      pack_oid: 'abcdef1234567890',
      created_at: '2024-01-01T00:00:00Z',
    });
    expect(packRow.pack_bytes).toBe(base64Pack);
    expect(packCall?.options).toMatchObject({ onConflict: 'id' });

    const refUpsert = currentSupabaseStub.upsertCalls.find((call) => call.table === 'refs');
    expect(refUpsert).toBeTruthy();
    expect(refUpsert?.rows[0]).toMatchObject({
      id: 'demo/infra/refs/heads/main',
      org_id: 'demo',
      repo_id: 'infra',
      name: 'refs/heads/main',
      target_sha: '1111111111111111111111111111111111111111',
    });

    const deleteCall = currentSupabaseStub.deleteCalls.find((call) => call.table === 'refs');
    expect(deleteCall).toBeTruthy();
    expect(deleteCall?.filters).toEqual({
      column: 'id',
      values: ['demo/infra/refs/heads/old'],
    });

    expect(createClientMock).toHaveBeenCalledWith('http://example.local', 'service-key', expect.any(Object));
  });

  it('merges previous values when upserting partial updates', async () => {
    const partialUpdate = createEntry({
      table: 'refs',
      op: UpdateType.PUT,
      id: 'demo/infra/refs/heads/dev',
      opData: {
        id: 'demo/infra/refs/heads/dev',
        target_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        updated_at: '2024-01-02T00:00:00Z',
      },
      previousValues: {
        id: 'demo/infra/refs/heads/dev',
        org_id: 'demo',
        repo_id: 'infra',
        name: 'refs/heads/dev',
        target_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        updated_at: '2024-01-01T00:00:00Z',
      },
    });

    const { tx, complete } = createTransaction([partialUpdate]);
    const database = new FakeDatabase([tx]);

    const writer = new SupabaseWriter({
      database: database as unknown as PowerSyncDatabase,
      config: { url: 'http://example.local', apiKey: 'service-key' },
      pollIntervalMs: 5,
    });

    writer.start();

    await waitForExpect(() => {
      expect(complete).toHaveBeenCalledTimes(1);
    });

    await writer.stop();

    const refUpsert = currentSupabaseStub.upsertCalls.find((call) => call.table === 'refs');
    expect(refUpsert).toBeTruthy();
    expect(refUpsert?.rows).toHaveLength(1);
    expect(refUpsert?.rows[0]).toMatchObject({
      id: 'demo/infra/refs/heads/dev',
      org_id: 'demo',
      repo_id: 'infra',
      name: 'refs/heads/dev',
      target_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      updated_at: '2024-01-02T00:00:00Z',
    });
  });
});
