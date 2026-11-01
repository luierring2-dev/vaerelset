import { test, assert, fakeFetch, json, empty } from './harness.js';
import { createMemoryBackend, createStorage } from '../js/storage.js';
import {
  AuthRequiredError, codeChallenge, createSpotify, NetworkError, NoDeviceError,
  normalizeAlbum, normalizeArtist, normalizePlaylist, normalizeTrack,
  parsePlayback, pickDevice, randomString, RateLimitError, redirectUriFrom, SCOPES, SpotifyError,
} from '../js/spotify.js';

const START = new Date(2026, 10, 1, 12, 0).getTime();

function setup(handler, { loggedIn = true, expiresIn = 3600000, scope = '', preferred = null } = {}) {
  const storage = createStorage(createMemoryBackend());
  let time = START;
  if (loggedIn) storage.set('spotify.tokens', { access: 'A1', refresh: 'R1', scope, expiresAt: START + expiresIn });
  const fetchFn = fakeFetch(handler);
  const spotify = createSpotify({
    getClientId: () => 'client123',
    fetch: fetchFn,
    storage,
    now: () => new Date(time),
    redirectUri: 'https://example.test/hjem/',
    getPreferredDeviceId: () => preferred,
  });
  return { spotify, storage, fetchFn, advance: (ms) => { time += ms; } };
}

const tokenResponse = (access = 'A2', refresh) => json({ access_token: access, expires_in: 3600, ...(refresh ? { refresh_token: refresh } : {}) });
const isToken = (call) => call.url.includes('accounts.spotify.com/api/token');
const devices = (list) => json({ devices: list });
const ipad = { id: 'ipad', type: 'Tablet', is_active: false, is_restricted: false };

test('login: returadressen matcher, også med index.html og kode i adressen', () => {
  assert.equal(redirectUriFrom('https://a.github.io/hjem/'), 'https://a.github.io/hjem/');
  assert.equal(redirectUriFrom('https://a.github.io/hjem/index.html'), 'https://a.github.io/hjem/');
  assert.equal(redirectUriFrom('https://a.github.io/hjem/?code=abc&state=x#t'), 'https://a.github.io/hjem/');
});

test('PKCE: kendt testvektor fra RFC 7636', async () => {
  const challenge = await codeChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('PKCE: tilfældig streng er lovlig og forskellig', () => {
  const a = randomString();
  assert.ok(/^[A-Za-z0-9_-]+$/.test(a), 'tegn');
  assert.ok(a.length >= 43 && a.length <= 128, 'længde');
  assert.ok(a !== randomString(), 'forskellig');
});

test('login: adressen indeholder alt, Spotify kræver', async () => {
  const { spotify } = setup(() => empty(), { loggedIn: false });
  const url = new URL(await spotify.beginLogin());
  assert.equal(url.origin + url.pathname, 'https://accounts.spotify.com/authorize');
  assert.equal(url.searchParams.get('client_id'), 'client123');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.test/hjem/');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('scope').includes('user-modify-playback-state'));
  assert.ok(url.searchParams.get('state'));
});

test('login: gennemføres og gemmer nøgler', async () => {
  const { spotify, fetchFn, storage } = setup(() => tokenResponse('A9', 'R9'), { loggedIn: false });
  const state = new URL(await spotify.beginLogin()).searchParams.get('state');
  assert.equal(await spotify.completeLogin(`?code=abc&state=${state}`), true);
  const body = new URLSearchParams(fetchFn.calls[0].body);
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('code'), 'abc');
  assert.ok(body.get('code_verifier'));
  assert.equal(storage.get('spotify.tokens').refresh, 'R9');
  assert.equal(spotify.isLoggedIn(), true);
});

test('login: forkert state afvises uden netværkskald', async () => {
  const { spotify, fetchFn } = setup(() => tokenResponse(), { loggedIn: false });
  await spotify.beginLogin();
  await assert.rejects(() => spotify.completeLogin('?code=abc&state=forkert'), SpotifyError);
  assert.equal(fetchFn.calls.length, 0);
});

test('login: uden påbegyndt login afvises (fx åbnet i anden app)', async () => {
  const { spotify } = setup(() => tokenResponse(), { loggedIn: false });
  await assert.rejects(() => spotify.completeLogin('?code=abc&state=x'), SpotifyError);
});

test('login: afvist af brugeren giver fejl', async () => {
  const { spotify } = setup(() => tokenResponse(), { loggedIn: false });
  const state = new URL(await spotify.beginLogin()).searchParams.get('state');
  const error = await assert.rejects(() => spotify.completeLogin(`?error=access_denied&state=${state}`), SpotifyError);
  assert.equal(error.message, 'Login blev afbrudt');
});

test('login: almindelig adresse ignoreres', async () => {
  const { spotify } = setup(() => empty(), { loggedIn: false });
  assert.equal(await spotify.completeLogin(''), false);
  assert.equal(await spotify.completeLogin('?noget=andet'), false);
});

test('loginkode: kan overføres mellem Safari og hjemmeskærms-app', async () => {
  const from = setup(() => empty());
  const code = from.spotify.exportLoginCode();
  const to = setup((call) => (isToken(call) ? tokenResponse('A5', 'R5') : empty()), { loggedIn: false });
  assert.equal(to.spotify.importLoginCode(code), 'client123');
  assert.equal(to.spotify.isLoggedIn(), true);
  await to.spotify.pause();
  assert.equal(new URLSearchParams(to.fetchFn.calls[0].body).get('refresh_token'), 'R1');
});

test('loginkode: ugyldig kode afvises og ændrer intet', async () => {
  const { spotify } = setup(() => empty(), { loggedIn: false });
  for (const bad of ['', 'ikke base64 !!', btoa('{"c":1}'), btoa('null'), btoa('{"c":"","r":""}')]) {
    await assert.rejects(async () => spotify.importLoginCode(bad), SpotifyError, bad);
  }
  assert.equal(spotify.isLoggedIn(), false);
});

test('nøgler: fornyes automatisk før udløb og bevarer refresh token', async () => {
  const { spotify, fetchFn, storage } = setup(
    (call) => (isToken(call) ? tokenResponse('A2') : empty()),
    { expiresIn: 10000 },
  );
  await spotify.pause();
  assert.ok(isToken(fetchFn.calls[0]));
  assert.equal(fetchFn.calls[1].headers.Authorization, 'Bearer A2');
  assert.equal(storage.get('spotify.tokens').refresh, 'R1');
});

test('nøgler: nyt refresh token gemmes, hvis Spotify roterer', async () => {
  const { spotify, storage } = setup(
    (call) => (isToken(call) ? tokenResponse('A2', 'R2') : empty()),
    { expiresIn: 0 },
  );
  await spotify.pause();
  assert.equal(storage.get('spotify.tokens').refresh, 'R2');
});

test('nøgler: samtidige kald fornyer kun én gang', async () => {
  const { spotify, fetchFn } = setup(
    (call) => (isToken(call) ? tokenResponse('A2') : empty()),
    { expiresIn: 0 },
  );
  await Promise.all([spotify.pause(), spotify.next(), spotify.previous()]);
  assert.equal(fetchFn.calls.filter(isToken).length, 1);
});

test('nøgler: 401 fornyer og prøver én gang igen', async () => {
  let first = true;
  const { spotify, fetchFn } = setup((call) => {
    if (isToken(call)) return tokenResponse('A2');
    if (first) { first = false; return json({}, 401); }
    return empty();
  });
  await spotify.pause();
  assert.equal(fetchFn.calls.length, 3);
  assert.equal(fetchFn.calls[2].headers.Authorization, 'Bearer A2');
});

test('nøgler: vedvarende 401 giver nyt login-krav uden løkke', async () => {
  const { spotify, fetchFn } = setup((call) => (isToken(call) ? tokenResponse('A2') : json({}, 401)));
  await assert.rejects(() => spotify.pause(), AuthRequiredError);
  assert.equal(fetchFn.calls.length, 3);
});

test('nøgler: tilbagekaldt login logger ud', async () => {
  const { spotify } = setup((call) => (isToken(call) ? json({ error: 'invalid_grant' }, 400) : empty()), { expiresIn: 0 });
  await assert.rejects(() => spotify.pause(), AuthRequiredError);
  assert.equal(spotify.isLoggedIn(), false);
});

test('nøgler: netudfald under fornyelse logger IKKE ud', async () => {
  let online = false;
  const { spotify } = setup((call) => {
    if (!online) throw new TypeError('offline');
    return isToken(call) ? tokenResponse('A2') : empty();
  }, { expiresIn: 0 });
  await assert.rejects(() => spotify.pause(), NetworkError);
  assert.equal(spotify.isLoggedIn(), true);
  online = true;
  await spotify.pause();
});

test('nøgler: uden login kræves login, og intet sendes', async () => {
  const { spotify, fetchFn } = setup(() => empty(), { loggedIn: false });
  await assert.rejects(() => spotify.getPlayback(), AuthRequiredError);
  assert.equal(fetchFn.calls.length, 0);
});

test('afspilning: 204 betyder at intet spiller', async () => {
  const { spotify } = setup(() => empty());
  assert.equal(await spotify.getPlayback(), null);
});

test('afspilning: læser sang, kunstnere og cover', () => {
  const result = parsePlayback({
    is_playing: true,
    device: { id: 'd', name: 'iPad' },
    item: { name: 'Sang', artists: [{ name: 'A' }, { name: 'B' }], album: { images: [{ url: 'u' }] } },
  });
  assert.deepEqual(result, { isPlaying: true, title: 'Sang', artist: 'A, B', coverUrl: 'u', deviceId: 'd', deviceName: 'iPad' });
});

test('afspilning: klarer podcast og manglende felter', () => {
  const episode = parsePlayback({ is_playing: false, item: { name: 'Afsnit', show: { name: 'Show' }, images: [{ url: 'e' }] } });
  assert.equal(episode.artist, 'Show');
  assert.equal(episode.coverUrl, 'e');
  const bare = parsePlayback({ is_playing: false, item: null });
  assert.equal(bare.title, '');
  assert.equal(bare.coverUrl, null);
});

test('afspilning: knapper bruger rette kald', async () => {
  const { spotify, fetchFn } = setup((call) => (call.url.endsWith('/devices') ? devices([ipad]) : empty()));
  await spotify.pause();
  await spotify.next();
  await spotify.previous();
  await spotify.play();
  const seen = fetchFn.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`);
  assert.deepEqual(seen, [
    'PUT /v1/me/player/pause',
    'POST /v1/me/player/next',
    'POST /v1/me/player/previous',
    'GET /v1/me/player/devices',
    'PUT /v1/me/player/play',
  ]);
});

test('afspilning: tåler svar med tekst, der ikke er JSON', async () => {
  const { spotify } = setup(() => new Response('ok', { status: 200 }));
  await spotify.pause();
});

test('enheder: vælger aktiv, så tablet, så første', () => {
  const phone = { id: 'p', type: 'Smartphone' };
  const active = { id: 'a', type: 'Computer', is_active: true };
  assert.equal(pickDevice([phone, ipad, active]).id, 'a');
  assert.equal(pickDevice([phone, ipad]).id, 'ipad');
  assert.equal(pickDevice([phone]).id, 'p');
  assert.equal(pickDevice([]), null);
  assert.equal(pickDevice([{ id: null }, { id: 'r', is_restricted: true }]), null);
});

test('enheder: ingen enhed giver besked om at åbne Spotify', async () => {
  const { spotify } = setup(() => devices([]));
  await assert.rejects(() => spotify.playPlaylist('spotify:playlist:x'), NoDeviceError);
});

test('enheder: 404 fra afspiller betyder ingen enhed', async () => {
  const { spotify } = setup(() => json({ error: { reason: 'NO_ACTIVE_DEVICE' } }, 404));
  await assert.rejects(() => spotify.pause(), NoDeviceError);
});

test('playlister: starter med context_uri på valgt enhed', async () => {
  const { spotify, fetchFn } = setup((call) => (call.url.endsWith('/devices') ? devices([ipad]) : empty()));
  await spotify.playPlaylist('spotify:playlist:x');
  const call = fetchFn.calls[1];
  assert.ok(call.url.endsWith('/me/player/play?device_id=ipad'));
  assert.deepEqual(JSON.parse(call.body), { context_uri: 'spotify:playlist:x' });
  assert.equal(call.headers['Content-Type'], 'application/json');
});

test('playlister: henter alle sider og fjerner tomme', async () => {
  const { spotify, fetchFn } = setup((call) => {
    const offset = Number(new URL(call.url).searchParams.get('offset'));
    if (offset === 0) return json({ items: [{ id: '1', name: 'En', uri: 'u1', images: [{ url: 'i' }] }, null], next: 'mere' });
    return json({ items: [{ id: '2', name: 'To', uri: 'u2', images: null }], next: null });
  });
  const lists = await spotify.getPlaylists();
  assert.deepEqual(lists.map((l) => l.name), ['En', 'To']);
  assert.equal(lists[1].imageUrl, null);
  assert.equal(fetchFn.calls.length, 2);
});

test('playlister: stopper ved loft, hvis Spotify bliver ved', async () => {
  const { spotify, fetchFn } = setup(() => json({ items: [], next: 'altid' }));
  await spotify.getPlaylists();
  assert.equal(fetchFn.calls.length, 4);
});

const track = (id) => ({
  id, uri: `spotify:track:${id}`, name: `Nummer ${id}`, artists: [{ name: 'A' }, { name: 'B' }], album: { images: [{ url: 'stor' }, { url: 'mellem' }, { url: 'lille' }] },
});

test('rettigheder: login beder om alt, musikskærmen og webafspilleren kræver', async () => {
  const { spotify } = setup(() => empty(), { loggedIn: false });
  const scope = new URL(await spotify.beginLogin()).searchParams.get('scope').split(' ');
  for (const needed of ['streaming', 'user-read-email', 'user-read-private', 'user-library-read', 'user-read-recently-played', 'playlist-read-private']) {
    assert.ok(scope.includes(needed), needed);
  }
});

test('rettigheder: gammelt login med færre rettigheder kræver nyt login', () => {
  assert.equal(setup(() => empty(), { scope: 'playlist-read-private' }).spotify.needsNewLogin(), true);
  assert.equal(setup(() => empty(), { scope: SCOPES.join(' ') }).spotify.needsNewLogin(), false);
  assert.equal(setup(() => empty(), { scope: '' }).spotify.needsNewLogin(), false, 'ukendt');
  assert.equal(setup(() => empty(), { loggedIn: false }).spotify.needsNewLogin(), false, 'ikke logget ind');
});

test('rettigheder: gemmes ved login og bevares, når Spotify ikke sender dem igen', async () => {
  const responses = [json({ access_token: 'A', refresh_token: 'R', expires_in: 0, scope: 'a b' }), json({ access_token: 'B', expires_in: 3600 }), empty()];
  const { spotify, storage } = setup(() => responses.shift(), { loggedIn: false });
  const state = new URL(await spotify.beginLogin()).searchParams.get('state');
  await spotify.completeLogin(`?code=x&state=${state}`);
  assert.equal(storage.get('spotify.tokens').scope, 'a b');
  await spotify.pause();
  assert.equal(storage.get('spotify.tokens').scope, 'a b');
});

test('rettigheder: login uden kendte rettigheder fornyes med det samme', async () => {
  const { spotify, storage, fetchFn } = setup((call) => (isToken(call) ? json({ access_token: 'A2', expires_in: 3600, scope: 'x' }) : empty()));
  const tokens = storage.get('spotify.tokens');
  delete tokens.scope;
  storage.set('spotify.tokens', tokens);
  await spotify.pause();
  assert.ok(isToken(fetchFn.calls[0]), 'fornyet');
  assert.equal(spotify.needsNewLogin(), true);
});

test('afspilning: sidens egen afspiller bruges først', async () => {
  const { spotify, fetchFn } = setup(() => empty(), { preferred: 'side' });
  await spotify.playPlaylist('spotify:playlist:x');
  assert.equal(fetchFn.calls.length, 1, 'enhedslisten behøves ikke');
  assert.ok(fetchFn.calls[0].url.endsWith('/me/player/play?device_id=side'));
});

test('afspilning: falder tilbage på Spotify-appen, hvis siden ikke kendes', async () => {
  const { spotify, fetchFn } = setup((call) => {
    if (call.url.includes('device_id=side')) return json({}, 404);
    if (call.url.endsWith('/devices')) return devices([ipad]);
    return empty();
  }, { preferred: 'side' });
  await spotify.playPlaylist('spotify:playlist:x');
  assert.ok(fetchFn.calls.at(-1).url.endsWith('device_id=ipad'));
  assert.deepEqual(JSON.parse(fetchFn.calls.at(-1).body), { context_uri: 'spotify:playlist:x' });
});

test('afspilning: andre fejl fra sidens afspiller vises og skjules ikke', async () => {
  const { spotify, fetchFn } = setup((call) => (call.url.endsWith('/devices') ? devices([ipad]) : json({}, 403)), { preferred: 'side' });
  const error = await assert.rejects(() => spotify.play(), SpotifyError);
  assert.equal(error.status, 403);
  assert.equal(fetchFn.calls.length, 1, 'skifter ikke stille over til appen');
});

test('afspilning: album eller playliste kan startes fra et bestemt nummer', async () => {
  const { spotify, fetchFn } = setup((call) => (call.url.endsWith('/devices') ? devices([ipad]) : empty()));
  await spotify.playContext('spotify:album:a', 'spotify:track:t');
  assert.deepEqual(JSON.parse(fetchFn.calls.at(-1).body), { context_uri: 'spotify:album:a', offset: { uri: 'spotify:track:t' } });
  await spotify.playContext('spotify:album:a');
  assert.deepEqual(JSON.parse(fetchFn.calls.at(-1).body), { context_uri: 'spotify:album:a' });
});

test('afspilning: en liste numre kan startes', async () => {
  const { spotify, fetchFn } = setup(() => empty(), { preferred: 'side' });
  await spotify.playTracks(['a', 'b']);
  assert.deepEqual(JSON.parse(fetchFn.calls[0].body), { uris: ['a', 'b'] });
});

test('browsing: numre, album, kunstnere og playlister læses rigtigt', () => {
  assert.deepEqual(normalizeTrack(track('t')), { kind: 'track', id: 't', uri: 'spotify:track:t', name: 'Nummer t', subtitle: 'A, B', imageUrl: 'mellem' });
  assert.equal(normalizeTrack({ uri: 'u', name: 'Afsnit', show: { name: 'Podcast' }, images: [{ url: 'e' }] }).subtitle, 'Podcast');
  assert.equal(normalizeTrack({ uri: 'u', name: 'x' }, 'album').imageUrl, 'album');
  assert.equal(normalizeAlbum({ uri: 'u', name: 'x', artists: [{ name: 'A' }], images: [] }).subtitle, 'A');
  assert.equal(normalizeArtist({ uri: 'u', name: 'x', images: null }).imageUrl, null);
  assert.equal(normalizePlaylist({ uri: 'u', name: 'x', owner: { display_name: 'Lui' } }).subtitle, 'Lui');
  for (const normalize of [normalizeTrack, normalizeAlbum, normalizeArtist, normalizePlaylist]) assert.equal(normalize(null), null);
});

test('søgning: sender rigtige parametre under Spotifys grænse på 10', async () => {
  const { spotify, fetchFn } = setup(() => json({}));
  await spotify.search('æ&ø = musik', 20);
  const params = new URL(fetchFn.calls[0].url).searchParams;
  assert.equal(params.get('q'), 'æ&ø = musik');
  assert.equal(params.get('type'), 'track,artist,album,playlist');
  assert.equal(params.get('limit'), '10');
  assert.equal(params.get('offset'), '20');
});

test('søgning: læser grupper, fjerner tomme og finder flere', async () => {
  const { spotify } = setup(() => json({
    tracks: { items: [track('t'), null], next: null },
    artists: { items: [{ id: 'k', uri: 'u', name: 'K' }], next: 'mere' },
    albums: { items: [] },
    playlists: { items: [null, { id: 'p', name: 'uden adresse' }] },
  }));
  const result = await spotify.search('x', 10);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.artists[0].subtitle, 'Kunstner');
  assert.equal(result.albums.length, 0);
  assert.equal(result.playlists.length, 0, 'uden adresse kan ikke bruges');
  assert.equal(result.nextOffset, 20);
});

test('søgning: tomt svar og ingen flere', async () => {
  const result = await setup(() => json({})).spotify.search('x');
  assert.deepEqual([result.tracks, result.nextOffset], [[], null]);
});

test('bibliotek: gemte numre og album læser track og album og finder næste side', async () => {
  const { spotify, fetchFn } = setup((call) => (call.url.includes('/me/tracks')
    ? json({ items: [{ track: track('t') }, null, { track: null }], next: 'mere' })
    : json({ items: [{ album: { id: 'a', uri: 'ua', name: 'A' } }], next: null })));
  const tracks = await spotify.getSavedTracks(50);
  assert.deepEqual([tracks.rows.length, tracks.nextOffset], [1, 100]);
  assert.ok(fetchFn.calls[0].url.endsWith('/me/tracks?limit=50&offset=50'));
  const albums = await spotify.getSavedAlbums();
  assert.deepEqual([albums.rows[0].kind, albums.nextOffset], ['album', null]);
});

test('bibliotek: hørt for nylig viser hvert nummer én gang', async () => {
  const { spotify, fetchFn } = setup(() => json({ items: [{ track: track('a') }, { track: track('a') }, { track: track('b') }] }));
  const { rows, nextOffset } = await spotify.getRecentTracks();
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b']);
  assert.equal(nextOffset, null);
  assert.ok(fetchFn.calls[0].url.endsWith('/me/player/recently-played?limit=50'));
});

test('playlist: læser det nye item-felt, tåler det gamle og fjerner lokale numre', async () => {
  const { spotify, fetchFn } = setup(() => json({
    items: [{ item: track('ny') }, { track: track('gl') }, { is_local: true, item: track('lokal') }, null],
    next: 'mere',
  }));
  const { rows, nextOffset } = await spotify.getPlaylistTracks('a/b', 50);
  assert.deepEqual(rows.map((row) => row.id), ['ny', 'gl']);
  assert.equal(nextOffset, 100);
  assert.ok(fetchFn.calls[0].url.includes('/playlists/a%2Fb/items?limit=50&offset=50'));
});

test('playlist: andres playlister giver en fejl med status 403', async () => {
  const error = await assert.rejects(() => setup(() => json({}, 403)).spotify.getPlaylistTracks('x'), SpotifyError);
  assert.equal(error.status, 403);
});

test('album: numre får albummets billede, fordi Spotify ikke sender det', async () => {
  const { spotify, fetchFn } = setup(() => json({ items: [{ id: 't', uri: 'ut', name: 'x', artists: [] }], next: null }));
  const { rows } = await spotify.getAlbumTracks('a1', 0, 'cover');
  assert.equal(rows[0].imageUrl, 'cover');
  assert.ok(fetchFn.calls[0].url.endsWith('/albums/a1/tracks?limit=50&offset=0'));
});

test('kunstner: album hentes under Spotifys grænse på 10', async () => {
  const { spotify, fetchFn } = setup(() => json({ items: [{ id: 'a', uri: 'ua', name: 'x' }], next: 'mere' }));
  const { rows, nextOffset } = await spotify.getArtistAlbums('k1', 10);
  assert.equal(rows.length, 1);
  assert.equal(nextOffset, 20);
  assert.ok(fetchFn.calls[0].url.endsWith('/artists/k1/albums?limit=10&offset=10'));
});

test('grænser: 429 holder pause og følger Retry-After', async () => {
  const { spotify, fetchFn, advance } = setup(() => json({}, 429, { 'Retry-After': '30' }));
  const error = await assert.rejects(() => spotify.pause(), RateLimitError);
  assert.equal(error.retryAfterMs, 30000);
  await assert.rejects(() => spotify.pause(), RateLimitError);
  assert.equal(fetchFn.calls.length, 1, 'ingen kald under pausen');
  advance(30001);
  await assert.rejects(() => spotify.pause(), RateLimitError);
  assert.equal(fetchFn.calls.length, 2);
});

test('grænser: 429 uden Retry-After venter 5 sekunder', async () => {
  const { spotify } = setup(() => json({}, 429));
  const error = await assert.rejects(() => spotify.pause(), RateLimitError);
  assert.equal(error.retryAfterMs, 5000);
});

test('fejl: 403 og 500 bliver til en SpotifyError', async () => {
  for (const status of [403, 500, 503]) {
    const { spotify } = setup(() => json({}, status));
    const error = await assert.rejects(() => spotify.pause(), SpotifyError);
    assert.equal(error.status, status);
  }
});

test('fejl: 404 uden for afspilleren er ikke enhedsfejl', async () => {
  const { spotify } = setup(() => json({}, 404));
  const error = await assert.rejects(() => spotify.getPlaylists(), SpotifyError);
  assert.ok(!(error instanceof NoDeviceError));
});
