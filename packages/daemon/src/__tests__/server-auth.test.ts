import { describe, expect, it } from 'vitest';
import { createDaemonServer } from '../server.js';

async function listenServer(
  options: Parameters<typeof createDaemonServer>[0],
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createDaemonServer(options);
  const address = await server.listen();
  const host = address.address === '::' ? '127.0.0.1' : address.address;
  const baseUrl = `http://${host}:${address.port}`;
  return {
    baseUrl,
    close: () => server.close(),
  };
}

describe('createDaemonServer auth routes', () => {
  it('serves auth status and device/logout handlers', async () => {
    let devicePayload: Record<string, unknown> | null = null;

    const { baseUrl, close } = await listenServer({
      host: '127.0.0.1',
      port: 0,
      getStatus: () => ({
        startedAt: new Date().toISOString(),
        connected: true,
        streamCount: 0,
      }),
      getAuthStatus: () => ({ status: 'ready', token: 'cached-token' }),
      handleAuthDevice: async (payload) => {
        devicePayload = payload;
        return { status: 'pending', reason: 'waiting' };
      },
      handleAuthLogout: async () => {
        return { status: 'auth_required', reason: 'signed out' };
      },
    });

    try {
      const statusRes = await fetch(`${baseUrl}/auth/status`);
      expect(statusRes.status).toBe(200);
      expect(await statusRes.json()).toEqual({ status: 'ready', token: 'cached-token' });

      const deviceRes = await fetch(`${baseUrl}/auth/device`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: 'device-code' }),
      });
      expect(deviceRes.status).toBe(202);
      expect(await deviceRes.json()).toEqual({ status: 'pending', reason: 'waiting' });
      expect(devicePayload).toEqual({ mode: 'device-code' });

      const logoutRes = await fetch(`${baseUrl}/auth/logout`, { method: 'POST' });
      expect(logoutRes.status).toBe(401);
      expect(await logoutRes.json()).toEqual({ status: 'auth_required', reason: 'signed out' });
    } finally {
      await close();
    }
  });

  it('serves the built-in device login UI under /auth/', async () => {
    const { baseUrl, close } = await listenServer({
      host: '127.0.0.1',
      port: 0,
      getStatus: () => ({
        startedAt: new Date().toISOString(),
        connected: true,
        streamCount: 0,
      }),
      authUi: {
        supabaseUrl: 'https://example.supabase.co',
        supabaseAnonKey: 'anon-key',
        title: 'Powergit Login',
      },
    });

    try {
      const redirectRes = await fetch(`${baseUrl}/auth?device_code=abc123`, { redirect: 'manual' });
      expect(redirectRes.status).toBe(302);
      expect(redirectRes.headers.get('location')).toBe('/auth/?device_code=abc123');

      const pageRes = await fetch(`${baseUrl}/auth/?device_code=abc123`);
      expect(pageRes.status).toBe(200);
      expect(pageRes.headers.get('content-type')).toContain('text/html');
      const html = await pageRes.text();
      expect(html).toContain('Powergit Login');
      expect(html).toContain('"supabaseUrl":"https://example.supabase.co"');

      const cssRes = await fetch(`${baseUrl}/auth/style.css`);
      expect(cssRes.status).toBe(200);
      expect(cssRes.headers.get('content-type')).toContain('text/css');

      const jsRes = await fetch(`${baseUrl}/auth/device-login.js`);
      expect(jsRes.status).toBe(200);
      expect(jsRes.headers.get('content-type')).toContain('application/javascript');
      expect(await jsRes.text()).toContain('submitDevice');

      const supabaseRes = await fetch(`${baseUrl}/auth/supabase.js`);
      expect(supabaseRes.status).toBe(200);
      expect(supabaseRes.headers.get('content-type')).toContain('application/javascript');
      const bundlePrefix = (await supabaseRes.text()).slice(0, 10);
      expect(bundlePrefix).toContain('!function');
    } finally {
      await close();
    }
  });

  it('adds CORS headers and responds to preflight requests', async () => {
    const { baseUrl, close } = await listenServer({
      host: '127.0.0.1',
      port: 0,
      cors: { origins: ['http://localhost:5783', 'http://127.0.0.1:5783'], allowHeaders: ['Content-Type'] },
      getStatus: () => ({
        startedAt: new Date().toISOString(),
        connected: true,
        streamCount: 0,
      }),
      getAuthStatus: () => ({ status: 'ready' }),
    });

    try {
      const preflight = await fetch(`${baseUrl}/auth/status`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:5783',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'Content-Type',
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe('http://localhost:5783');
      expect(preflight.headers.get('access-control-allow-methods')).toContain('GET');
      expect(preflight.headers.get('access-control-allow-headers')).toContain('Content-Type');

      const statusRes = await fetch(`${baseUrl}/auth/status`, {
        headers: { Origin: 'http://localhost:5783' },
      });
      expect(statusRes.status).toBe(200);
      expect(await statusRes.json()).toEqual({ status: 'ready' });
      expect(statusRes.headers.get('access-control-allow-origin')).toBe('http://localhost:5783');
    } finally {
      await close();
    }
  });
});
