import { fileURLToPath } from 'node:url';
import type { PowerSyncDatabase, SyncStreamSubscription } from '@powersync/node';
import { resolveDaemonConfig, type ResolveDaemonConfigOptions } from './config.js';
import { DaemonPowerSyncConnector } from './connector.js';
import { connectWithSchemaRecovery, createPowerSyncDatabase } from './database.js';
import { ensureLocalSchema } from './local-schema.js';
import { createDaemonServer } from './server.js';
import { getLatestPack, listRefs, listRepos, persistPush } from './queries.js';
import type { PersistPushResult, PushUpdateRow } from './queries.js';
import { SupabaseWriter } from './supabase-writer.js';

function normalizePackBytes(raw: unknown): { base64: string; size: number } | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const trimmed = raw.trim();

  if (trimmed.startsWith('\\x')) {
    const hex = trimmed.slice(2);
    if (/^[0-9a-fA-F]+$/.test(hex) && hex.length % 2 === 0) {
      const buffer = Buffer.from(hex, 'hex');
      if (buffer.length === 0) return null;
      return { base64: buffer.toString('base64'), size: buffer.length };
    }
  }

  if (isLikelyBase64(trimmed)) {
    try {
      const buffer = Buffer.from(trimmed, 'base64');
      if (buffer.length === 0) return null;
      return { base64: buffer.toString('base64'), size: buffer.length };
    } catch {
      // fall through to binary conversion
    }
  }

  const fallbackBuffer = Buffer.from(trimmed, 'binary');
  if (fallbackBuffer.length === 0) return null;
  return { base64: fallbackBuffer.toString('base64'), size: fallbackBuffer.length };
}

function isLikelyBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function buildPushErrorResults(updates: PushUpdateRow[], message: string) {
  return Object.fromEntries(
    updates.map((update) => [update.dst ?? '', { status: 'error' as const, message }]),
  );
}

async function subscribeToInitialStreams(
  streamIds: readonly string[],
  database: PowerSyncDatabase,
): Promise<SyncStreamSubscription[]> {
  if (streamIds.length === 0) return [];

  const subscriptions: SyncStreamSubscription[] = [];
  for (const streamId of streamIds) {
    try {
      const stream = database.syncStream(streamId);
      const subscription = await stream.subscribe();
      subscriptions.push(subscription);
      console.info(`[powersync-daemon] subscribed stream ${streamId}`);
    } catch (error) {
      console.error(`[powersync-daemon] failed to subscribe stream ${streamId}`, error);
    }
  }
  return subscriptions;
}

async function closeSubscriptions(subscriptions: SyncStreamSubscription[]): Promise<void> {
  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        subscription.unsubscribe();
      } catch (error) {
        console.warn('[powersync-daemon] failed to unsubscribe stream', error);
      }
    }),
  );
}

export async function startDaemon(options: ResolveDaemonConfigOptions = {}): Promise<void> {
  const config = await resolveDaemonConfig(options);
  console.info(`[powersync-daemon] starting (db: ${config.dbPath})`);

  const startedAt = new Date();
  const database = await createPowerSyncDatabase({ dbPath: config.dbPath });
  const connector = new DaemonPowerSyncConnector({
    endpoint: config.endpoint,
    token: config.token,
  });

  await connectWithSchemaRecovery(database, {
    connector,
    dbPath: config.dbPath,
    includeDefaultStreams: false,
  });

  await ensureLocalSchema(database);

  const connectedAt = new Date();
  console.info('[powersync-daemon] connected to PowerSync backend');

  let running = true;
  let streamCount = 0;
  const abortController = new AbortController();
  const requestShutdown = (reason: string) => {
    if (abortController.signal.aborted) return;
    running = false;
    console.info(`[powersync-daemon] shutdown requested (${reason}); shutting down`);
    abortController.abort();
  };

  const subscriptions = await subscribeToInitialStreams(config.initialStreams, database);
  streamCount = subscriptions.length;

  const supabaseWriter = config.supabase
    ? new SupabaseWriter({
        database,
        config: config.supabase,
      })
    : null;
  if (supabaseWriter) {
    console.info('[powersync-daemon] enabling Supabase writer');
    supabaseWriter.start();
  }

  const server = createDaemonServer({
    host: config.host,
    port: config.port,
    getStatus: () => ({
      startedAt: startedAt.toISOString(),
      connected: running,
      connectedAt: connectedAt.toISOString(),
      streamCount,
    }),
    onShutdownRequested: () => {
      requestShutdown('rpc');
    },
    fetchRefs: ({ orgId, repoId, limit }) => listRefs(database, { orgId, repoId, limit }),
    listRepos: ({ orgId, limit }) => listRepos(database, { orgId, limit }),
    fetchPack: async ({ orgId, repoId }) => {
      let packRow: Awaited<ReturnType<typeof getLatestPack>> = null;
      try {
        packRow = await getLatestPack(database, { orgId, repoId });
      } catch (error) {
        console.error(
          `[powersync-daemon] pack lookup failed for ${orgId}/${repoId}`,
          error,
        );
        return null;
      }
      if (!packRow) return null;
      const normalized = normalizePackBytes(packRow.pack_bytes);
      if (!normalized) {
        console.warn(
          `[powersync-daemon] pack bytes missing or invalid for ${orgId}/${repoId} (oid: ${packRow.pack_oid ?? 'unknown'})`,
        );
        return null;
      }
      return {
        packBase64: normalized.base64,
        encoding: 'base64',
        packOid: packRow.pack_oid,
        createdAt: packRow.created_at,
        size: normalized.size,
      };
    },
    pushPack: async ({ orgId, repoId, payload }) => {
      try {
        const result = await persistPush(database, {
          orgId,
          repoId,
          updates: payload.updates,
          packBase64: payload.packBase64,
          packEncoding: payload.packEncoding,
          packOid: payload.packOid,
          summary: payload.summary ?? undefined,
          dryRun: payload.dryRun === true,
        });
        if (result.packSize !== undefined) {
          console.info(
            `[powersync-daemon] stored pack for ${orgId}/${repoId} (oid: ${result.packOid ?? 'unknown'}, size: ${result.packSize} bytes)`,
          );
        }
        return result;
      } catch (error) {
        console.error(`[powersync-daemon] failed to persist push for ${orgId}/${repoId}`, error);
        const message = error instanceof Error ? error.message : 'Push failed';
        return {
          ok: false,
          message,
          results: buildPushErrorResults(payload.updates, message),
        } as PersistPushResult & { message: string };
      }
    },
  });

  const address = await server.listen();
  const listenHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  console.info(`[powersync-daemon] listening on http://${listenHost}:${address.port}`);

  process.once('SIGINT', () => requestShutdown('SIGINT'));
  process.once('SIGTERM', () => requestShutdown('SIGTERM'));

  process.stdin.resume();

  await new Promise<void>((resolve) => {
    if (abortController.signal.aborted) {
      resolve();
      return;
    }
    abortController.signal.addEventListener('abort', () => resolve(), { once: true });
  });

  await closeSubscriptions(subscriptions);
  if (supabaseWriter) {
    await supabaseWriter.stop().catch((error) => {
      console.warn('[powersync-daemon] failed to stop Supabase writer', error);
    });
  }
  await database.close({ disconnect: true }).catch((error) => {
    console.warn('[powersync-daemon] failed to close database', error);
  });
  await server.close().catch((error) => {
    console.warn('[powersync-daemon] failed to stop HTTP server', error);
  });

  if (typeof process.stdin?.pause === 'function') {
    process.stdin.pause();
  }

  console.info('[powersync-daemon] shutdown complete');
}

const executedDirectly = process.argv[1] === fileURLToPath(import.meta.url);

if (executedDirectly) {
  startDaemon().catch((error) => {
    console.error('[powersync-daemon] fatal error', error);
    process.exitCode = 1;
  });
}
