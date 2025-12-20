import { createHash, randomBytes } from 'node:crypto';
import { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { PowerSyncDatabase, SyncStreamSubscription } from '@powersync/node';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { resolveDaemonConfig, type ResolveDaemonConfigOptions } from './config.js';
import { DaemonPowerSyncConnector } from './connector.js';
import { connectWithSchemaRecovery, createPowerSyncDatabase } from './database.js';
import {
  createDaemonServer,
  type DaemonAuthResponse,
  type StreamSubscriptionTarget,
  type SubscribeStreamsResult,
  type UnsubscribeStreamsResult,
} from './server.js';
import { deleteRepoData, getLatestPack, getPackByOid, getRepoSummary, listRefs, listRepos, persistPush } from './queries.js';
import type { PersistPushResult, PushUpdateRow } from './queries.js';
import { SupabaseWriter } from './supabase-writer.js';
import { GithubImportManager } from './importer.js';
import { resolveSessionPath } from './auth/index.js';
import { createSupabaseFileStorage, resolveSupabaseSessionPath } from '@powersync-community/powergit-core';
import { PackStorage } from './storage.js';

const SUPABASE_ONLY_MODE =
  (process.env.SUPABASE_ONLY_MODE ?? process.env.POWERSYNC_SUPABASE_ONLY ?? 'false').toLowerCase() === 'true';

function normalizeAuthToken(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAuthEndpoint(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  try {
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : null;
  } catch {
    return null;
  }
}

function getJwtExpirationMs(token: string): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload) return null;
  const exp = (payload as { exp?: unknown }).exp;
  if (typeof exp !== 'number') return null;
  const expires = exp * 1000;
  return Number.isFinite(expires) ? expires : null;
}

function isJwtExpired(token: string | null | undefined, skewMs = 0): boolean {
  if (!token) return false;
  const expiresAt = getJwtExpirationMs(token);
  if (!expiresAt) return false;
  return expiresAt <= Date.now() + Math.max(0, skewMs);
}

function formatJwtExpirationIso(token: string | null | undefined): string | null {
  if (!token) return null;
  const expiresAt = getJwtExpirationMs(token);
  if (!expiresAt) return null;
  const iso = new Date(expiresAt).toISOString();
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

function sanitizeOid(value?: string | null): string | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
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

  listTargets(): StreamSubscriptionTarget[] {
    return Array.from(this.targets.values()).map((target) => {
      const parameters = target.params ? { ...target.params } : undefined;
      return parameters ? { id: target.id, parameters } : { id: target.id };
    });
  }

  async subscribe(targets: StreamSubscriptionTarget[]): Promise<SubscribeStreamsResult> {
    const added: string[] = [];
    const alreadyActive: string[] = [];
    const queued: string[] = [];

    try {
      await this.database.waitForReady();
    } catch (error) {
      console.warn('[powersync-daemon] database not ready before subscribing streams', error);
    }

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
        queued.push(key);
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

  let authToken: string | null = null;
  let authEndpoint: string | null = normalizeAuthEndpoint(config.endpoint);
  let authExpiresAt: string | null = null;
  let authObtainedAt: string | null = null;
  let authMetadata: Record<string, unknown> | null = null;

  const sessionPathOverrideCandidates = [
    process.env.POWERSYNC_DAEMON_SESSION_PATH,
    process.env.POWERSYNC_SESSION_PATH,
  ];
  const sessionPathOverride =
    sessionPathOverrideCandidates.find((value) => typeof value === 'string' && value.trim().length > 0) ?? undefined;
  const sessionPath = resolveSessionPath(sessionPathOverride);
  const supabaseAuthPath = resolveSupabaseSessionPath(sessionPath);
  const supabaseUrl = process.env.SUPABASE_URL ?? null;
  const supabaseServiceRole = process.env.SUPABASE_SERVICE_ROLE_KEY ?? null;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY ?? null;
  const supabaseSchema = process.env.SUPABASE_DB_SCHEMA ?? undefined;
  const supabaseWriterDisabled = (process.env.POWERSYNC_DISABLE_SUPABASE_WRITER ?? '').toLowerCase() === 'true';

  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error(
      '[powersync-daemon] Supabase URL and anon key are required. Configure SUPABASE_URL and SUPABASE_ANON_KEY.',
    );
  }

  if (SUPABASE_ONLY_MODE && !authEndpoint) {
    authEndpoint = supabaseUrl ?? 'supabase-only';
  }

  const supabaseStorage = createSupabaseFileStorage(supabaseAuthPath);
  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storage: supabaseStorage,
      storageKey: 'powergit',
    },
    db: {
      schema: supabaseSchema ?? undefined,
    },
  });

  const writerUsesServiceRole =
    typeof supabaseServiceRole === 'string' && supabaseServiceRole.trim().length > 0;
  const supabaseServiceRoleKey = writerUsesServiceRole ? supabaseServiceRole!.trim() : null;
  const supabaseWriterClient: SupabaseClient =
    writerUsesServiceRole && supabaseServiceRoleKey
      ? (createClient(supabaseUrl, supabaseServiceRoleKey, {
          auth: {
            persistSession: false,
            autoRefreshToken: false,
          },
          db: {
            schema: supabaseSchema ?? undefined,
          },
        }) as SupabaseClient)
      : (supabase as SupabaseClient);

  const packBucket = (process.env.SUPABASE_STORAGE_BUCKET ?? process.env.POWERSYNC_SUPABASE_STORAGE_BUCKET ?? 'git-packs').trim();
  const packSignTtl = Number.parseInt(process.env.SUPABASE_STORAGE_TTL ?? process.env.POWERSYNC_SUPABASE_STORAGE_TTL ?? '120', 10);
  let packStorage: PackStorage | null = null;

  let supabaseSession: Session | null = null;
  let supabaseAuthSubscription: { unsubscribe: () => void } | null = null;
  let supabaseWriter: SupabaseWriter | null = null;

  const deviceChallengeTtlMs = Number.parseInt(
    process.env.POWERSYNC_DAEMON_DEVICE_CHALLENGE_TTL_MS ?? '300000',
    10,
  );
  type DeviceChallengeRecord = {
    id: string;
    createdAt: number;
    expiresAt: number;
    endpointHint?: string | null;
    mode?: string | null;
  };
  const deviceChallenges = new Map<string, DeviceChallengeRecord>();

  const resolveVerificationBaseUrl = () =>
    process.env.POWERSYNC_DAEMON_DEVICE_URL ?? process.env.POWERSYNC_EXPLORER_URL ?? null;

  const buildVerificationUrl = (challengeId: string): string | null => {
    const base = resolveVerificationBaseUrl();
    if (!base) return null;
    const separator = base.includes('?') ? '&' : '?';
    return `${base}${separator}device_code=${encodeURIComponent(challengeId)}`;
  };

  const cleanupExpiredChallenges = () => {
    const now = Date.now();
    for (const [id, record] of deviceChallenges.entries()) {
      if (now > record.expiresAt) {
        deviceChallenges.delete(id);
      }
    }
  };
  let database: PowerSyncDatabase | null = null;
  let connectPromise: Promise<void> | null = null;
  const scheduleConnect = (reason: string) => {
    if (SUPABASE_ONLY_MODE) {
      console.info(`[powersync-daemon] skipping PowerSync connect (${reason}) — SUPABASE_ONLY_MODE enabled`);
      connected = true;
      connectedAt = connectedAt ?? new Date();
      return;
    }
    if (!authEndpoint || !authToken) {
      console.warn(`[powersync-daemon] skipping PowerSync connect (${reason}) — credentials missing`);
      connected = false;
      return;
    }
    const db = database;
    if (!db) {
      console.warn(`[powersync-daemon] skipping PowerSync connect (${reason}) — database not ready`);
      connected = false;
      return;
    }
    if (isJwtExpired(authToken, 5_000)) {
      console.warn(`[powersync-daemon] skipping PowerSync connect (${reason}) — token expired; await refreshed credentials.`);
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
        await connectWithSchemaRecovery(db, {
          connector,
          dbPath: config.dbPath,
          includeDefaultStreams: false,
        });
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

  const clearSupabaseAuthSubscription = () => {
    if (supabaseAuthSubscription) {
      supabaseAuthSubscription.unsubscribe();
      supabaseAuthSubscription = null;
    }
  };

  let connected = false;
  let connectedAt: Date | null = null;

  const handleSupabaseSignOut = async (reason: string) => {
    supabaseSession = null;
    authToken = null;
    authExpiresAt = null;
    authObtainedAt = null;
    authMetadata = { source: 'supabase', reason, status: 'signed_out' };
    if (supabaseWriter) {
      await supabaseWriter.stop().catch(() => undefined);
    }
    connected = false;
    connectedAt = null;
    deviceChallenges.clear();
  };

  const applySupabaseSession = async (session: Session | null, source: string) => {
    if (!session || typeof session.access_token !== 'string' || session.access_token.trim().length === 0) {
      await handleSupabaseSignOut(`empty-session-${source}`);
      return;
    }
    supabaseSession = session;
    const accessToken = session.access_token.trim();
    authToken = accessToken;
    authExpiresAt =
      typeof session.expires_at === 'number'
        ? new Date(session.expires_at * 1000).toISOString()
        : formatJwtExpirationIso(accessToken);
    authObtainedAt = new Date().toISOString();
    authMetadata = {
      source: 'supabase',
      event: source,
      user: session.user ? { id: session.user.id, email: session.user.email } : null,
    };
    if (supabaseWriter) {
      const canStartWriter = writerUsesServiceRole || !isJwtExpired(authToken, 5_000);
      if (canStartWriter) {
        supabaseWriter.start();
        if (!writerUsesServiceRole) {
          console.info('[powersync-daemon] Supabase writer now using the authenticated Supabase session for writes');
        }
      }
    }
    if (!packStorage) {
      try {
        const storage = new PackStorage(supabaseWriterClient, {
          bucket: packBucket,
          baseUrl: supabaseUrl,
          signExpiresIn: Number.isFinite(packSignTtl) ? packSignTtl : 120,
        });
        try {
          await storage.ensureBucket();
        } catch (error) {
          const statusCode = (error as { status?: unknown; statusCode?: unknown })?.status ?? (error as { statusCode?: unknown })?.statusCode;
          console.warn(
            `[powersync-daemon] pack storage bucket check failed (${statusCode ?? 'unknown status'}); continuing. ` +
              'Ensure the bucket exists and allows writes for this Supabase user or provide SUPABASE_SERVICE_ROLE_KEY.',
          );
        }
        packStorage = storage;
      } catch (error) {
        console.error('[powersync-daemon] failed to initialize pack storage after login', error);
        packStorage = null;
      }
    }
    if (SUPABASE_ONLY_MODE) {
      connected = true;
      connectedAt = new Date();
    } else {
      scheduleConnect(`supabase-${source}`);
    }
  };

  const loginEmail =
    (process.env.SUPABASE_EMAIL ?? process.env.POWERGIT_EMAIL)?.trim() ?? null;
  const loginPassword =
    (process.env.SUPABASE_PASSWORD ?? process.env.POWERGIT_PASSWORD)?.trim() ?? null;

  if (loginEmail && loginPassword) {
    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: loginEmail,
        password: loginPassword,
      });
      if (error) {
        console.warn('[powersync-daemon] Supabase password login failed', error.message ?? error);
      } else {
        await applySupabaseSession(data.session ?? null, 'password-login');
      }
    } catch (error) {
      console.warn('[powersync-daemon] Supabase password login threw', error instanceof Error ? error.message : error);
    }
  }

  const initialSessionResult = await supabase.auth.getSession();
  if (initialSessionResult.error) {
    console.warn('[powersync-daemon] failed to read Supabase session', initialSessionResult.error);
  }
  await applySupabaseSession(initialSessionResult.data.session ?? null, 'initial');

  supabaseAuthSubscription = supabase.auth.onAuthStateChange(async (event, session) => {
    switch (event) {
      case 'SIGNED_IN':
      case 'TOKEN_REFRESHED':
      case 'USER_UPDATED': {
        await applySupabaseSession(session, event.toLowerCase());
        break;
      }
      case 'SIGNED_OUT':
      case 'PASSWORD_RECOVERY':
        await handleSupabaseSignOut(event.toLowerCase());
        break;
      default:
        break;
    }
  }).data.subscription;

  const buildAuthContext = (): Record<string, unknown> | null => {
    const context: Record<string, unknown> = {};
    const profileNameCandidate =
      (process.env.POWERGIT_PROFILE ?? process.env.STACK_PROFILE ?? process.env.POWERGIT_ACTIVE_PROFILE)?.trim() ?? '';
    if (profileNameCandidate) {
      context.profile = profileNameCandidate;
    }
    if (authEndpoint) {
      context.endpoint = authEndpoint;
    }
    if (authMetadata) {
      Object.assign(context, authMetadata);
    }
    return Object.keys(context).length > 0 ? context : null;
  };

  const startedAt = new Date();
  const databaseInstance = await createPowerSyncDatabase({ dbPath: config.dbPath });
  database = databaseInstance;
  const subscriptionManager = new StreamSubscriptionManager(databaseInstance);
  const daemonBaseUrl = `http://127.0.0.1:${config.port}`;
  const recordImportJob = async (job: import('@powersync-community/powergit-core').PowerSyncImportJob) => {
    const now = job.updatedAt ?? new Date().toISOString();
    const repoKey = `${job.orgId}/${job.repoId}`;
    await databaseInstance.writeTransaction(async (tx) => {
      await tx.execute('DELETE FROM import_jobs WHERE id = ?', [job.id]);
      await tx.execute(
        `INSERT INTO import_jobs (
           id, org_id, repo_id, repo_url, status, created_at, updated_at,
           branch, default_branch, error, workflow_url, source
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          job.id,
          job.orgId,
          job.repoId,
          job.repoUrl,
          job.status,
          job.createdAt ?? now,
          now,
          job.branch ?? null,
          job.result?.defaultBranch ?? null,
          job.error ?? null,
          null,
          'daemon',
        ],
      );
      await tx.execute('DELETE FROM repositories WHERE id = ?', [repoKey]);
      await tx.execute(
        `INSERT INTO repositories (
           id, org_id, repo_id, repo_url, created_at, updated_at, last_status, last_import_job_id, default_branch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          repoKey,
          job.orgId,
          job.repoId,
          job.repoUrl,
          job.createdAt ?? now,
          now,
          job.status,
          job.id,
          job.result?.defaultBranch ?? null,
        ],
      );
    });
  };

  const upsertRepository = async (payload: {
    orgId: string;
    repoId: string;
    repoUrl?: string | null;
    status?: string | null;
    defaultBranch?: string | null;
    jobId?: string | null;
    updatedAt?: string | null;
  }) => {
    const now = payload.updatedAt ?? new Date().toISOString();
    const repoKey = `${payload.orgId}/${payload.repoId}`;
    const existing = await databaseInstance.getOptional<{
      repo_url?: string | null;
      last_status?: string | null;
      last_import_job_id?: string | null;
      default_branch?: string | null;
      created_at?: string | null;
    }>(
      `SELECT repo_url, last_status, last_import_job_id, default_branch, created_at
       FROM repositories WHERE id = ?`,
      [repoKey],
    );
    const repoUrl = payload.repoUrl ?? existing?.repo_url ?? null;
    const lastStatus = payload.status ?? existing?.last_status ?? null;
    const lastImportJobId = payload.jobId ?? existing?.last_import_job_id ?? null;
    const defaultBranch = payload.defaultBranch ?? existing?.default_branch ?? null;
    const createdAt = existing?.created_at ?? now;
    await databaseInstance.writeTransaction(async (tx) => {
      await tx.execute('DELETE FROM repositories WHERE id = ?', [repoKey]);
      await tx.execute(
        `INSERT INTO repositories (
           id, org_id, repo_id, repo_url, created_at, updated_at, last_status, last_import_job_id, default_branch
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          repoKey,
          payload.orgId,
          payload.repoId,
          repoUrl,
          createdAt,
          now,
          lastStatus,
          lastImportJobId,
          defaultBranch,
        ],
      );
    });
  };
  const importManager = new GithubImportManager({
    daemonBaseUrl,
    subscribeStreams: async (targets) => {
      await subscriptionManager.subscribe(targets);
    },
    recordImportJob,
    upsertRepository,
  });
  if (!supabaseWriterDisabled) {
    if (!supabaseUrl) {
      throw new Error(
        '[powersync-daemon] Supabase writer requires SUPABASE_URL. Set POWERSYNC_DISABLE_SUPABASE_WRITER=true to run without Supabase replication.',
      );
    }

    supabaseWriter = new SupabaseWriter({
      database: databaseInstance,
      client: supabaseWriterClient,
    });
    const hasActiveSession = Boolean(supabaseSession && authToken && !isJwtExpired(authToken, 5_000));
    const writerReady = writerUsesServiceRole || hasActiveSession;
    const writerMode = writerUsesServiceRole ? 'service-role key' : hasActiveSession ? 'Supabase session' : 'anon/public key';
    if (!writerUsesServiceRole) {
      console.warn(
        '[powersync-daemon] Supabase writer will use the authenticated Supabase session when available; provide SUPABASE_SERVICE_ROLE_KEY to enforce server-side permissions.',
      );
    }
    if (writerReady) {
      supabaseWriter.start();
      console.info(`[powersync-daemon] Supabase writer started (${writerMode})`);
    } else {
      console.info(
        `[powersync-daemon] Supabase writer initialised (${writerMode}) — waiting for Supabase auth before starting`,
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
  const abortController = new AbortController();
  const requestShutdown = (reason: string) => {
    if (abortController.signal.aborted) return;
    running = false;
    console.info(`[powersync-daemon] shutdown requested (${reason}); shutting down`);
    abortController.abort();
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
      const supabaseOnly = SUPABASE_ONLY_MODE || !authEndpoint;
      if (supabaseOnly && authToken) {
        return {
          status: 'ready',
          token: authToken,
          expiresAt: authExpiresAt,
          context: buildAuthContext(),
        };
      }
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
      if (authEndpoint && !authToken) {
        return {
          status: 'pending',
          reason: 'Awaiting Supabase authentication; run `powergit login` to continue.',
          context: buildAuthContext(),
        };
      }
      return {
        status: 'auth_required',
        reason: 'PowerSync credentials missing; run `powergit login` to authenticate via Supabase.',
        context: buildAuthContext(),
      };
    },
    handleAuthDevice: async (payload) => {
      const request = (payload ?? {}) as Record<string, unknown>;
      cleanupExpiredChallenges();

      const challengeId = typeof request.challengeId === 'string' ? request.challengeId.trim() : '';
      const sessionPayload = request.session as
        | {
            access_token?: unknown;
            refresh_token?: unknown;
            expires_in?: unknown;
            expires_at?: unknown;
          }
        | undefined;

      if (challengeId && sessionPayload && typeof sessionPayload === 'object' && !Array.isArray(sessionPayload)) {
        const record = deviceChallenges.get(challengeId);
        if (!record) {
          return {
            status: 'error',
            reason: 'invalid_challenge',
            context: { challengeId },
          } satisfies DaemonAuthResponse;
        }
        if (Date.now() > record.expiresAt) {
          deviceChallenges.delete(challengeId);
          return {
            status: 'error',
            reason: 'challenge_expired',
            context: { challengeId },
          } satisfies DaemonAuthResponse;
        }

        const accessToken =
          typeof sessionPayload.access_token === 'string' ? sessionPayload.access_token.trim() : '';
        const refreshToken =
          typeof sessionPayload.refresh_token === 'string' ? sessionPayload.refresh_token.trim() : '';
        if (!accessToken || !refreshToken) {
          return {
            status: 'error',
            reason: 'session_invalid',
            context: { challengeId },
          } satisfies DaemonAuthResponse;
        }

        try {
          const { data, error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });
          if (error) {
            throw error;
          }
          if (typeof request.endpoint === 'string') {
            const overridden = normalizeAuthEndpoint(request.endpoint);
            if (overridden) {
              authEndpoint = overridden;
            }
          } else if (record.endpointHint) {
            authEndpoint = normalizeAuthEndpoint(record.endpointHint);
          }
          await applySupabaseSession(data.session ?? null, 'device-complete');
          deviceChallenges.delete(challengeId);
          if (!authToken) {
            return {
              status: 'error',
              reason: 'session_unavailable',
              context: { challengeId },
            } satisfies DaemonAuthResponse;
          }
          return {
            status: 'ready',
            token: authToken ?? '',
            expiresAt: authExpiresAt,
            context: buildAuthContext(),
          } satisfies DaemonAuthResponse;
        } catch (error) {
          console.error('[powersync-daemon] failed to apply Supabase session', error);
          return {
            status: 'error',
            reason: 'session_apply_failed',
            context: { challengeId },
          } satisfies DaemonAuthResponse;
        }
      }

      const mode = typeof request.mode === 'string' ? request.mode : 'device-code';
      const endpointHint =
        typeof request.endpoint === 'string' && request.endpoint.trim().length > 0
          ? normalizeAuthEndpoint(request.endpoint)
          : authEndpoint;
      if (endpointHint) {
        authEndpoint = endpointHint;
      }
      const id = randomBytes(6).toString('hex');
      const createdAt = Date.now();
      const expiresAt = createdAt + deviceChallengeTtlMs;
      deviceChallenges.set(id, {
        id,
        createdAt,
        expiresAt,
        endpointHint: endpointHint ?? null,
        mode,
      });

      const verificationUrl = buildVerificationUrl(id);
      const reason =
        verificationUrl != null
          ? `Complete daemon login in your browser: ${verificationUrl}`
          : 'Complete daemon login using the displayed device code.';
      return {
        status: 'pending',
        reason,
        context: {
          challengeId: id,
          verificationUrl,
          expiresAt: new Date(expiresAt).toISOString(),
          mode,
        },
      } satisfies DaemonAuthResponse;
    },
    handleAuthLogout: async () => {
      try {
        await supabase.auth.signOut();
      } catch (error) {
        console.warn('[powersync-daemon] Supabase sign-out failed', error);
      }
      await handleSupabaseSignOut('logout');
      return {
        status: 'auth_required',
        reason: 'Daemon logged out.',
        context: buildAuthContext(),
      };
    },
    listStreams: () => subscriptionManager.listTargets(),
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
    fetchRefs: ({ orgId, repoId, limit }) => listRefs(databaseInstance, { orgId, repoId, limit }),
    listRepos: ({ orgId, limit }) => listRepos(databaseInstance, { orgId, limit }),
    getRepoSummary: ({ orgId, repoId }) => getRepoSummary(databaseInstance, { orgId, repoId }),
    fetchPack: async ({ orgId, repoId }) => {
      if (!packStorage) return null;
      let packRow: Awaited<ReturnType<typeof getLatestPack>> = null;
      try {
        packRow = await getLatestPack(databaseInstance, { orgId, repoId });
      } catch (error) {
        console.error(
          `[powersync-daemon] pack lookup failed for ${orgId}/${repoId}`,
          error,
        );
        return null;
      }
      if (!packRow || !packRow.storage_key) return null;
      const signed = await packStorage.createSignedUrl(packRow.storage_key).catch((error) => {
        console.error('[powersync-daemon] failed to sign pack URL', error);
        return null;
      });
      if (!signed) return null;
      return {
        packUrl: signed.url,
        packOid: packRow.pack_oid,
        createdAt: packRow.created_at,
        size: packRow.size_bytes ?? undefined,
      };
    },
    getPackDownloadUrl: async ({ orgId, repoId, packOid }) => {
      if (!packStorage) return null;
      try {
        const packRow = await getPackByOid(databaseInstance, { orgId, repoId, packOid });
        if (!packRow || !packRow.storage_key) return null;
        const signed = await packStorage.createSignedUrl(packRow.storage_key);
        if (!signed) return null;
        return { url: signed.url, expiresAt: signed.expiresAt, sizeBytes: packRow.size_bytes ?? null };
      } catch (error) {
        console.error('[powersync-daemon] failed to resolve pack download URL', error);
        return null;
      }
    },
    pushPack: async ({ orgId, repoId, payload }) => {
      try {
        let resolvedPackOid = sanitizeOid(payload.packOid);
        let storageKey: string | null = null;
        let packSize: number | undefined;

        if (payload.packBase64 && payload.packBase64.length > 0) {
          if (!packStorage) {
            throw new Error('Pack storage is not configured; cannot persist pack data');
          }
          const encoding = (payload.packEncoding ?? 'base64').toLowerCase();
          if (encoding !== 'base64') {
            throw new Error(`Unsupported pack encoding: ${encoding}`);
          }
          const packBuffer = Buffer.from(payload.packBase64, 'base64');
          if (!resolvedPackOid) {
            resolvedPackOid = createHash('sha1').update(packBuffer).digest('hex');
          }
          storageKey = `${orgId}/${repoId}/${resolvedPackOid}.pack`;
          packSize = await packStorage.uploadPack(storageKey, packBuffer);
        }

        const result = await persistPush(databaseInstance, {
          orgId,
          repoId,
          updates: payload.updates,
          packOid: resolvedPackOid,
          packStorageKey: storageKey ?? undefined,
          packSizeBytes: packSize,
          summary: payload.summary ?? undefined,
          createdAt: payload.createdAt ?? undefined,
          repoUrl: payload.repoUrl ?? undefined,
          dryRun: payload.dryRun === true,
        });
        if (result.packSize !== undefined) {
          console.info(
            `[powersync-daemon] stored pack for ${orgId}/${repoId} (oid: ${result.packOid ?? 'unknown'}, size: ${result.packSize} bytes)`,
          );
        }
        // Flush Supabase writer so pushes are durable before returning
        if (supabaseWriter) {
          try {
            await supabaseWriter.uploadPending();
          } catch (flushError) {
            console.warn('[powersync-daemon] Supabase writer flush failed after push', flushError);
          }
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
    deleteRepo: async ({ orgId, repoId }) => {
      try {
        const result = await deleteRepoData(databaseInstance, { orgId, repoId });
        if (packStorage && result.storageKeys.length) {
          await packStorage.deleteObjects(result.storageKeys).catch((error) => {
            console.warn('[powersync-daemon] failed to delete pack blobs', error);
          });
        }
        console.info(
          `[powersync-daemon] deleted repo ${orgId}/${repoId} (packs removed: ${result.storageKeys.length})`,
        );
        return { ok: true, deletedPacks: result.storageKeys.length };
      } catch (error) {
        console.error(`[powersync-daemon] failed to delete repo ${orgId}/${repoId}`, error);
        throw error;
      }
    },
  });

  const address = await server.listen();
  const listenHost = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  console.info(`[powersync-daemon] listening on http://${listenHost}:${address.port}`);

  if (!SUPABASE_ONLY_MODE) {
    scheduleConnect('initial-start');
  }

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
  clearSupabaseAuthSubscription();
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
