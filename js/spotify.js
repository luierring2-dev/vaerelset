import { fetchWithTimeout, NetworkError } from './http.js';

const AUTH_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_URL = 'https://api.spotify.com/v1';
const SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'playlist-read-private',
  'playlist-read-collaborative',
];

const TOKENS_KEY = 'spotify.tokens';
const PENDING_KEY = 'spotify.pendingLogin';
const EXPIRY_MARGIN_MS = 30000;
const MAX_PLAYLISTS = 200;

export class SpotifyError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'SpotifyError';
    this.status = status;
  }
}
export class AuthRequiredError extends SpotifyError {
  constructor() {
    super('Log ind på Spotify igen', 401);
    this.name = 'AuthRequiredError';
  }
}
export class NoDeviceError extends SpotifyError {
  constructor() {
    super('Spotify er ikke åben på iPad’en', 404);
    this.name = 'NoDeviceError';
  }
}
export class RateLimitError extends SpotifyError {
  constructor(retryAfterMs) {
    super('Spotify beder os vente lidt', 429);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(cryptoImpl = crypto, byteCount = 48) {
  return base64Url(cryptoImpl.getRandomValues(new Uint8Array(byteCount)));
}

export async function codeChallenge(verifier, cryptoImpl = crypto) {
  const digest = await cryptoImpl.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

// Spotify kræver præcis samme adresse, som er registreret på udviklersiden.
export function redirectUriFrom(pageUrl) {
  const url = new URL(pageUrl);
  return url.origin + url.pathname.replace(/index\.html$/, '');
}

export function pickDevice(devices) {
  const usable = devices.filter((device) => device.id && !device.is_restricted);
  return (
    usable.find((device) => device.is_active) ??
    usable.find((device) => device.type === 'Tablet') ??
    usable[0] ??
    null
  );
}

export function parsePlayback(json) {
  if (!json) return null;
  const item = json.item;
  const artists = item?.artists?.map((artist) => artist.name).join(', ') ?? item?.show?.name ?? '';
  const images = item?.album?.images ?? item?.images ?? [];
  return {
    isPlaying: Boolean(json.is_playing),
    title: item?.name ?? '',
    artist: artists,
    coverUrl: images[0]?.url ?? null,
    deviceId: json.device?.id ?? null,
    deviceName: json.device?.name ?? null,
  };
}

export function createSpotify({ getClientId, fetch: fetchFn, storage, now, redirectUri, cryptoImpl = crypto }) {
  let refreshing = null;
  let pausedUntil = 0;

  const time = () => now().getTime();
  const tokens = () => storage.get(TOKENS_KEY);

  function saveTokens(json, previousRefresh) {
    storage.set(TOKENS_KEY, {
      access: json.access_token,
      refresh: json.refresh_token ?? previousRefresh,
      expiresAt: time() + json.expires_in * 1000,
    });
  }

  async function postToken(params) {
    const response = await fetchWithTimeout(fetchFn, TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    if (response.status === 400 || response.status === 401) throw new AuthRequiredError();
    if (!response.ok) throw new SpotifyError('Spotify-login svarer ikke', response.status);
    return response.json();
  }

  function refreshTokens() {
    if (!refreshing) {
      refreshing = (async () => {
        const current = tokens();
        if (!current?.refresh) throw new AuthRequiredError();
        try {
          const json = await postToken({
            grant_type: 'refresh_token',
            refresh_token: current.refresh,
            client_id: getClientId(),
          });
          saveTokens(json, current.refresh);
        } catch (error) {
          // Kun et afvist login sletter nøglerne. Et netværksudfald må ikke logge ud.
          if (error instanceof AuthRequiredError) storage.remove(TOKENS_KEY);
          throw error;
        }
      })().finally(() => {
        refreshing = null;
      });
    }
    return refreshing;
  }

  async function accessToken() {
    const current = tokens();
    if (!current) throw new AuthRequiredError();
    if (current.expiresAt - EXPIRY_MARGIN_MS <= time()) await refreshTokens();
    return tokens().access;
  }

  async function request(method, path, body, retried = false) {
    if (pausedUntil > time()) throw new RateLimitError(pausedUntil - time());

    const token = await accessToken();
    const response = await fetchWithTimeout(fetchFn, `${API_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (response.status === 401 && !retried) {
      await refreshTokens();
      return request(method, path, body, true);
    }
    if (response.status === 401) throw new AuthRequiredError();
    if (response.status === 429) {
      const seconds = Number(response.headers.get('Retry-After'));
      const retryAfterMs = (Number.isFinite(seconds) && seconds > 0 ? seconds : 5) * 1000;
      pausedUntil = time() + retryAfterMs;
      throw new RateLimitError(retryAfterMs);
    }
    if (response.status === 404 && path.startsWith('/me/player')) throw new NoDeviceError();
    if (!response.ok) throw new SpotifyError('Spotify afviste kaldet', response.status);

    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function requireDevice() {
    const json = await request('GET', '/me/player/devices');
    const device = pickDevice(json?.devices ?? []);
    if (!device) throw new NoDeviceError();
    return device;
  }

  return {
    isLoggedIn: () => Boolean(tokens()?.refresh),

    logout: () => storage.remove(TOKENS_KEY),

    async beginLogin() {
      const verifier = randomString(cryptoImpl);
      const state = randomString(cryptoImpl, 16);
      if (!storage.set(PENDING_KEY, { verifier, state })) {
        throw new SpotifyError('iPad’en kan ikke gemme login');
      }
      const params = new URLSearchParams({
        client_id: getClientId(),
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: SCOPES.join(' '),
        state,
        code_challenge_method: 'S256',
        code_challenge: await codeChallenge(verifier, cryptoImpl),
      });
      return `${AUTH_URL}?${params}`;
    },

    // Returnerer false, hvis adressen ikke er et svar fra Spotify-login.
    async completeLogin(search) {
      const params = new URLSearchParams(search);
      const code = params.get('code');
      const denied = params.get('error');
      if (!code && !denied) return false;

      const pending = storage.get(PENDING_KEY);
      storage.remove(PENDING_KEY);
      if (!pending || pending.state !== params.get('state')) {
        throw new SpotifyError('Login kunne ikke bekræftes. Prøv igen');
      }
      if (denied) throw new SpotifyError('Login blev afbrudt');

      const json = await postToken({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: getClientId(),
        code_verifier: pending.verifier,
      });
      saveTokens(json);
      return true;
    },

    exportLoginCode() {
      const current = tokens();
      if (!current?.refresh) throw new AuthRequiredError();
      return btoa(JSON.stringify({ c: getClientId(), r: current.refresh }));
    },

    // Bruges, når login må ske i Safari og overføres til hjemmeskærms-appen.
    importLoginCode(code) {
      let parsed;
      try {
        parsed = JSON.parse(atob(code.trim()));
      } catch {
        throw new SpotifyError('Koden er ikke gyldig');
      }
      if (typeof parsed?.c !== 'string' || typeof parsed?.r !== 'string' || !parsed.c || !parsed.r) {
        throw new SpotifyError('Koden er ikke gyldig');
      }
      storage.set(TOKENS_KEY, { access: '', refresh: parsed.r, expiresAt: 0 });
      return parsed.c;
    },

    async getPlayback() {
      return parsePlayback(await request('GET', '/me/player'));
    },

    async getPlaylists() {
      const playlists = [];
      for (let offset = 0; offset < MAX_PLAYLISTS; offset += 50) {
        const json = await request('GET', `/me/playlists?limit=50&offset=${offset}`);
        const items = (json?.items ?? []).filter(Boolean);
        playlists.push(...items.map((item) => ({
          id: item.id,
          name: item.name,
          uri: item.uri,
          imageUrl: item.images?.[0]?.url ?? null,
        })));
        if (!json?.next) break;
      }
      return playlists;
    },

    async play() {
      const device = await requireDevice();
      await request('PUT', `/me/player/play?device_id=${encodeURIComponent(device.id)}`);
    },

    async pause() {
      await request('PUT', '/me/player/pause');
    },

    async next() {
      await request('POST', '/me/player/next');
    },

    async previous() {
      await request('POST', '/me/player/previous');
    },

    async playPlaylist(uri) {
      const device = await requireDevice();
      await request('PUT', `/me/player/play?device_id=${encodeURIComponent(device.id)}`, { context_uri: uri });
    },
  };
}

export { NetworkError };
