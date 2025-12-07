import http from 'node:http';
import type { AddressInfo } from 'node:net';
import busboy from 'busboy';
import type { GitPushSummary, PowerSyncImportJob, RefRow, RepoSummaryRow } from '@shared/core';
import type { PersistPushResult, PushUpdateRow } from './queries.js';
import { ImportValidationError } from './importer.js';

export interface DaemonStatusSnapshot {
  startedAt: string;
  connected: boolean;
  connectedAt?: string;
  streamCount: number;
}

export interface DaemonAuthResponse {
  status: string;
  token?: string;
  reason?: string;
  httpStatus?: number;
  expiresAt?: string | null;
  context?: Record<string, unknown> | null;
}

export interface SubscribeStreamsResult {
  added: string[];
  alreadyActive: string[];
  queued: string[];
}

export interface UnsubscribeStreamsResult {
  removed: string[];
  notFound: string[];
}

export interface StreamSubscriptionTarget {
  id: string;
  parameters?: Record<string, unknown> | null;
}

export interface GithubImportPayload {
  repoUrl: string;
  orgId?: string | null;
  repoId?: string | null;
  branch?: string | null;
}

export interface DaemonServerCorsOptions {
  origins?: string[];
  allowHeaders?: string[];
  allowMethods?: string[];
  allowCredentials?: boolean;
}

export interface DaemonServerOptions {
  host: string;
  port: number;
  getStatus: () => DaemonStatusSnapshot;
  onShutdownRequested?: () => Promise<void> | void;
  fetchRefs?: (params: { orgId: string; repoId: string; limit?: number }) => Promise<RefRow[]>;
  listRepos?: (params: { orgId: string; limit?: number }) => Promise<RepoSummaryRow[]>;
  getRepoSummary?: (params: { orgId: string; repoId: string }) => Promise<{ orgId: string; repoId: string; counts: Record<string, number> }>;
  fetchPack?: (params: { orgId: string; repoId: string; wants?: string[] }) => Promise<DaemonPackResponse | null>;
  pushPack?: (params: { orgId: string; repoId: string; payload: DaemonPushRequest }) => Promise<DaemonPushResponse>;
  deleteRepo?: (params: { orgId: string; repoId: string }) => Promise<{ ok: boolean; deletedPacks?: number } | void>;
  getPackDownloadUrl?: (params: { orgId: string; repoId: string; packOid: string }) => Promise<{ url: string; expiresAt?: string | null; sizeBytes?: number | null } | null>;
  getAuthStatus?: () => DaemonAuthResponse | Promise<DaemonAuthResponse>;
  handleAuthDevice?: (payload: Record<string, unknown>) => Promise<DaemonAuthResponse>;
  handleAuthLogout?: (payload: Record<string, unknown> | null) => Promise<DaemonAuthResponse>;
  listStreams?: () => Promise<StreamSubscriptionTarget[]> | StreamSubscriptionTarget[];
  subscribeStreams?: (streams: StreamSubscriptionTarget[]) => Promise<SubscribeStreamsResult> | SubscribeStreamsResult;
  unsubscribeStreams?: (streams: StreamSubscriptionTarget[]) => Promise<UnsubscribeStreamsResult> | UnsubscribeStreamsResult;
  listImportJobs?: () => Promise<PowerSyncImportJob[]> | PowerSyncImportJob[];
  getImportJob?: (id: string) => Promise<PowerSyncImportJob | null> | PowerSyncImportJob | null;
  importGithubRepo?: (payload: GithubImportPayload) => Promise<PowerSyncImportJob>;
  cors?: DaemonServerCorsOptions;
}

export interface DaemonServer {
  listen: () => Promise<AddressInfo>;
  close: () => Promise<void>;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

async function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return chunks.length === 0 ? Buffer.alloc(0) : Buffer.concat(chunks);
}

async function readJsonBody<T = unknown>(req: http.IncomingMessage): Promise<T | null> {
  const raw = await readRequestBody(req);
  if (!raw || raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8')) as T;
  } catch (error) {
    console.warn('[powersync-daemon] failed to parse JSON body', error);
    return null;
  }
}

export interface DaemonPackResponse {
  packBase64?: string;
  encoding?: string;
  packUrl?: string;
  packHeaders?: Record<string, string>;
  packOid?: string | null;
  createdAt?: string | null;
  size?: number;
}

export interface DaemonPushRequest {
  updates: PushUpdateRow[];
  packBase64?: string;
  packEncoding?: string;
  packOid?: string;
  summary?: GitPushSummary | null;
  dryRun?: boolean;
  createdAt?: string | null;
}

export type DaemonPushResponse = PersistPushResult & { message?: string };

function allowedMethodsForPath(pathname: string, options: DaemonServerOptions): string[] | null {
  if (/^\/repos\/import\/[^/]+$/.test(pathname)) {
    return options.getImportJob ? ['GET'] : null;
  }

  if (/^\/orgs\/[^/]+\/repos\/[^/]+$/.test(pathname)) {
    const methods: string[] = [];
    if (options.deleteRepo) methods.push('DELETE');
    return methods.length > 0 ? methods : null;
  }

  if (/^\/orgs\/[^/]+\/repos\/[^/]+\/packs\/[^/]+$/.test(pathname)) {
    return options.getPackDownloadUrl ? ['GET'] : null;
  }

  switch (pathname) {
    case '/auth/status':
      return options.getAuthStatus ? ['GET'] : null;
    case '/auth/device':
      return options.handleAuthDevice ? ['POST'] : null;
    case '/auth/logout':
      return options.handleAuthLogout ? ['POST'] : null;
    case '/streams':
      return ['GET', 'POST', 'DELETE'];
    case '/repos/import': {
      const methods: string[] = [];
      if (options.listImportJobs) methods.push('GET');
      if (options.importGithubRepo) methods.push('POST');
      return methods.length > 0 ? methods : null;
    }
    default:
      return null;
  }
}

function sanitizeStreamParameters(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result: Record<string, unknown> = {};
  for (const rawKey of Object.keys(value)) {
    const key = rawKey.trim();
    if (!key) continue;
    const raw = (value as Record<string, unknown>)[rawKey];
    if (raw === undefined) continue;
    if (raw === null) {
      result[key] = null;
      continue;
    }
    if (typeof raw === 'string') {
      const trimmedValue = raw.trim();
      result[key] = trimmedValue.length > 0 ? trimmedValue : raw;
      continue;
    }
    if (typeof raw === 'number' || typeof raw === 'boolean') {
      result[key] = raw;
      continue;
    }
    result[key] = String(raw);
  }
  return Object.keys(result).length > 0 ? result : null;
}

function sanitizeStreams(value: unknown): StreamSubscriptionTarget[] {
  if (!Array.isArray(value)) return [];
  const streams: StreamSubscriptionTarget[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      const id = entry.trim();
      if (id.length > 0) {
        streams.push({ id });
      }
      continue;
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const candidate = entry as { id?: unknown; stream?: unknown; parameters?: unknown; params?: unknown };
      const idSource =
        typeof candidate.id === 'string'
          ? candidate.id
          : typeof candidate.stream === 'string'
            ? candidate.stream
            : '';
      const id = idSource.trim();
      if (!id) continue;
      const parameters = sanitizeStreamParameters(candidate.parameters ?? candidate.params ?? null);
      streams.push({ id, parameters });
    }
  }
  return streams;
}

export function createDaemonServer(options: DaemonServerOptions): DaemonServer {
  const corsConfig = options.cors;

  function resolveAllowedOrigin(origin?: string | null): string | null {
    if (!corsConfig) return null;
    if (!origin) return null;
    const { origins } = corsConfig;
    if (!origins || origins.length === 0 || origins.includes('*') || origins.includes(origin)) {
      return origins?.includes('*') ? '*' : origin;
    }
    return null;
  }

  function applyCorsHeaders(res: http.ServerResponse, origin?: string | null): boolean {
    if (!corsConfig) return false;
    res.setHeader('Vary', 'Origin');
    const allowedOrigin = resolveAllowedOrigin(origin);
    if (!allowedOrigin) return false;
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    if (corsConfig.allowCredentials) {
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    return true;
  }

  const server = http.createServer((req, res) => {
    const handler = async () => {
      if (!req.url) {
        res.statusCode = 400;
        res.end();
        return;
      }

      const url = new URL(req.url, `http://${req.headers.host ?? options.host}`);
      const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : undefined;

      if (req.method === 'OPTIONS') {
        const methods = allowedMethodsForPath(url.pathname, options);
        if (!methods) {
          res.statusCode = 404;
          res.end();
          return;
        }
        if (applyCorsHeaders(res, originHeader)) {
          const allowHeaders = corsConfig?.allowHeaders ?? ['Content-Type'];
          const allowMethods = corsConfig?.allowMethods ?? Array.from(new Set([...methods, 'OPTIONS']));
          res.setHeader('Access-Control-Allow-Methods', allowMethods.join(', '));
          res.setHeader('Access-Control-Allow-Headers', allowHeaders.join(', '));
        }
        res.statusCode = 204;
        res.end();
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/healthz' || url.pathname === '/status')) {
        applyCorsHeaders(res, originHeader);
        sendJson(res, 200, options.getStatus());
        return;
      }

      if (req.method === 'GET' && url.pathname === '/auth/status' && options.getAuthStatus) {
        try {
          const payload = await options.getAuthStatus();
          applyCorsHeaders(res, originHeader);
          sendJson(res, 200, payload ?? {});
        } catch (error) {
          console.error('[powersync-daemon] failed to resolve auth status', error);
          res.statusCode = 500;
          res.end();
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/auth/device' && options.handleAuthDevice) {
        try {
          const payload = (await readJsonBody<Record<string, unknown>>(req)) ?? {};
          const response = await options.handleAuthDevice(payload);
          const { httpStatus, ...rest } = response ?? {};
          const status = httpStatus ?? (rest?.status === 'pending' ? 202 : 200);
          applyCorsHeaders(res, originHeader);
          sendJson(res, status, rest ?? {});
        } catch (error) {
          console.error('[powersync-daemon] device auth handler failed', error);
          res.statusCode = 500;
          res.end();
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/auth/logout' && options.handleAuthLogout) {
        try {
          const payload = await readJsonBody<Record<string, unknown>>(req);
          const response = await options.handleAuthLogout(payload ?? null);
          const { httpStatus, ...rest } = response ?? {};
          const status = httpStatus ?? (rest?.status === 'auth_required' ? 401 : 200);
          applyCorsHeaders(res, originHeader);
          sendJson(res, status, rest ?? {});
        } catch (error) {
          console.error('[powersync-daemon] logout handler failed', error);
          res.statusCode = 500;
          res.end();
        }
        return;
      }

      if (req.method === 'GET' && options.fetchRefs) {
        const match = /^\/orgs\/([^/]+)\/repos\/([^/]+)\/refs$/.exec(url.pathname);
        if (match) {
          const [, rawOrg, rawRepo] = match;
          const orgId = decodeURIComponent(rawOrg);
          const repoId = decodeURIComponent(rawRepo);
          const limitParam = url.searchParams.get('limit');
          const limit = limitParam ? Number(limitParam) : undefined;

          if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
            res.statusCode = 400;
            res.end();
            return;
          }

          try {
            const rows = await options.fetchRefs({ orgId, repoId, limit });
            applyCorsHeaders(res, originHeader);
            sendJson(res, 200, { orgId, repoId, refs: rows });
          } catch (error) {
            console.error('[powersync-daemon] failed to fetch refs', error);
            res.statusCode = 500;
            res.end();
          }
          return;
        }
      }

      if (req.method === 'GET' && options.getRepoSummary) {
        const match = /^\/orgs\/([^/]+)\/repos\/([^/]+)\/summary$/.exec(url.pathname);
        if (match) {
          const [, rawOrg, rawRepo] = match;
          const orgId = decodeURIComponent(rawOrg);
          const repoId = decodeURIComponent(rawRepo);
          try {
            const summary = await options.getRepoSummary({ orgId, repoId });
            applyCorsHeaders(res, originHeader);
            sendJson(res, 200, summary ?? { orgId, repoId, counts: {} });
          } catch (error) {
            console.error('[powersync-daemon] failed to fetch repo summary', error);
            res.statusCode = 500;
            res.end();
          }
          return;
        }
      }

      if (req.method === 'GET' && options.listRepos) {
        const match = /^\/orgs\/([^/]+)\/repos$/.exec(url.pathname);
        if (match) {
          const [, rawOrg] = match;
          const orgId = decodeURIComponent(rawOrg);
          const limitParam = url.searchParams.get('limit');
          const limit = limitParam ? Number(limitParam) : undefined;

          if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) {
            res.statusCode = 400;
            res.end();
            return;
          }

          try {
            const rows = await options.listRepos({ orgId, limit });
            applyCorsHeaders(res, originHeader);
            sendJson(res, 200, { orgId, repos: rows });
          } catch (error) {
            console.error('[powersync-daemon] failed to list repos', error);
            res.statusCode = 500;
            res.end();
          }
          return;
        }
      }

      if (req.method === 'GET' && url.pathname === '/streams' && options.listStreams) {
        try {
          const streams = await options.listStreams();
          applyCorsHeaders(res, originHeader);
          sendJson(res, 200, { streams: streams ?? [] });
        } catch (error) {
          console.error('[powersync-daemon] failed to list streams', error);
          res.statusCode = 500;
          res.end();
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/streams' && options.subscribeStreams) {
        try {
          const body = await readJsonBody<{ streams?: unknown }>(req);
          const streams = sanitizeStreams(body?.streams);
          if (streams.length === 0) {
            res.statusCode = 400;
            res.end();
            return;
          }
          const payload = await options.subscribeStreams(streams);
          applyCorsHeaders(res, originHeader);
          sendJson(res, 200, payload ?? { added: [], alreadyActive: [], queued: [] });
        } catch (error) {
          console.error('[powersync-daemon] failed to subscribe streams', error);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.end();
          }
        }
        return;
      }

      if (req.method === 'DELETE' && url.pathname === '/streams' && options.unsubscribeStreams) {
        try {
          const body = await readJsonBody<{ streams?: unknown }>(req);
          const streams = sanitizeStreams(body?.streams);
          if (streams.length === 0) {
            res.statusCode = 400;
            res.end();
            return;
          }
          const payload = await options.unsubscribeStreams(streams);
          applyCorsHeaders(res, originHeader);
          sendJson(res, 200, payload ?? { removed: [], notFound: [] });
        } catch (error) {
          console.error('[powersync-daemon] failed to unsubscribe streams', error);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.end();
          }
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/repos/import' && options.listImportJobs) {
        try {
          const jobs = await options.listImportJobs();
          applyCorsHeaders(res, originHeader);
          sendJson(res, 200, { jobs: jobs ?? [] });
        } catch (error) {
          console.error('[powersync-daemon] failed to list import jobs', error);
          res.statusCode = 500;
          res.end();
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/repos/import' && options.importGithubRepo) {
        try {
          const body = await readJsonBody<GithubImportPayload>(req);
          if (!body || typeof body.repoUrl !== 'string' || body.repoUrl.trim().length === 0) {
            applyCorsHeaders(res, originHeader);
            sendJson(res, 400, { error: 'repoUrl is required' });
            return;
          }
          const payload: GithubImportPayload = {
            repoUrl: body.repoUrl,
            orgId: typeof body.orgId === 'string' ? body.orgId : null,
            repoId: typeof body.repoId === 'string' ? body.repoId : null,
            branch: typeof body.branch === 'string' ? body.branch : null,
          };
          const job = await options.importGithubRepo(payload);
          applyCorsHeaders(res, originHeader);
          sendJson(res, 202, { job });
        } catch (error) {
          if (error instanceof ImportValidationError) {
            applyCorsHeaders(res, originHeader);
            sendJson(res, 400, { error: error.message });
            return;
          }
          console.error('[powersync-daemon] failed to enqueue GitHub import', error);
          res.statusCode = 500;
          res.end();
        }
        return;
      }

      if (req.method === 'GET' && options.getImportJob) {
        const match = /^\/repos\/import\/([^/]+)$/.exec(url.pathname);
        if (match) {
          const [, rawJobId] = match;
          const jobId = decodeURIComponent(rawJobId);
          try {
            const job = await options.getImportJob(jobId);
            if (!job) {
              res.statusCode = 404;
              res.end();
              return;
            }
            applyCorsHeaders(res, originHeader);
            sendJson(res, 200, { job });
          } catch (error) {
            console.error('[powersync-daemon] failed to fetch import job', error);
            res.statusCode = 500;
            res.end();
          }
          return;
        }
      }

      if (req.method === 'DELETE' && options.deleteRepo) {
        const match = /^\/orgs\/([^/]+)\/repos\/([^/]+)$/.exec(url.pathname);
        if (match) {
          const [, rawOrg, rawRepo] = match;
          const orgId = decodeURIComponent(rawOrg);
          const repoId = decodeURIComponent(rawRepo);
          try {
            const payload = await options.deleteRepo({ orgId, repoId });
            applyCorsHeaders(res, originHeader);
            sendJson(res, 200, payload ?? { ok: true });
          } catch (error) {
            console.error('[powersync-daemon] failed to delete repo data', error);
            res.statusCode = 500;
            applyCorsHeaders(res, originHeader);
            res.end();
          }
          return;
        }
      }

      if (req.method === 'POST' && options.fetchPack) {
        const match = /^\/orgs\/([^/]+)\/repos\/([^/]+)\/git\/fetch$/.exec(url.pathname);
        if (match) {
          const [, rawOrg, rawRepo] = match;
          const orgId = decodeURIComponent(rawOrg);
          const repoId = decodeURIComponent(rawRepo);

          try {
            const body = await readJsonBody<{ wants?: unknown }>(req);
            const wants = Array.isArray(body?.wants)
              ? body!.wants.filter((value): value is string => typeof value === 'string' && value.length > 0)
              : undefined;
            const payload = await options.fetchPack({ orgId, repoId, wants });
            if (!payload) {
              res.statusCode = 404;
              res.end();
              return;
            }
            const response: Record<string, unknown> = {};
            if (payload.packUrl) {
              response.packUrl = payload.packUrl;
              if (payload.packHeaders) {
                response.packHeaders = payload.packHeaders;
              }
            } else if (payload.packBase64) {
              response.pack = payload.packBase64;
              response.packEncoding = payload.encoding ?? 'base64';
            } else {
              res.statusCode = 204;
              res.end();
              return;
            }
            if (payload.packOid) {
              response.keep = payload.packOid;
            }
            if (payload.size !== undefined) {
              response.size = payload.size;
            }
            if (payload.createdAt) {
              response.createdAt = payload.createdAt;
            }
            applyCorsHeaders(res, originHeader);
            sendJson(res, 200, response);
          } catch (error) {
            console.error('[powersync-daemon] failed to serve pack', error);
            res.statusCode = 500;
            res.end();
          }
          return;
        }
      }

      if (req.method === 'GET' && options.getPackDownloadUrl) {
        const match = /^\/orgs\/([^/]+)\/repos\/([^/]+)\/packs\/([^/]+)$/.exec(url.pathname);
        if (match) {
          const [, rawOrg, rawRepo, rawPack] = match;
          const orgId = decodeURIComponent(rawOrg);
          const repoId = decodeURIComponent(rawRepo);
          const packOid = decodeURIComponent(rawPack);
          try {
            const payload = await options.getPackDownloadUrl({ orgId, repoId, packOid });
            if (!payload || !payload.url) {
              res.statusCode = 404;
              res.end();
              return;
            }
            applyCorsHeaders(res, originHeader);
            sendJson(res, 200, payload);
          } catch (error) {
            console.error('[powersync-daemon] failed to generate pack download url', error);
            res.statusCode = 500;
            res.end();
          }
          return;
        }
      }

      if (req.method === 'POST' && options.pushPack) {
        const match = /^\/orgs\/([^/]+)\/repos\/([^/]+)\/git\/push$/.exec(url.pathname);
        if (match) {
          const [, rawOrg, rawRepo] = match;
          const orgId = decodeURIComponent(rawOrg);
          const repoId = decodeURIComponent(rawRepo);
          const contentType = req.headers['content-type'] ?? '';

          try {
            const payload = await parsePushPayload(req, contentType);
            if (!payload || !Array.isArray(payload.updates) || payload.updates.length === 0) {
              res.statusCode = 400;
              res.end();
              return;
            }
            const result = await options.pushPack({ orgId, repoId, payload });
            if (result) {
              applyCorsHeaders(res, originHeader);
              sendJson(res, 200, result);
            }
          } catch (error) {
            console.error('[powersync-daemon] failed to process push', error);
            if (!res.writableEnded) {
              res.statusCode = 500;
              res.end();
            }
          }
          return;
        }
      }

      if (req.method === 'POST' && url.pathname === '/shutdown') {
        if (!options.onShutdownRequested) {
          res.statusCode = 503;
          res.end();
          return;
        }
        try {
          await options.onShutdownRequested();
          applyCorsHeaders(res, originHeader);
          sendJson(res, 202, { accepted: true });
        } catch (error) {
          console.error('[powersync-daemon] failed to process shutdown request', error);
          res.statusCode = 500;
          res.end();
        }
        return;
      }

      res.statusCode = req.method === 'GET' ? 404 : 405;
      if (res.statusCode === 405) {
        const allow = corsConfig?.allowMethods ?? ['GET', 'POST', 'DELETE', 'OPTIONS'];
        res.setHeader('Allow', allow.join(', '));
      }
      res.end();
    };

    handler().catch((error) => {
      console.error('[powersync-daemon] request handler error', error);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end();
      }
    });
  });

  return {
    listen: () =>
      new Promise<AddressInfo>((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, options.host, () => {
          server.off('error', reject);
          resolve(server.address() as AddressInfo);
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

async function parsePushPayload(req: http.IncomingMessage, contentType: string): Promise<DaemonPushRequest | null> {
  if (/multipart\/form-data/i.test(contentType)) {
    return new Promise<DaemonPushRequest | null>((resolve, reject) => {
      const bb = busboy({
        headers: req.headers,
        limits: {
          fieldSize: 25 * 1024 * 1024, // allow metadata payloads up to ~25MB
        },
      });
      const packChunks: Buffer[] = [];
      let metadata: unknown = null;
      let metadataError: Error | null = null;

      bb.on('file', (fieldname: string, file: NodeJS.ReadableStream) => {
        if (fieldname === 'pack') {
          file.on('data', (chunk: Buffer) => {
            packChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          });
          file.once('end', () => {
            // no-op; ensures stream fully consumed
          });
          file.once('error', (error: Error) => {
            metadataError = metadataError ?? error;
          });
        } else {
          file.resume();
        }
      });

      bb.on('field', (fieldname: string, value: string) => {
        if (fieldname !== 'metadata') return;
        try {
          metadata = JSON.parse(value);
        } catch (error) {
          metadataError = new Error('Invalid metadata JSON');
        }
      });

      bb.once('error', (error: Error) => {
        reject(error);
      });

      bb.once('finish', () => {
        if (metadataError) {
          reject(metadataError);
          return;
        }
        const packBase64 = packChunks.length > 0 ? Buffer.concat(packChunks).toString('base64') : undefined;
        try {
          resolve(normalizePushPayload(metadata, packBase64));
        } catch (error) {
          reject(error as Error);
        }
      });

      req.pipe(bb);
    });
  }

  const body = await readJsonBody<unknown>(req);
  return normalizePushPayload(body ?? undefined, undefined);
}

function normalizePushPayload(raw: unknown, packFromStream?: string): DaemonPushRequest | null {
  const updates = parseUpdates((raw as { updates?: unknown })?.updates);
  const packBase64 = packFromStream ?? (typeof (raw as any)?.pack === 'string' ? ((raw as any).pack as string) : undefined);
  const packEncoding = typeof (raw as any)?.packEncoding === 'string' ? ((raw as any).packEncoding as string) : undefined;
  const rawOptions = (raw as any)?.options && typeof (raw as any).options === 'object' ? ((raw as any).options as Record<string, unknown>) : undefined;
  const packOidOption = rawOptions && typeof rawOptions.packOid === 'string' ? (rawOptions.packOid as string) : undefined;
  const packOid = typeof (raw as any)?.packOid === 'string' ? ((raw as any).packOid as string) : packOidOption;
  const summaryCandidate = (raw as any)?.summary ?? rawOptions?.summary;
  const summary = summaryCandidate && typeof summaryCandidate === 'object' ? (summaryCandidate as GitPushSummary) : null;
  const dryRunFlag = (raw as any)?.dryRun === true || (rawOptions?.dryRun === true);

  return {
    updates,
    packBase64,
    packEncoding,
    packOid,
    summary,
    dryRun: dryRunFlag ? true : undefined,
  };
}

function parseUpdates(raw: unknown): PushUpdateRow[] {
  if (!Array.isArray(raw)) return [];
  const updates: PushUpdateRow[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const src = typeof (entry as any).src === 'string' ? ((entry as any).src as string) : '';
    const dst = typeof (entry as any).dst === 'string' ? ((entry as any).dst as string) : '';
    if (!dst) continue;
    const update: PushUpdateRow = { src, dst };
    if ((entry as any).force === true) {
      update.force = true;
    }
    updates.push(update);
  }
  return updates;
}
