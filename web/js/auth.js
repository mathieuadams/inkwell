// Cognito hosted sign-in with the authorization code flow + PKCE. No SDK needed.
const TOKENS_KEY = 'inkwell.tokens';
const REFRESH_KEY = 'inkwell.refresh';
const PKCE_KEY = 'inkwell.pkce';

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomString = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = (s) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));

function decodeJwt(jwt) {
  try {
    const part = jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(part), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function readJson(storage, key) {
  try { return JSON.parse(storage.getItem(key) || 'null'); } catch { return null; }
}

export function createAuth(cfg) {
  const redirectUri = `${location.origin}/`;
  let tokens = readJson(sessionStorage, TOKENS_KEY);
  let refreshing = null;

  function store(res) {
    tokens = {
      access: res.access_token,
      id: res.id_token || tokens?.id,
      exp: Date.now() + (res.expires_in || 3600) * 1000,
    };
    sessionStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
    if (res.refresh_token) localStorage.setItem(REFRESH_KEY, res.refresh_token);
  }

  function clear() {
    tokens = null;
    sessionStorage.removeItem(TOKENS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  }

  async function tokenRequest(params) {
    const res = await fetch(`${cfg.authDomain}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg.clientId, ...params }),
    });
    if (!res.ok) throw new Error('Your sign-in expired. Sign in again.');
    return res.json();
  }

  async function redirect(path) {
    const verifier = randomString(64);
    const state = randomString(24);
    sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
    const url = new URL(`${cfg.authDomain}${path}`);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: cfg.clientId,
      redirect_uri: redirectUri,
      scope: 'openid email profile',
      state,
      code_challenge_method: 'S256',
      code_challenge: b64url(await sha256(verifier)),
    }).toString();
    location.assign(url.toString());
  }

  return {
    signIn: () => redirect('/oauth2/authorize'),
    signUp: () => redirect('/signup'),

    /** Completes sign-in when Cognito redirects back with ?code=… */
    async handleRedirect() {
      const params = new URLSearchParams(location.search);
      const code = params.get('code');
      const error = params.get('error_description') || params.get('error');
      if (!code && !error) return false;
      history.replaceState(null, '', '/');
      if (error) throw new Error(`Sign-in didn't finish: ${error}`);
      const saved = readJson(sessionStorage, PKCE_KEY);
      sessionStorage.removeItem(PKCE_KEY);
      if (!saved || saved.state !== params.get('state')) throw new Error('Sign-in didn’t finish. Try again.');
      store(await tokenRequest({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        code_verifier: saved.verifier,
      }));
      return true;
    },

    /** A valid access token, refreshed when needed, or null when signed out. */
    async accessToken() {
      if (tokens && tokens.exp - 60_000 > Date.now()) return tokens.access;
      const refreshToken = localStorage.getItem(REFRESH_KEY);
      if (!refreshToken) return null;
      refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken })
        .then((res) => { store(res); return tokens.access; })
        .catch(() => { clear(); return null; })
        .finally(() => { refreshing = null; });
      return refreshing;
    },

    isSignedIn: () => Boolean(tokens || localStorage.getItem(REFRESH_KEY)),
    email: () => decodeJwt(tokens?.id || '')?.email || '',
    clear,

    signOut() {
      clear();
      const url = new URL(`${cfg.authDomain}/logout`);
      url.search = new URLSearchParams({ client_id: cfg.clientId, logout_uri: redirectUri }).toString();
      location.assign(url.toString());
    },
  };
}
