import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export interface StoredAuthCredentials {
  endpoint: string;
  token: string;
  expiresAt?: string | null;
  obtainedAt?: string | null;
  authType?: string | null;
  metadata?: Record<string, unknown> | null;
}

function resolvePowergitHome(): string {
  const override = process.env.POWERGIT_HOME;
  if (override && override.trim().length > 0) {
    return resolve(override.trim());
  }
  return resolve(homedir(), '.powergit');
}

function sanitizeProfileKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'default';
  return trimmed.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function resolveProfileNameFromEnv(): string {
  const candidate =
    process.env.POWERGIT_PROFILE ??
    process.env.STACK_PROFILE ??
    process.env.POWERGIT_ACTIVE_PROFILE ??
    'prod';
  const trimmed = String(candidate ?? '').trim();
  return trimmed.length > 0 ? trimmed : 'prod';
}

export function resolveSessionPath(customPath?: string): string {
  if (customPath) {
    return resolve(customPath);
  }
  const profileKey = sanitizeProfileKey(resolveProfileNameFromEnv());
  return resolve(resolvePowergitHome(), 'daemon', profileKey, 'session.json');
}

async function ensureDirectoryExists(filePath: string): Promise<void> {
  await fs.mkdir(dirname(filePath), { recursive: true });
}

export async function loadStoredAuthCredentials(sessionPath: string): Promise<StoredAuthCredentials | null> {
  try {
    const raw = await fs.readFile(sessionPath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredAuthCredentials>;
    if (!parsed || typeof parsed.endpoint !== 'string' || typeof parsed.token !== 'string') {
      return null;
    }
    return {
      endpoint: parsed.endpoint,
      token: parsed.token,
      expiresAt: parsed.expiresAt ?? null,
      obtainedAt: parsed.obtainedAt ?? null,
      authType: parsed.authType ?? null,
      metadata: parsed.metadata ?? null,
    };
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    console.warn('[powersync-daemon] failed to read auth session cache', error);
    return null;
  }
}

export async function saveStoredAuthCredentials(sessionPath: string, credentials: StoredAuthCredentials): Promise<void> {
  await ensureDirectoryExists(sessionPath);
  const payload: Record<string, unknown> = {
    endpoint: credentials.endpoint,
    token: credentials.token,
    expiresAt: credentials.expiresAt ?? null,
    obtainedAt: credentials.obtainedAt ?? null,
    authType: credentials.authType ?? null,
    metadata: credentials.metadata ?? null,
  };
  await fs.writeFile(sessionPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export async function clearStoredAuthCredentials(sessionPath: string): Promise<void> {
  try {
    await fs.unlink(sessionPath);
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      return;
    }
    throw error;
  }
}
