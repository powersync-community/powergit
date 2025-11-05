import { EventEmitter } from 'node:events';
import type { PowerSyncCredentials } from '@powersync/node';
import {
  clearStoredAuthCredentials,
  loadStoredAuthCredentials,
  resolveSessionPath,
  saveStoredAuthCredentials,
  type StoredAuthCredentials,
} from './session.js';

export type AuthStatus = 'ready' | 'pending' | 'auth_required' | 'error';

export type AuthCredentialSource = 'guest' | 'device' | 'manual' | 'service' | 'env' | 'supabase';

export interface AuthCredentials {
  endpoint: string;
  token: string;
  expiresAt?: string | null;
  obtainedAt?: string | null;
  authType?: AuthCredentialSource | null;
  metadata?: Record<string, unknown> | null;
}

type AuthContext = Record<string, unknown> | null | undefined;

type InternalAuthState =
  | { status: 'auth_required'; reason?: string | null; context?: AuthContext }
  | { status: 'pending'; reason?: string | null; context?: AuthContext }
  | { status: 'error'; reason?: string | null; context?: AuthContext }
  | { status: 'ready'; credentials: AuthCredentials };

export interface AuthStatusPayload {
  status: AuthStatus;
  token?: string | { token?: string; value?: string };
  expiresAt?: string | null;
  reason?: string | null;
  context?: Record<string, unknown> | null;
}

export interface CreateDaemonAuthManagerOptions {
  sessionPath?: string;
  defaultEndpoint?: string;
  initialCredentials?: Partial<AuthCredentials>;
  now?: () => Date;
}

export interface WaitForCredentialsOptions {
  signal?: AbortSignal;
}

const AUTH_READY_EVENT = 'ready';
const AUTH_CHANGED_EVENT = 'changed';

/**
 * Tracks daemon authentication state and persists credentials to disk so the daemon can resume after restarts.
 */
export class DaemonAuthManager {
  private readonly sessionPath: string;
  private readonly eventTarget = new EventEmitter();
  private readonly now: () => Date;
  private defaultEndpoint?: string;
  private state: InternalAuthState = { status: 'auth_required', reason: 'initialising', context: null };

  private constructor(options: { sessionPath: string; defaultEndpoint?: string; now?: () => Date }) {
    this.sessionPath = options.sessionPath;
    this.defaultEndpoint = options.defaultEndpoint;
    this.now = options.now ?? (() => new Date());
  }

  static async create(options: CreateDaemonAuthManagerOptions = {}): Promise<DaemonAuthManager> {
    const sessionPath = resolveSessionPath(options.sessionPath);
    const manager = new DaemonAuthManager({
      sessionPath,
      defaultEndpoint: options.defaultEndpoint,
      now: options.now,
    });

    const stored = await loadStoredAuthCredentials(sessionPath);
    if (stored && stored.endpoint && stored.token) {
      await manager.applyReadyState(manager.normalizeStoredCredentials(stored), { emit: false, persist: false });
      manager.defaultEndpoint = manager.defaultEndpoint ?? stored.endpoint;
    } else if (options.initialCredentials?.token && (options.initialCredentials.endpoint ?? manager.defaultEndpoint)) {
      await manager
        .applyReadyState(manager.normalizeCredentials(options.initialCredentials), {
          persist: true,
          emit: false,
        })
        .catch((error) => {
          console.warn('[powersync-daemon] failed to persist initial credentials', error);
        });
    } else {
      manager.state = { status: 'auth_required', reason: 'missing credentials' };
    }

    return manager;
  }

  getSessionPath(): string {
    return this.sessionPath;
  }

  getStatusPayload(): AuthStatusPayload {
    const state = this.state;
    switch (state.status) {
      case 'ready':
        return {
          status: 'ready',
          token: { value: state.credentials.token, token: state.credentials.token },
          expiresAt: state.credentials.expiresAt ?? null,
          context: null,
        };
      case 'pending':
        return { status: 'pending', reason: state.reason ?? null, context: this.normalizeContext(state.context) };
      case 'error':
        return { status: 'error', reason: state.reason ?? null, context: this.normalizeContext(state.context) };
      case 'auth_required':
      default:
        return { status: 'auth_required', reason: state.reason ?? null, context: this.normalizeContext(state.context) };
    }
  }

  getCurrentState(): InternalAuthState {
    return this.state;
  }

  getReadyCredentials(): AuthCredentials | null {
    return this.state.status === 'ready' ? this.state.credentials : null;
  }

  getDefaultEndpoint(): string | undefined {
    if (this.state.status === 'ready') {
      this.defaultEndpoint = this.state.credentials.endpoint;
    }
    return this.defaultEndpoint;
  }

  async waitForCredentials(options: WaitForCredentialsOptions = {}): Promise<AuthCredentials | null> {
    const current = this.getReadyCredentials();
    if (current) {
      return current;
    }

    if (options.signal?.aborted) {
      return null;
    }

    return new Promise<AuthCredentials | null>((resolve) => {
      const handleReady = (credentials: AuthCredentials) => {
        cleanup();
        resolve(credentials);
      };

      const handleAbort = () => {
        cleanup();
        resolve(null);
      };

      const cleanup = () => {
        this.eventTarget.removeListener(AUTH_READY_EVENT, handleReady);
        options.signal?.removeEventListener('abort', handleAbort);
      };

      this.eventTarget.once(AUTH_READY_EVENT, handleReady);
      options.signal?.addEventListener('abort', handleAbort, { once: true });
    });
  }

  async setReadyCredentials(credentials: Partial<AuthCredentials> & { token: string }, options: { persist?: boolean; source?: AuthCredentialSource } = {}): Promise<void> {
    const normalized = this.normalizeCredentials({
      ...credentials,
      authType: options.source ?? credentials.authType ?? null,
    });
    await this.applyReadyState(normalized, { persist: options.persist !== false });
  }

  async setPending(reason?: string | null, context?: AuthContext): Promise<void> {
    this.state = { status: 'pending', reason: reason ?? null, context: context ?? null };
    this.emitChange();
  }

  async setError(reason?: string | null, context?: AuthContext): Promise<void> {
    this.state = { status: 'error', reason: reason ?? null, context: context ?? null };
    this.emitChange();
  }

  async setAuthRequired(reason?: string | null, context?: AuthContext): Promise<void> {
    this.state = { status: 'auth_required', reason: reason ?? null, context: context ?? null };
    this.emitChange();
  }

  async logout(reason?: string | null, context?: AuthContext): Promise<void> {
    await clearStoredAuthCredentials(this.sessionPath).catch((error) => {
      console.warn('[powersync-daemon] failed to clear auth session cache', error);
    });
    this.state = { status: 'auth_required', reason: reason ?? null, context: context ?? null };
    this.emitChange();
  }

  async refreshFromDisk(): Promise<void> {
    const stored = await loadStoredAuthCredentials(this.sessionPath);
    if (stored && stored.endpoint && stored.token) {
      await this.applyReadyState(this.normalizeStoredCredentials(stored), { persist: false });
    } else {
      await this.setAuthRequired('missing credentials');
    }
  }

  subscribe(listener: (state: InternalAuthState) => void): () => void {
    this.eventTarget.addListener(AUTH_CHANGED_EVENT, listener);
    return () => this.eventTarget.removeListener(AUTH_CHANGED_EVENT, listener);
  }

  toPowerSyncCredentials(): PowerSyncCredentials | null {
    const ready = this.getReadyCredentials();
    if (!ready) {
      return null;
    }
    return {
      endpoint: ready.endpoint,
      token: ready.token,
    };
  }

  private async applyReadyState(credentials: AuthCredentials, options: { persist?: boolean; emit?: boolean } = {}): Promise<void> {
    this.state = { status: 'ready', credentials };
    this.defaultEndpoint = credentials.endpoint;

    if (options.persist !== false) {
      await saveStoredAuthCredentials(this.sessionPath, {
        endpoint: credentials.endpoint,
        token: credentials.token,
        expiresAt: credentials.expiresAt ?? null,
        obtainedAt: credentials.obtainedAt ?? null,
        authType: credentials.authType ?? null,
        metadata: credentials.metadata ?? null,
      }).catch((error) => {
        console.warn('[powersync-daemon] failed to persist credentials', error);
      });
    }

    this.eventTarget.emit(AUTH_READY_EVENT, credentials);
    if (options.emit !== false) {
      this.emitChange();
    }
  }

  private emitChange(): void {
    this.eventTarget.emit(AUTH_CHANGED_EVENT, this.state);
  }

  private normalizeContext(context: AuthContext): Record<string, unknown> | null {
    if (!context || typeof context !== 'object') {
      return null;
    }
    if (Array.isArray(context)) {
      return null;
    }
    return context as Record<string, unknown>;
  }

  private normalizeStoredCredentials(input: StoredAuthCredentials): AuthCredentials {
    return this.normalizeCredentials({
      endpoint: input.endpoint,
      token: input.token,
      expiresAt: input.expiresAt ?? null,
      obtainedAt: input.obtainedAt ?? null,
      authType: (input.authType as AuthCredentialSource | null) ?? null,
      metadata: input.metadata ?? null,
    });
  }

  private normalizeCredentials(input: Partial<AuthCredentials>): AuthCredentials {
    const endpoint = (input.endpoint ?? this.defaultEndpoint ?? '').trim();
    const token = (input.token ?? '').trim();
    if (!endpoint) {
      throw new Error('PowerSync endpoint is required.');
    }
    if (!token) {
      throw new Error('PowerSync token is required.');
    }

    const obtainedAt = input.obtainedAt && input.obtainedAt.trim().length > 0 ? input.obtainedAt : this.now().toISOString();
    const expiresAt = input.expiresAt && input.expiresAt.trim().length > 0 ? input.expiresAt : null;

    return {
      endpoint,
      token,
      obtainedAt,
      expiresAt,
      authType: input.authType ?? null,
      metadata: input.metadata ?? null,
    };
  }
}
