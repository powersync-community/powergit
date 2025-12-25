import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { PowerSyncDatabase, SyncStreamSubscription } from '@powersync/node';
import { DaemonPowerSyncConnector } from '../connector.js';
import { connectWithSchemaRecovery, createPowerSyncDatabase } from '../database.js';
import { buildRepoStreamTargets } from '@powersync-community/powergit-core';
import { startStack, stopStack } from '../../../../scripts/test-stack-hooks.mjs';
import type { DaemonAuthResponse } from '../server.js';
import { createClient } from '@supabase/supabase-js';

const WAIT_TIMEOUT_MS = Number.parseInt(process.env.POWERSYNC_TEST_MAX_WAIT_MS ?? '60000', 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.POWERSYNC_TEST_POLL_MS ?? '750', 10);

const supabaseBinary = process.env.SUPABASE_BIN ?? 'supabase';
const supabaseProbe = spawnSync(supabaseBinary, ['--version'], { stdio: 'ignore' });
const hasSupabaseCli = supabaseProbe.error == null && supabaseProbe.status === 0;

const dockerBinary = process.env.DOCKER_BIN ?? 'docker';
const dockerProbe = spawnSync(dockerBinary, ['--version'], { stdio: 'ignore' });
const dockerComposeProbe = spawnSync(dockerBinary, ['compose', 'version'], { stdio: 'ignore' });
const hasDocker =
  dockerProbe.error == null &&
  dockerProbe.status === 0 &&
  dockerComposeProbe.error == null &&
  dockerComposeProbe.status === 0;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '..', '..', '..', '..');

const betterSqliteProbeScript = `
try {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.close();
  process.exit(0);
} catch (error) {
  console.error(error?.message ?? error);
  process.exit(1);
}
`;
const betterSqliteProbe = spawnSync(process.execPath, ['-e', betterSqliteProbeScript], {
  cwd: join(repoRoot, 'packages', 'daemon'),
});
const hasBetterSqlite = betterSqliteProbe.error == null && betterSqliteProbe.status === 0;

if (!hasSupabaseCli) {
  console.warn('[daemon-e2e] skipping streaming test — Supabase CLI not found (set SUPABASE_BIN to override).');
}

if (!hasDocker) {
  console.warn('[daemon-e2e] skipping streaming test — Docker (with compose) not available (set DOCKER_BIN to override).');
}

if (!hasBetterSqlite) {
  console.warn('[daemon-e2e] skipping streaming test — better-sqlite3 native module unavailable.');
}

const describeIfEnv = hasSupabaseCli && hasDocker && hasBetterSqlite ? describe : describe.skip;

function randomSlug(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

function extractChallengeId(status: unknown): string | null {
  if (!status || typeof status !== 'object') return null;
  const context = (status as { context?: unknown }).context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return null;
  const record = context as Record<string, unknown>;
  const candidate =
    typeof record.challengeId === 'string'
      ? record.challengeId
      : typeof record.deviceCode === 'string'
        ? record.deviceCode
        : typeof record.device_code === 'string'
          ? record.device_code
          : null;
  const trimmed = typeof candidate === 'string' ? candidate.trim() : '';
  return trimmed.length > 0 ? trimmed : null;
}

async function authenticateDaemonViaSupabasePassword({
  daemonUrl,
  endpoint,
  supabaseUrl,
  supabaseAnonKey,
  email,
  password,
}: {
  daemonUrl: string;
  endpoint: string;
  supabaseUrl: string;
  supabaseAnonKey: string;
  email: string;
  password: string;
}): Promise<DaemonAuthResponse> {
  const baseUrl = normalizeBaseUrl(daemonUrl);

  const existing = await fetch(`${baseUrl}/auth/status`)
    .then(async (res) => (res.ok ? ((await res.json().catch(() => null)) as DaemonAuthResponse | null) : null))
    .catch(() => null);
  if (existing?.status === 'ready' && typeof existing.token === 'string' && existing.token.length > 0) {
    return existing;
  }

  const deviceResponse = await fetch(`${baseUrl}/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'device-code', endpoint }),
  });
  const devicePayload = (await deviceResponse.json().catch(() => null)) as DaemonAuthResponse | null;
  if (devicePayload?.status === 'ready' && typeof devicePayload.token === 'string' && devicePayload.token.length > 0) {
    return devicePayload;
  }
  const challengeId = extractChallengeId(devicePayload);
  if (!challengeId && devicePayload?.status === 'pending') {
    const token = typeof devicePayload.token === 'string' && devicePayload.token.trim() ? devicePayload.token.trim() : null;
    if (token) {
      return waitFor(async () => {
        const status = await fetch(`${baseUrl}/auth/status`)
          .then(async (res) => (res.ok ? ((await res.json().catch(() => null)) as DaemonAuthResponse | null) : null))
          .catch(() => null);
        if (status?.status === 'ready' && typeof status.token === 'string' && status.token.trim()) {
          return status;
        }
        return null;
      }, WAIT_TIMEOUT_MS);
    }
  }
  if (!challengeId) {
    const reason = devicePayload && 'reason' in devicePayload ? String((devicePayload as any).reason ?? '') : '';
    throw new Error(`Daemon did not return a device challenge. ${reason}`.trim());
  }

  const supabase = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error(`Supabase password login failed: ${error.message}`);
  }
  const session = data?.session ?? (await supabase.auth.getSession()).data.session;
  if (!session?.access_token || !session?.refresh_token) {
    throw new Error('Supabase login returned no session tokens.');
  }

  const completeResponse = await fetch(`${baseUrl}/auth/device`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      challengeId,
      endpoint,
      session: {
        access_token: session.access_token,
        refresh_token: session.refresh_token,
        expires_in: typeof session.expires_in === 'number' ? session.expires_in : null,
        expires_at: typeof session.expires_at === 'number' ? session.expires_at : null,
      },
    }),
  });
  const completed = (await completeResponse.json().catch(() => null)) as DaemonAuthResponse | null;
  if (completed?.status === 'ready' && typeof completed.token === 'string' && completed.token.length > 0) {
    return completed;
  }

  const final = await fetch(`${baseUrl}/auth/status`)
    .then(async (res) => (res.ok ? ((await res.json().catch(() => null)) as DaemonAuthResponse | null) : null))
    .catch(() => null);
  if (final?.status === 'ready' && typeof final.token === 'string' && final.token.length > 0) {
    return final;
  }
  const finalReason = final && 'reason' in final ? String((final as any).reason ?? '') : '';
  throw new Error(`Daemon did not become ready after password login. ${finalReason}`.trim());
}

async function waitForSupabaseHealth(url: string, timeoutMs: number, intervalMs = POLL_INTERVAL_MS): Promise<void> {
  const parsed = new URL(url);
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
  await waitFor(
    async () =>
      new Promise<boolean>((resolve) => {
        const socket = net.createConnection({ host: parsed.hostname, port }, () => {
          socket.end();
          resolve(true);
        });
        socket.once('error', () => {
          socket.destroy();
          resolve(false);
        });
        socket.setTimeout(1000, () => {
          socket.destroy();
          resolve(false);
        });
      }).then((ready) => (ready ? true : null)),
    timeoutMs,
    intervalMs,
  );
}

async function waitFor<T>(
  task: () => Promise<T | null | false>,
  timeoutMs: number,
  intervalMs = POLL_INTERVAL_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const result = await task();
      if (result) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const hint = lastError instanceof Error ? ` Last error: ${lastError.message}` : '';
  throw new Error(`Timed out waiting for condition after ${timeoutMs}ms.${hint}`);
}

function runCliCommand(args: string[], label: string): void {
  const result = spawnSync('pnpm', ['--filter', '@powersync-community/powergit', 'exec', 'tsx', 'src/bin.ts', ...args], {
    cwd: repoRoot,
    env: { ...process.env },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`CLI command failed (${label}): pnpm --filter @powersync-community/powergit exec tsx src/bin.ts ${args.join(' ')}`);
  }
}

describeIfEnv('PowerSync daemon streaming (no UI)', () => {
  let database: PowerSyncDatabase | null = null;
  let dbPath: string | null = null;
  let stackEnv: Record<string, string> | null = null;
  let daemonAuth: DaemonAuthResponse | null = null;
  let powergitHome: string | null = null;
  let priorEnv: { POWERGIT_HOME?: string; STACK_PROFILE?: string } | null = null;

  const orgId = randomSlug('daemon-e2e-org');
  const repoId = randomSlug('daemon-e2e-repo');
  const branchName = 'main';

  const resolveEnv = (key: string): string | undefined => {
    return process.env[key] ?? stackEnv?.[key];
  };

  const daemonBaseUrl = () => resolveEnv('POWERSYNC_DAEMON_URL') ?? 'http://127.0.0.1:5030';

  beforeAll(async () => {
    delete process.env.POWERSYNC_DISABLE_SUPABASE_WRITER;
    await stopStack({ force: true }).catch(() => undefined);

    priorEnv = {
      POWERGIT_HOME: process.env.POWERGIT_HOME,
      STACK_PROFILE: process.env.STACK_PROFILE,
    };
    powergitHome = await mkdtemp(join(tmpdir(), 'powergit-e2e-home-'));
    process.env.POWERGIT_HOME = powergitHome;
    process.env.STACK_PROFILE = 'local-dev';

    try {
      stackEnv = await startStack({ skipDemoSeed: true });
    } catch (error) {
      await stopStack({ force: true }).catch(() => undefined);
      throw error;
    }
    const supabaseAnonKey = resolveEnv('SUPABASE_ANON_KEY');
    const email = resolveEnv('POWERGIT_EMAIL') ?? resolveEnv('SUPABASE_EMAIL');
    const password = resolveEnv('POWERGIT_PASSWORD') ?? resolveEnv('SUPABASE_PASSWORD');
    const endpoint = resolveEnv('POWERSYNC_URL');
    const supabaseUrl = resolveEnv('SUPABASE_URL');
    if (supabaseUrl) {
      await waitForSupabaseHealth(supabaseUrl, WAIT_TIMEOUT_MS);
      console.info('[daemon-e2e] Supabase HTTP endpoint is reachable');
    }
    const databaseUrl = resolveEnv('POWERSYNC_DATABASE_URL') ?? resolveEnv('SUPABASE_DATABASE_URL');
    if (databaseUrl) {
      await waitForSupabaseHealth(databaseUrl, WAIT_TIMEOUT_MS);
      console.info('[daemon-e2e] Supabase database endpoint is reachable');
    }

    if (!supabaseUrl || !supabaseAnonKey || !email || !password || !endpoint) {
      throw new Error(
        'Local stack env is missing SUPABASE_URL/SUPABASE_ANON_KEY and credentials (POWERGIT_EMAIL/POWERGIT_PASSWORD) plus POWERSYNC_URL.',
      );
    }

    daemonAuth = await authenticateDaemonViaSupabasePassword({
      daemonUrl: daemonBaseUrl(),
      endpoint,
      supabaseUrl,
      supabaseAnonKey,
      email,
      password,
    });
  }, 180_000);

  afterAll(async () => {
    if (database) {
      await database.close({ disconnect: true }).catch(() => undefined);
      database = null;
    }
    if (dbPath) {
      await rm(dbPath, { force: true }).catch(() => undefined);
      dbPath = null;
    }
    await stopStack({ force: true }).catch(() => undefined);
    if (powergitHome) {
      await rm(powergitHome, { recursive: true, force: true }).catch(() => undefined);
      powergitHome = null;
    }
    if (priorEnv) {
      if (priorEnv.POWERGIT_HOME === undefined) delete process.env.POWERGIT_HOME;
      else process.env.POWERGIT_HOME = priorEnv.POWERGIT_HOME;
      if (priorEnv.STACK_PROFILE === undefined) delete process.env.STACK_PROFILE;
      else process.env.STACK_PROFILE = priorEnv.STACK_PROFILE;
      priorEnv = null;
    }
  }, 60_000);

  it(
    'streams seeded repository data to a raw PowerSync client',
    async () => {
      const endpoint =
        daemonAuth?.context && typeof daemonAuth.context.endpoint === 'string' && daemonAuth.context.endpoint.length > 0
          ? daemonAuth.context.endpoint
          : resolveEnv('POWERSYNC_URL');
      if (!endpoint) {
        throw new Error('PowerSync endpoint environment missing; ensure dev stack exports POWERSYNC_URL.');
      }

      const daemonToken =
        typeof daemonAuth?.token === 'string' && daemonAuth.token.length > 0 ? daemonAuth.token : null;
      if (!daemonToken) {
        throw new Error('PowerSync daemon returned no token; ensure login succeeded before running the stream e2e.');
      }

      const remoteUrl = `powergit::local-dev/${orgId}/${repoId}`;

      runCliCommand(
        ['demo-seed', '--remote-url', remoteUrl, '--branch', branchName, '--skip-sync'],
        'seed repository via PowerSync remote',
      );
      console.info('[daemon-e2e] Demo repository seeded');

      await waitFor(async () => {
        const res = await fetch(
          `${daemonBaseUrl().replace(/\/+$/, '')}/orgs/${encodeURIComponent(orgId)}/repos/${encodeURIComponent(repoId)}/summary`,
        ).catch(() => null);
        if (!res || !res.ok) return null;
        const payload = (await res.json().catch(() => null)) as { counts?: Record<string, number> } | null;
        const counts = payload?.counts ?? {};
        return counts.refs && counts.refs > 0 ? counts : null;
      }, WAIT_TIMEOUT_MS);

      const clientDir = await mkdtemp(join(tmpdir(), 'powersync-daemon-e2e-'));
      dbPath = join(clientDir, 'client.db');
      database = await createPowerSyncDatabase({ dbPath });
      console.info('[daemon-e2e] Local database prepared');

      const connector = new DaemonPowerSyncConnector({
        endpoint,
        token: daemonToken,
      });

      await connectWithSchemaRecovery(database, {
        connector,
        dbPath,
        includeDefaultStreams: false,
      });
      await database.waitForReady();
      console.info('[daemon-e2e] Database connected and ready');

      const streamTargets = buildRepoStreamTargets(orgId, repoId);
      const subscriptions: SyncStreamSubscription[] = [];
      try {
        for (const target of streamTargets) {
          console.info(`[daemon-e2e] Subscribing to ${target.id}`);
          const stream = database.syncStream(target.id, target.parameters);
          const subscription = await stream.subscribe();
          const shouldAwaitFirstSync = target.id.endsWith('/refs');
          if (shouldAwaitFirstSync) {
            const abort = new AbortController();
            const timer = setTimeout(() => abort.abort(), WAIT_TIMEOUT_MS);
            try {
              await subscription.waitForFirstSync(abort.signal);
              console.info(`[daemon-e2e] First sync completed for ${target.id}`);
            } catch (error) {
              if (abort.signal.aborted) {
                throw new Error(`waitForFirstSync timed out for stream ${target.id}`);
              }
              throw error;
            } finally {
              clearTimeout(timer);
            }
          }
          subscriptions.push(subscription);
        }

        const refs = await waitFor(async () => {
          const rows = await database!.getAll<{ name: string }>(
            'SELECT name FROM refs WHERE org_id = ? AND repo_id = ?',
            [orgId, repoId],
          );
          return rows.some((row) => row.name === `refs/heads/${branchName}`) ? rows : null;
        }, WAIT_TIMEOUT_MS);
        console.info('[daemon-e2e] Local refs query returned rows', refs.length);

        expect(refs.some((row) => row.name === `refs/heads/${branchName}`)).toBe(true);
      } finally {
        subscriptions.forEach((subscription) => {
          try {
            subscription.unsubscribe();
          } catch {
            // ignore
          }
        });
      }
    },
    240_000,
  );
});
