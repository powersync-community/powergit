import { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { PowerSyncDatabase, SyncStreamSubscription } from '@powersync/node';
import { resolveDaemonConfig, type ResolveDaemonConfigOptions } from './config.js';
import { DaemonPowerSyncConnector } from './connector.js';
import { connectWithSchemaRecovery, createPowerSyncDatabase } from './database.js';
import {
  createDaemonServer,
  type StreamSubscriptionTarget,
  type SubscribeStreamsResult,
  type UnsubscribeStreamsResult,
} from './server.js';
import { getLatestPack, getRepoSummary, listRefs, listRepos, persistPush } from './queries.js';
import type { PersistPushResult, PushUpdateRow } from './queries.js';
import { ensureRawTables } from './raw-table-migration.js';
import { ensureLocalSchema } from './local-schema.js';
import { SupabaseWriter } from './supabase-writer.js';
import { GithubImportManager } from './importer.js';

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

interface NormalizedStreamTarget {
  id: string;
  params: Record<string, unknown> | null;
}

function normalizeParameters(value: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!value) return null;
  const sortedKeys = Object.keys(value).filter((key) => key.trim().length > 0).sort();
  if (sortedKeys.length === 0) return null;
  const normalized: Record<string, unknown> = {};
  for (const key of sortedKeys) {
    const raw = value[key];
    if (raw === undefined) continue;
    normalized[key.trim()] = raw;
  }
  return Object.keys(normalized).length > 0 ? normalized : null;
}

function buildStreamKey(target: NormalizedStreamTarget): string {
  if (!target.params || Object.keys(target.params).length === 0) {
    return target.id;
  }
  const query = Object.entries(target.params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value ?? ''))}`)
    .join('&');
  return `${target.id}?${query}`;
}

async function assertPortAvailable(host: string, port: number): Promise<void> {
  const probeHost = host === '0.0.0.0' ? '127.0.0.1' : host === '::' ? '::1' : host;
  await new Promise<void>((resolve, reject) => {
    const socket = new Socket();
    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };
    const fail = (error: Error) => {
      cleanup();
      reject(error);
    };

    socket.setTimeout(300);
    socket.once('connect', () => {
      const friendly = new Error(
        `[powersync-daemon] port ${port} on ${host} is already in use. Stop the existing daemon or set POWERSYNC_DAEMON_PORT to a free port.`,
      ) as NodeJS.ErrnoException;
      friendly.code = 'EADDRINUSE';
      fail(friendly);
    });
    socket.once('timeout', () => {
      cleanup();
      resolve();
    });
    socket.once('error', (rawError) => {
      const error = rawError as NodeJS.ErrnoException;
      if (error?.code === 'ECONNREFUSED' || error?.code === 'EHOSTUNREACH' || error?.code === 'ENETUNREACH') {
        cleanup();
        resolve();
      } else {
        fail(error ?? new Error('Port probe failed'));
      }
    });

    try {
      socket.connect(port, probeHost);
    } catch (error) {
      fail(error as Error);
    }
  });
}

class StreamSubscriptionManager {
  private readonly active = new Map<string, SyncStreamSubscription>();
  private readonly targets = new Map<string, NormalizedStreamTarget>();

  constructor(private readonly database: PowerSyncDatabase) {}

  private normalize(target: StreamSubscriptionTarget): NormalizedStreamTarget | null {
    const id = typeof target.id === 'string' ? target.id.trim() : '';
    if (!id) return null;
    const params =
      target.parameters && typeof target.parameters === 'object' && !Array.isArray(target.parameters)
        ? normalizeParameters(target.parameters as Record<string, unknown>)
        : null;
    return { id, params };
  }

  getActiveCount(): number {
    return this.active.size;
  }

  listKeys(): string[] {
    return Array.from(this.targets.keys());
  }

  async subscribe(targets: StreamSubscriptionTarget[]): Promise<SubscribeStreamsResult> {
    const added: string[] = [];
    const alreadyActive: string[] = [];
    const queued: string[] = [];

    for (const rawTarget of targets) {
      const normalized = this.normalize(rawTarget);
      if (!normalized) continue;
      const key = buildStreamKey(normalized);
      if (this.active.has(key)) {
        alreadyActive.push(key);
        continue;
      }
      try {
        const stream = this.database.syncStream(normalized.id, normalized.params ?? undefined);
        const subscription = await stream.subscribe();
        this.active.set(key, subscription);
        this.targets.set(key, normalized);
        added.push(key);
        console.info(`[powersync-daemon] subscribed stream ${key}`);
      } catch (error) {
        console.error(`[powersync-daemon] failed to subscribe stream ${key}`, error);
      }
    }

    return { added, alreadyActive, queued };
  }

  async unsubscribe(targets: StreamSubscriptionTarget[]): Promise<UnsubscribeStreamsResult> {
    const removed: string[] = [];
    const notFound: string[] = [];

    for (const rawTarget of targets) {
      const normalized = this.normalize(rawTarget);
      if (!normalized) continue;
      const key = buildStreamKey(normalized);
      const subscription = this.active.get(key);
      if (!subscription) {
        notFound.push(key);
        continue;
      }
      try {
        subscription.unsubscribe();
      } catch (error) {
        console.warn('[powersync-daemon] failed to unsubscribe stream', error);
      }
      this.active.delete(key);
      this.targets.delete(key);
      removed.push(key);
    }

    return { removed, notFound };
  }

  async closeAll(): Promise<void> {
    await Promise.all(
      Array.from(this.active.values()).map(async (subscription) => {
        try {
          subscription.unsubscribe();
        } catch (error) {
          console.warn('[powersync-daemon] failed to unsubscribe stream', error);
        }
      }),
    );
    this.active.clear();
    this.targets.clear();
  }
}

export async function startDaemon(options: ResolveDaemonConfigOptions = {}): Promise<void> {
  const config = await resolveDaemonConfig(options);
  await assertPortAvailable(config.host, config.port);
  console.info(`[powersync-daemon] starting (db: ${config.dbPath})`);

  let authToken: string | null = config.token ?? null;
  let authEndpoint: string | null = config.endpoint ?? null;
  let authExpiresAt: string | null = null;
  let authMetadata: Record<string, unknown> | null = null;

  const buildAuthContext = (): Record<string, unknown> | null => {
    const context: Record<string, unknown> = {};
    if (authEndpoint) {
      context.endpoint = authEndpoint;
    }
    if (authMetadata) {
      Object.assign(context, authMetadata);
    }
    return Object.keys(context).length > 0 ? context : null;
  };

  const startedAt = new Date();
  const database = await createPowerSyncDatabase({ dbPath: config.dbPath });
  await ensureRawTables(database, { verbose: true });
  await ensureLocalSchema(database);
  const subscriptionManager = new StreamSubscriptionManager(database);
  const daemonBaseUrl = `http://127.0.0.1:${config.port}`;
  const importManager = new GithubImportManager({
    daemonBaseUrl,
    subscribeStreams: async (targets) => {
      await subscriptionManager.subscribe(targets);
    },
  });

  const supabaseUrl = process.env.POWERSYNC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? null;
  const supabaseServiceRole =
    process.env.POWERSYNC_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY ?? null;
  const supabaseAnonKey =
    process.env.POWERSYNC_SUPABASE_ANON_KEY ?? process.env.POWERSYNC_SUPABASE_PUBLIC_KEY ?? process.env.SUPABASE_ANON_KEY ?? null;
  const supabaseSchema = process.env.POWERSYNC_SUPABASE_SCHEMA ?? process.env.SUPABASE_DB_SCHEMA ?? undefined;
  const supabaseWriterDisabled = (process.env.POWERSYNC_DISABLE_SUPABASE_WRITER ?? '').toLowerCase() === 'true';

  let supabaseWriter: SupabaseWriter | null = null;
  if (!supabaseWriterDisabled) {
    if (!supabaseUrl) {
      throw new Error(
        '[powersync-daemon] Supabase writer requires POWERSYNC_SUPABASE_URL (or SUPABASE_URL). Set POWERSYNC_DISABLE_SUPABASE_WRITER=true to run without Supabase replication.',
      );
    }

    const supabaseApiKey = supabaseServiceRole ?? supabaseAnonKey;
    if (!supabaseApiKey) {
      throw new Error(
        '[powersync-daemon] Supabase writer requires either POWERSYNC_SUPABASE_SERVICE_ROLE_KEY or POWERSYNC_SUPABASE_ANON_KEY. Set POWERSYNC_DISABLE_SUPABASE_WRITER=true to run without Supabase replication.',
      );
    }

    const usingServiceRole = Boolean(supabaseServiceRole);
    if (!usingServiceRole) {
      console.warn(
        '[powersync-daemon] Supabase writer running in UNSAFE mode — using anon/public key for writes. Configure POWERSYNC_SUPABASE_SERVICE_ROLE_KEY to lock this down.',
      );
    }

    supabaseWriter = new SupabaseWriter({
      database,
      config: {
        url: supabaseUrl,
        apiKey: supabaseApiKey,
        schema: supabaseSchema,
        accessToken: authToken ?? undefined,
      },
    });
    supabaseWriter.setAccessToken(authToken);
    if (authToken) {
      supabaseWriter.start();
      console.info(
        `[powersync-daemon] Supabase writer started (${usingServiceRole ? 'service-role key' : 'anon/public key'})`,
      );
    } else {
      console.info(
        `[powersync-daemon] Supabase writer initialised (${usingServiceRole ? 'service-role key' : 'anon/public key'}) — waiting for PowerSync auth before starting`,
      );
    }
  } else {
    console.info('[powersync-daemon] Supabase writer explicitly disabled (POWERSYNC_DISABLE_SUPABASE_WRITER=true)');
  }
  const connector = new DaemonPowerSyncConnector({
    credentialsProvider: async () => {
      if (authEndpoint && authToken) {
        return { endpoint: authEndpoint, token: authToken };
      }
      return null;
    },
  });

  let running = true;
  let connected = false;
  let connectedAt: Date | null = null;
  let connectPromise: Promise<void> | null = null;
  const abortController = new AbortController();
  const requestShutdown = (reason: string) => {
    if (abortController.signal.aborted) return;
    running = false;
    console.info(`[powersync-daemon] shutdown requested (${reason}); shutting down`);
    abortController.abort();
  };

  const scheduleConnect = (reason: string) => {
    if (!authEndpoint || !authToken) {
      console.warn(`[powersync-daemon] skipping PowerSync connect (${reason}) — credentials missing`);
      connected = false;
      return;
    }
    if (connectPromise) {
      return;
    }
    console.info(`[powersync-daemon] connecting to PowerSync backend (${reason})`);
    connected = false;
    const task = (async () => {
      try {
        await connectWithSchemaRecovery(database, {
          connector,
          dbPath: config.dbPath,
          includeDefaultStreams: false,
        });
        await ensureRawTables(database, { verbose: true });
        await ensureLocalSchema(database);
        connected = true;
        connectedAt = new Date();
        console.info('[powersync-daemon] connected to PowerSync backend');
      } catch (error) {
        connected = false;
        console.error('[powersync-daemon] failed to connect to PowerSync backend', error);
        throw error;
      }
    })();
    connectPromise = task.finally(() => {
      connectPromise = null;
    });
    task.catch(() => undefined);
  };

  const waitForConnection = async (timeoutMs: number): Promise<boolean> => {
    if (connected) {
      return true;
    }
    const pending = connectPromise;
    if (!pending) {
      return connected;
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      await pending.catch(() => undefined);
      return connected;
    }
    try {
      await Promise.race([pending, delay(timeoutMs)]);
    } catch {
      // ignore race rejections
    }
    return connected;
  };

  if (config.initialStreams.length > 0) {
    const initialTargets = config.initialStreams
      .map((id): StreamSubscriptionTarget | null => {
        const trimmed = typeof id === 'string' ? id.trim() : '';
        return trimmed ? { id: trimmed } : null;
      })
      .filter((value): value is StreamSubscriptionTarget => value !== null);
    if (initialTargets.length > 0) {
      const initialResult = await subscriptionManager.subscribe(initialTargets);
      if (initialResult.added.length > 0) {
        console.info('[powersync-daemon] subscribed initial streams', initialResult.added);
      }
    }
  }

  const server = createDaemonServer({
    host: config.host,
    port: config.port,
    getStatus: () => ({
      startedAt: startedAt.toISOString(),
      connected,
      connectedAt: connectedAt?.toISOString(),
      streamCount: subscriptionManager.getActiveCount(),
    }),
    onShutdownRequested: () => {
      requestShutdown('rpc');
    },
    cors: {
      origins: ['*'],
      allowHeaders: ['Content-Type', 'Authorization'],
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    },
    getAuthStatus: () => {
      if (authEndpoint && authToken) {
        if (connected) {
          return {
            status: 'ready',
            token: authToken,
            expiresAt: authExpiresAt,
            context: buildAuthContext(),
          };
        }
        return {
          status: 'pending',
          reason: 'PowerSync connection pending; retry shortly.',
          token: authToken,
          expiresAt: authExpiresAt,
          context: buildAuthContext(),
        };
      }
      if (authEndpoint || authToken) {
        return {
          status: 'pending',
          reason: 'PowerSync credentials are incomplete; supply both endpoint and token.',
          context: buildAuthContext(),
        };
      }
      return {
        status: 'auth_required',
        reason: 'PowerSync credentials missing; run `psgit login --guest`.',
        context: buildAuthContext(),
      };
    },
    handleAuthGuest: async (payload) => {
      const tokenCandidate =
        typeof payload?.token === 'string' ? payload.token.trim() : '';
      const endpointCandidate =
        typeof payload?.endpoint === 'string' ? payload.endpoint.trim() : '';

      if (tokenCandidate) {
        authToken = tokenCandidate;
        supabaseWriter?.setAccessToken(authToken);
      }
      if (endpointCandidate) {
        authEndpoint = endpointCandidate;
      }

      const expiresAtCandidate =
        typeof payload?.expiresAt === 'string' ? payload.expiresAt : null;
      authExpiresAt = expiresAtCandidate;

      const metadataCandidate = payload?.metadata;
      if (metadataCandidate && typeof metadataCandidate === 'object' && !Array.isArray(metadataCandidate)) {
        authMetadata = { ...metadataCandidate };
      }

      if (!authEndpoint || !authToken) {
        return {
          status: 'auth_required',
          reason: 'Endpoint or token missing from guest payload.',
          context: buildAuthContext(),
        };
      }

      console.info('[powersync-daemon] accepted guest credentials');
      supabaseWriter?.setAccessToken(authToken);
      supabaseWriter?.start();
      scheduleConnect('guest-auth');
      const readyTimeoutMs = Number.parseInt(
        process.env.POWERSYNC_DAEMON_AUTH_READY_TIMEOUT_MS ?? '10000',
        10,
      );
      const connectedNow = await waitForConnection(readyTimeoutMs);
      if (!connectedNow) {
        return {
          status: 'pending',
          reason: 'PowerSync connection pending; retry shortly.',
          token: authToken,
          expiresAt: authExpiresAt,
          context: buildAuthContext(),
        };
      }
      return {
        status: 'ready',
        token: authToken,
        expiresAt: authExpiresAt,
        context: buildAuthContext(),
      };
    },
    handleAuthLogout: async () => {
      authToken = null;
      authEndpoint = null;
      authExpiresAt = null;
      authMetadata = null;
      supabaseWriter?.setAccessToken(null);
      if (supabaseWriter) {
        await supabaseWriter.stop().catch(() => undefined);
      }
      connected = false;
      connectedAt = null;
      return {
        status: 'auth_required',
        reason: 'Daemon logged out.',
        context: buildAuthContext(),
      };
    },
    listStreams: () => subscriptionManager.listKeys(),
    subscribeStreams: async (streams) => {
      const result = await subscriptionManager.subscribe(streams);
      return result;
    },
    unsubscribeStreams: async (streams) => {
      const result = await subscriptionManager.unsubscribe(streams);
      return result;
    },
    listImportJobs: () => importManager.listJobs(),
    getImportJob: (id) => importManager.getJob(id),
    importGithubRepo: async (payload) => importManager.enqueue(payload),
    fetchRefs: ({ orgId, repoId, limit }) => listRefs(database, { orgId, repoId, limit }),
    listRepos: ({ orgId, limit }) => listRepos(database, { orgId, limit }),
    getRepoSummary: ({ orgId, repoId }) => getRepoSummary(database, { orgId, repoId }),
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

  scheduleConnect('initial-start');

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

  await subscriptionManager.closeAll();
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
