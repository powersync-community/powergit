import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

const DEFAULT_SESSION_RELATIVE_PATH = '.psgit/session.json';

export interface StoredAuthCredentials {
  endpoint: string;
  token: string;
  expiresAt?: string | null;
  obtainedAt?: string | null;
  authType?: string | null;
  metadata?: Record<string, unknown> | null;
}

export function resolveSessionPath(customPath?: string): string {
  if (customPath) {
    return resolve(customPath);
  }
  return resolve(homedir(), DEFAULT_SESSION_RELATIVE_PATH);
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
