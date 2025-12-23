import { setTimeout as delay } from 'node:timers/promises';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';

const DEFAULT_DAEMON_URL = 'http://127.0.0.1:5030';
const DEFAULT_AUTH_TIMEOUT_MS = Number.parseInt(
  process.env.POWERSYNC_DAEMON_AUTH_TIMEOUT_MS ?? process.env.POWERSYNC_AUTH_TIMEOUT_MS ?? '20000',
  10,
);

function log(logger, level, ...args) {
  const target =
    logger && typeof logger[level] === 'function'
      ? logger[level].bind(logger)
      : typeof console[level] === 'function'
        ? console[level].bind(console)
        : console.log.bind(console);
  target(...args);
}

function firstNonEmpty(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}

function resolveSupabaseAuthConfig(env) {
  const url = firstNonEmpty(
    env?.SUPABASE_URL,
    env?.POWERGIT_TEST_SUPABASE_URL,
    process.env.SUPABASE_URL,
    process.env.POWERGIT_TEST_SUPABASE_URL,
  );
  const anonKey = firstNonEmpty(
    env?.SUPABASE_ANON_KEY,
    env?.POWERGIT_TEST_SUPABASE_ANON_KEY,
    process.env.SUPABASE_ANON_KEY,
    process.env.POWERGIT_TEST_SUPABASE_ANON_KEY,
  );
  const email = firstNonEmpty(
    env?.POWERGIT_EMAIL,
    env?.POWERGIT_TEST_SUPABASE_EMAIL,
    process.env.POWERGIT_EMAIL,
    process.env.POWERGIT_TEST_SUPABASE_EMAIL,
    process.env.SUPABASE_EMAIL,
  );
  const password = firstNonEmpty(
    env?.POWERGIT_PASSWORD,
    env?.POWERGIT_TEST_SUPABASE_PASSWORD,
    process.env.POWERGIT_PASSWORD,
    process.env.POWERGIT_TEST_SUPABASE_PASSWORD,
    process.env.SUPABASE_PASSWORD,
  );
  return { url, anonKey, email, password };
}

function resolvePowerSyncEndpoint(env, explicit) {
  return firstNonEmpty(
    explicit,
    env?.POWERSYNC_URL,
    env?.POWERSYNC_DAEMON_ENDPOINT,
    env?.POWERGIT_TEST_ENDPOINT,
    process.env.POWERSYNC_URL,
    process.env.POWERSYNC_DAEMON_ENDPOINT,
    process.env.POWERGIT_TEST_ENDPOINT,
  );
}

function normalizeContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return raw;
}

function normalizeToken(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof raw === 'object') {
    const token = typeof raw.token === 'string' ? raw.token.trim() : '';
    if (token) return token;
    const value = typeof raw.value === 'string' ? raw.value.trim() : '';
    if (value) return value;
  }
  return null;
}

function extractChallengeId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.challengeId === 'string' && payload.challengeId.trim().length > 0) {
    return payload.challengeId.trim();
  }
  const context = normalizeContext(payload.context);
  if (context) {
    const { challengeId, deviceCode } = context;
    if (typeof challengeId === 'string' && challengeId.trim().length > 0) {
      return challengeId.trim();
    }
    if (typeof deviceCode === 'string' && deviceCode.trim().length > 0) {
      return deviceCode.trim();
    }
  }
  return null;
}

export function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '');
}

export function resolveDaemonBaseUrl(env) {
  return (
    env?.POWERSYNC_DAEMON_URL ??
    process.env.POWERSYNC_DAEMON_URL ??
    DEFAULT_DAEMON_URL
  );
}

export async function isDaemonResponsive(baseUrl, timeoutMs = 2000) {
  const target = `${normalizeBaseUrl(baseUrl)}/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(target, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    clearTimeout(timeout);
    return false;
  }
}

export async function stopDaemon(baseUrl, timeoutMs = 4000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    await fetch(`${normalizeBaseUrl(baseUrl)}/shutdown`, {
      method: 'POST',
      signal: controller.signal,
    });
  } catch {
    // daemon may already be offline
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeDaemonStatus(payload) {
  if (!payload) return null;
  switch (payload.status) {
    case 'ready': {
      const token = normalizeToken(payload.token);
      return {
        status: 'ready',
        token,
        expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
        context: normalizeContext(payload.context),
      };
    }
    case 'pending': {
      const token = normalizeToken(payload.token);
      return {
        status: 'pending',
        reason: payload.reason ?? null,
        token,
        expiresAt: typeof payload.expiresAt === 'string' ? payload.expiresAt : null,
        context: normalizeContext(payload.context),
      };
    }
    case 'auth_required':
      return { status: 'auth_required', reason: payload.reason ?? null, context: normalizeContext(payload.context) };
    case 'error':
      return { status: 'error', reason: payload.reason ?? null, context: normalizeContext(payload.context) };
    default:
      return null;
  }
}

export async function fetchDaemonStatus(baseUrl) {
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/auth/status`);
    if (!response.ok) return null;
    const payload = await response.json();
    return normalizeDaemonStatus(payload);
  } catch {
    return null;
  }
}

export function shouldRefreshDaemonStatus(status) {
  if (!status || status.status !== 'ready') return true;
  if (status.expiresAt) {
    const expires = Number.isNaN(Date.parse(status.expiresAt)) ? null : Date.parse(status.expiresAt);
    if (expires && expires <= Date.now() + 120_000) {
      return true;
    }
  }
  return false;
}

export async function authenticateDaemonWithSupabase({
  env = process.env,
  endpoint,
  metadata,
  logger = console,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
} = {}) {
  const baseUrl = resolveDaemonBaseUrl(env);
  const { url, anonKey, email, password } = resolveSupabaseAuthConfig(env);

  if (!url || !anonKey) {
    log(logger, 'warn', '[dev] Supabase URL or anon key missing — cannot authenticate daemon.');
    return { status: null, authenticated: false, challengeId: null };
  }
  if (!email || !password) {
    log(
      logger,
      'warn',
      '[dev] Supabase email/password unavailable — skipping daemon authentication (provide POWERGIT_EMAIL/POWERGIT_PASSWORD or SUPABASE_EMAIL/PASSWORD).',
    );
    return { status: null, authenticated: false, challengeId: null };
  }

  const powersyncEndpoint = resolvePowerSyncEndpoint(env, endpoint);

  let devicePayload = null;
  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/auth/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'device-code',
        endpoint: powersyncEndpoint,
        metadata: metadata ?? null,
      }),
    });
    devicePayload = await response.json().catch(() => null);
  } catch (error) {
    log(
      logger,
      'warn',
      '[dev] Failed to request daemon device challenge:',
      error instanceof Error ? error.message : error,
    );
    return { status: null, authenticated: false, challengeId: null };
  }

  const initialStatus = normalizeDaemonStatus(devicePayload);
  if (initialStatus?.status === 'ready') {
    return { status: initialStatus, authenticated: false, challengeId: null };
  }

  const challengeId = extractChallengeId(devicePayload);
  if (!challengeId) {
    if (initialStatus?.status === 'pending' && initialStatus.token) {
      log(logger, 'info', '[dev] Daemon already has a PowerSync token; waiting for the daemon to become ready...');
      const deadline = Date.now() + (timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
      while (Date.now() < deadline) {
        const status = await fetchDaemonStatus(baseUrl);
        if (status?.status === 'ready') {
          return { status, authenticated: false, challengeId: null };
        }
        if (status?.status === 'error') {
          return { status, authenticated: false, challengeId: null };
        }
        await delay(500);
      }
      const finalStatus = await fetchDaemonStatus(baseUrl);
      if (!finalStatus || finalStatus.status !== 'ready') {
        log(logger, 'warn', '[dev] Timed out waiting for daemon to report ready after startup.');
      }
      return { status: finalStatus ?? initialStatus, authenticated: false, challengeId: null, timedOut: true };
    }

    log(
      logger,
      'warn',
      '[dev] Daemon did not issue a device challenge; cannot complete Supabase authentication automatically.',
    );
    return { status: initialStatus, authenticated: false, challengeId: null };
  }

  log(logger, 'info', `[dev] Authenticating daemon via Supabase (challenge ${challengeId})…`);

  let session = null;
  try {
    const supabase = createSupabaseClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      log(
        logger,
        'warn',
        '[dev] Supabase password login failed for daemon authentication:',
        error instanceof Error ? error.message : error,
      );
      return { status: initialStatus, authenticated: false, challengeId };
    }
    session = data?.session ?? (await supabase.auth.getSession().catch(() => ({ data: { session: null } }))).data.session;
  } catch (error) {
    log(
      logger,
      'warn',
      '[dev] Unable to sign into Supabase for daemon authentication:',
      error instanceof Error ? error.message : error,
    );
    return { status: initialStatus, authenticated: false, challengeId };
  }

  if (!session?.access_token || !session?.refresh_token) {
    log(logger, 'warn', '[dev] Supabase session missing access/refresh token; cannot authenticate daemon.');
    return { status: initialStatus, authenticated: false, challengeId };
  }

  try {
    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/auth/device`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        challengeId,
        endpoint: powersyncEndpoint,
        session: {
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_in: typeof session.expires_in === 'number' ? session.expires_in : null,
          expires_at: typeof session.expires_at === 'number' ? session.expires_at : null,
        },
        metadata: metadata ?? null,
      }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      log(
        logger,
        'warn',
        `[dev] Daemon device completion failed (${response.status} ${response.statusText}): ${text}`,
      );
    }
  } catch (error) {
    log(
      logger,
      'warn',
      '[dev] Unable to complete daemon device authentication:',
      error instanceof Error ? error.message : error,
    );
    return { status: initialStatus, authenticated: true, challengeId };
  }

  const deadline = Date.now() + (timeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
  while (Date.now() < deadline) {
    const status = await fetchDaemonStatus(baseUrl);
    if (status?.status === 'ready') {
      log(logger, 'info', '[dev] Daemon authenticated via Supabase session.');
      return { status, authenticated: true, challengeId };
    }
    if (status?.status === 'error') {
      return { status, authenticated: true, challengeId };
    }
    await delay(500);
  }

  const finalStatus = await fetchDaemonStatus(baseUrl);
  if (!finalStatus || finalStatus.status !== 'ready') {
    log(logger, 'warn', '[dev] Timed out waiting for daemon to report ready after Supabase authentication.');
  }
  return { status: finalStatus, authenticated: true, challengeId, timedOut: true };
}

export async function ensureDaemonSupabaseAuth({
  env = process.env,
  endpoint,
  metadata,
  logger = console,
  timeoutMs = DEFAULT_AUTH_TIMEOUT_MS,
} = {}) {
  const baseUrl = resolveDaemonBaseUrl(env);
  const currentStatus = await fetchDaemonStatus(baseUrl);
  if (currentStatus && currentStatus.status === 'ready' && !shouldRefreshDaemonStatus(currentStatus)) {
    return { status: currentStatus, performedLogin: false };
  }

  const result = await authenticateDaemonWithSupabase({ env, endpoint, metadata, logger, timeoutMs });
  return {
    status: result.status ?? currentStatus ?? null,
    performedLogin: result.authenticated,
    challengeId: result.challengeId ?? null,
    timedOut: result.timedOut ?? false,
  };
}
