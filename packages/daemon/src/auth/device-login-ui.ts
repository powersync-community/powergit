export type DeviceLoginUiConfig = {
  supabaseUrl?: string | null;
  supabaseAnonKey?: string | null;
  title?: string | null;
};

function safeInlineJson(value: unknown): string {
  // Prevent `</script>` injection via `<`.
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function renderDeviceLoginHtml(config: DeviceLoginUiConfig): string {
  const title = config.title && config.title.trim().length > 0 ? config.title.trim() : 'Powergit Login';
  const inlineConfig = safeInlineJson({
    supabaseUrl: config.supabaseUrl ?? null,
    supabaseAnonKey: config.supabaseAnonKey ?? null,
  });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <link rel="stylesheet" href="./style.css" />
  </head>
  <body>
    <main class="wrap">
      <div class="card">
        <h1>${title}</h1>
        <p class="muted">
          This page completes <code>powergit login</code> by signing into Supabase and sending the session to your local
          daemon.
        </p>

        <div id="configError" class="notice error hidden"></div>

        <div id="deviceInfo" class="notice info hidden">
          Device code: <code id="deviceCode"></code>
        </div>

        <div id="status" class="notice hidden"></div>

        <section id="signedOut" class="section hidden" aria-label="Sign in">
          <form id="signInForm" class="form">
            <label>
              Email
              <input id="email" name="email" type="email" autocomplete="username" required />
            </label>
            <label>
              Password
              <input id="password" name="password" type="password" autocomplete="current-password" required />
            </label>
            <button id="signInButton" type="submit">Sign in</button>
          </form>
          <p class="muted small">
            Run <code>powergit login</code> first so this page has a device code. Then sign in and keep this tab open
            until the CLI reports success.
          </p>
        </section>

        <section id="signedIn" class="section hidden" aria-label="Signed in">
          <div class="row">
            <div class="muted">Signed in as <span id="signedInEmail" class="mono"></span></div>
            <button id="signOutButton" type="button" class="secondary">Sign out</button>
          </div>
          <p class="muted small">
            If this tab shows “login complete”, you can return to the terminal.
          </p>
        </section>

        <details class="muted small">
          <summary>Troubleshooting</summary>
          <ul>
            <li>If you see <code>net::ERR_BLOCKED_BY_CLIENT</code>, disable ad blockers/privacy shields for localhost.</li>
            <li>Ensure the daemon is running: <code>powergit-daemon</code> (default port <code>5030</code>).</li>
          </ul>
        </details>
      </div>
    </main>

    <script>window.__POWERGIT_LOGIN_CONFIG__ = ${inlineConfig};</script>
    <script src="./supabase.js"></script>
    <script src="./device-login.js" defer></script>
  </body>
</html>`;
}

export const DEVICE_LOGIN_CSS = `
:root {
  color-scheme: light;
}
body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji";
  background: #f1f5f9;
  color: #0f172a;
}
.wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.card {
  width: 100%;
  max-width: 520px;
  background: white;
  border: 1px solid #e2e8f0;
  border-radius: 16px;
  box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08);
  padding: 24px;
}
h1 {
  font-size: 20px;
  margin: 0 0 8px;
}
.muted {
  color: #475569;
  margin: 0 0 16px;
}
.small {
  font-size: 12px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}
.notice {
  border-radius: 12px;
  padding: 12px 14px;
  margin: 12px 0;
  border: 1px solid #e2e8f0;
  background: #f8fafc;
}
.notice.info {
  border-color: #bae6fd;
  background: #eff6ff;
}
.notice.error {
  border-color: #fecaca;
  background: #fef2f2;
  color: #991b1b;
}
.section {
  margin-top: 16px;
}
.form {
  display: grid;
  gap: 12px;
}
label {
  display: grid;
  gap: 6px;
  font-size: 13px;
  color: #334155;
}
input {
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 14px;
}
button {
  border: none;
  border-radius: 10px;
  padding: 10px 12px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  background: #0f172a;
  color: white;
}
button.secondary {
  background: #e2e8f0;
  color: #0f172a;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.hidden {
  display: none;
}
details summary {
  cursor: pointer;
  margin-top: 12px;
}
details ul {
  margin: 8px 0 0 18px;
  padding: 0;
}
details li {
  margin: 6px 0;
}
`.trim();

export const DEVICE_LOGIN_JS = `
(function () {
  var config = window.__POWERGIT_LOGIN_CONFIG__ || {};
  var supabaseUrl = typeof config.supabaseUrl === 'string' ? config.supabaseUrl.trim() : '';
  var supabaseAnonKey = typeof config.supabaseAnonKey === 'string' ? config.supabaseAnonKey.trim() : '';

  var params = new URLSearchParams(window.location.search || '');
  var deviceCode = (params.get('device_code') || params.get('challenge') || params.get('state') || '').trim();

  var elConfigError = document.getElementById('configError');
  var elDeviceInfo = document.getElementById('deviceInfo');
  var elDeviceCode = document.getElementById('deviceCode');
  var elStatus = document.getElementById('status');
  var elSignedOut = document.getElementById('signedOut');
  var elSignedIn = document.getElementById('signedIn');
  var elSignedInEmail = document.getElementById('signedInEmail');
  var elSignOut = document.getElementById('signOutButton');
  var elSignInForm = document.getElementById('signInForm');
  var elSignInButton = document.getElementById('signInButton');
  var elEmail = document.getElementById('email');
  var elPassword = document.getElementById('password');

  function show(el) {
    if (el) el.classList.remove('hidden');
  }
  function hide(el) {
    if (el) el.classList.add('hidden');
  }
  function setStatus(kind, message) {
    if (!elStatus) return;
    elStatus.className = 'notice ' + (kind || '');
    elStatus.textContent = message || '';
    show(elStatus);
  }
  function setError(message) {
    if (!elConfigError) return;
    elConfigError.textContent = message || '';
    show(elConfigError);
  }

  if (deviceCode) {
    if (elDeviceCode) elDeviceCode.textContent = deviceCode;
    show(elDeviceInfo);
  } else {
    if (elDeviceCode) elDeviceCode.textContent = '';
    hide(elDeviceInfo);
  }

  if (!supabaseUrl || !supabaseAnonKey) {
    setError('Supabase config missing. Ensure SUPABASE_URL and SUPABASE_ANON_KEY are set (or use the prod profile defaults).');
    hide(elSignedOut);
    hide(elSignedIn);
    return;
  }

  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    setError('Supabase client failed to load. Reinstall the daemon/CLI package and try again.');
    hide(elSignedOut);
    hide(elSignedIn);
    return;
  }

  var supabase = window.supabase.createClient(supabaseUrl, supabaseAnonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      storageKey: 'powergit-device-login',
    },
  });

  var submitted = false;

  function getEmailFromSession(session) {
    if (!session || !session.user) return '';
    var email = session.user.email;
    return typeof email === 'string' ? email : '';
  }

  function renderSignedOut() {
    show(elSignedOut);
    hide(elSignedIn);
  }

  function renderSignedIn(session) {
    hide(elSignedOut);
    show(elSignedIn);
    if (elSignedInEmail) elSignedInEmail.textContent = getEmailFromSession(session) || '(unknown)';
  }

  async function submitDevice(session) {
    if (!deviceCode) {
      setStatus('info', 'No device code provided. Run \\"powergit login\\" and open the printed URL.');
      return false;
    }
    if (!session || !session.access_token || !session.refresh_token) {
      setStatus('error', 'Signed-in session is missing tokens. Please sign out and sign in again.');
      return false;
    }
    if (submitted) return true;
    submitted = true;
    setStatus('info', 'Submitting session to the daemon…');
    try {
      var res = await fetch('/auth/device', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          challengeId: deviceCode,
          session: {
            access_token: session.access_token,
            refresh_token: session.refresh_token,
            expires_in: typeof session.expires_in === 'number' ? session.expires_in : null,
            expires_at: typeof session.expires_at === 'number' ? session.expires_at : null,
          },
        }),
      });
      if (!res.ok) {
        submitted = false;
        setStatus('error', 'Daemon rejected the login (' + res.status + '). Return to the terminal and rerun \\"powergit login\\".');
        return false;
      }
      setStatus('info', 'Login complete. Return to the terminal.');
      return true;
    } catch (err) {
      submitted = false;
      setStatus('error', 'Failed to reach the daemon. Ensure powergit-daemon is running and try again.');
      return false;
    }
  }

  async function refresh() {
    var result = await supabase.auth.getSession();
    var session = result && result.data ? result.data.session : null;
    if (session) {
      renderSignedIn(session);
      await submitDevice(session);
      return;
    }
    renderSignedOut();
    if (deviceCode) {
      setStatus('info', 'Sign in to finish CLI login.');
    } else {
      setStatus('info', 'Run \\"powergit login\\" to generate a device code.');
    }
  }

  if (elSignOut) {
    elSignOut.addEventListener('click', function () {
      submitted = false;
      setStatus('info', 'Signing out…');
      supabase.auth.signOut().finally(function () {
        void refresh();
      });
    });
  }

  if (elSignInForm) {
    elSignInForm.addEventListener('submit', function (event) {
      event.preventDefault();
      submitted = false;
      if (elSignInButton) elSignInButton.disabled = true;
      var email = elEmail && elEmail.value ? String(elEmail.value).trim() : '';
      var password = elPassword && elPassword.value ? String(elPassword.value) : '';
      if (!email || !password) {
        setStatus('error', 'Email and password are required.');
        if (elSignInButton) elSignInButton.disabled = false;
        return;
      }
      setStatus('info', 'Signing in…');
      supabase.auth
        .signInWithPassword({ email: email, password: password })
        .then(function (resp) {
          if (resp && resp.error) {
            setStatus('error', resp.error.message || 'Sign-in failed.');
            return;
          }
          setStatus('info', 'Signed in. Completing CLI login…');
        })
        .catch(function () {
          setStatus('error', 'Sign-in failed.');
        })
        .finally(function () {
          if (elSignInButton) elSignInButton.disabled = false;
          void refresh();
        });
    });
  }

  supabase.auth.onAuthStateChange(function () {
    submitted = false;
    void refresh();
  });

  void refresh();
})();
`.trim();

