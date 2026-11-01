// Kører den rigtige side (markup fra index.html og style.css) mod en falsk
// Spotify og et falsk vejr-API. Intet her rammer internettet.
import { test, assert, runAll, json, empty } from './harness.js';
import { start } from '../js/app.js';
import { DEFAULT_CLIENT_ID } from '../js/config.js';
import { createMemoryBackend, createStorage } from '../js/storage.js';

const markup = new DOMParser().parseFromString(await (await fetch('../index.html')).text(), 'text/html');
markup.querySelectorAll('script').forEach((script) => script.remove());

const $ = (id) => document.getElementById(id);
const pause = (ms = 0) => new Promise((resolve) => { setTimeout(resolve, ms); });
const PLACE = { name: 'Aarhus', latitude: 56.15, longitude: 10.2 };
const AARHUS_RESULT = { name: 'Aarhus', admin1: 'Midtjylland', country: 'Danmark', latitude: 56.15, longitude: 10.2 };

const unhandled = [];
window.addEventListener('unhandledrejection', (event) => unhandled.push(String(event.reason)));
window.addEventListener('error', (event) => unhandled.push(event.message));

function fakeWorld() {
  const world = {
    online: true,
    devices: [{ id: 'ipad', type: 'Tablet', is_active: true, is_restricted: false }],
    isPlaying: true,
    track: { name: 'Første sang', artists: [{ name: 'Kunstner A' }], album: { images: [] } },
    playlists: [
      { id: '1', name: 'Morgen', uri: 'spotify:playlist:morgen', images: [] },
      { id: '2', name: 'Aften', uri: 'spotify:playlist:aften', images: [] },
    ],
    tokenStatus: 200,
    apiStatus: null,
    weatherStatus: 200,
    calls: [],
  };
  world.fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const parsed = new URL(url);
    world.calls.push({ method, path: parsed.pathname, url: String(url), body: options.body });
    if (!world.online) throw new TypeError('offline');

    if (parsed.host === 'accounts.spotify.com') {
      if (world.tokenStatus !== 200) return json({ error: 'invalid_grant' }, world.tokenStatus);
      return json({ access_token: 'NY', refresh_token: 'NYR', expires_in: 3600 });
    }
    if (parsed.host === 'geocoding-api.open-meteo.com') {
      return json({ results: parsed.searchParams.get('name') === 'Aarhus' ? [AARHUS_RESULT] : [] });
    }
    if (parsed.host === 'api.open-meteo.com') {
      if (world.weatherStatus !== 200) return json({}, world.weatherStatus);
      return json({
        current: { temperature_2m: 9.4, weather_code: 3 },
        hourly: {
          time: ['2026-11-01T15:00', '2026-11-01T18:00', '2026-11-01T21:00', '2026-11-02T00:00'],
          temperature_2m: [9, 7, 6, 5],
          weather_code: [3, 3, 61, 61],
        },
        daily: {
          time: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'],
          temperature_2m_max: [10, 11, 8, 7],
          temperature_2m_min: [3, 4, 1, 0],
          weather_code: [3, 0, 71, 95],
        },
      });
    }

    if (world.apiStatus) return json({}, world.apiStatus);
    const path = parsed.pathname.replace('/v1', '');
    if (path === '/me/player') {
      return world.track ? json({ is_playing: world.isPlaying, device: world.devices[0], item: world.track }) : empty();
    }
    if (path === '/me/player/devices') return json({ devices: world.devices });
    if (path === '/me/playlists') return json({ items: world.playlists, next: null });
    if (path === '/me/player/pause') world.isPlaying = false;
    if (path === '/me/player/play') world.isPlaying = true;
    if (path === '/me/player/next') world.track = { ...world.track, name: 'Næste sang' };
    if (path === '/me/player/previous') world.track = { ...world.track, name: 'Forrige sang' };
    return empty();
  };
  world.count = (path, method) => world.calls.filter((call) => call.path === path && (!method || call.method === method)).length;
  return world;
}

let current = null;

async function mount({
  world = fakeWorld(), storage = createStorage(createMemoryBackend()), time = new Date(2026, 10, 1, 14, 32),
  loggedIn = false, settings = {}, pageUrl = 'https://example.test/hjem/', image, options = {},
} = {}) {
  current?.handle.stop();
  document.documentElement.className = '';
  document.documentElement.style.cssText = '';
  $('mount').replaceChildren(...[...markup.body.children].map((node) => document.importNode(node, true)));

  const clock = { time };
  const sound = { started: 0, stopped: 0, start() { this.started++; }, stop() { this.stopped++; } };
  const navigated = [];
  let cleared = 0;
  const stored = storage.get('settings');
  storage.set('settings', { ...stored, ...settings });
  if (loggedIn) storage.set('spotify.tokens', { access: 'A', refresh: 'R', expiresAt: time.getTime() + 3600000 });
  if (image) storage.set('theme.image', image);

  const handle = start({
    fetch: world.fetch, storage, now: () => clock.time, pageUrl,
    navigate: (url) => navigated.push(url), clearUrl: () => { cleared++; },
    alarmSound: sound, settleMs: 0, autoRun: false, defaultClientId: '', ...options,
  });
  await handle.ready;
  current = { handle, world, storage, clock, sound, navigated, getCleared: () => cleared };
  return current;
}

test('ur: viser tid og dato ved start', async () => {
  await mount();
  assert.equal($('time').textContent, '14:32');
  assert.equal($('date').textContent, 'Søndag 1. november');
});

test('ur: skifter, når tiden går', async () => {
  const app = await mount();
  app.clock.time = new Date(2026, 10, 1, 14, 33);
  app.handle.tickClock();
  assert.equal($('time').textContent, '14:33');
});

test('vejr: beder om by, når ingen er valgt', async () => {
  await mount();
  assert.equal($('weather-text').textContent, 'Vælg din by i indstillinger');
});

test('vejr: viser temperatur, timer og dage', async () => {
  await mount({ settings: { place: PLACE } });
  assert.equal($('weather-temp').textContent, '9°');
  assert.equal($('weather-text').textContent, 'Skyet');
  assert.equal($('weather-hours').children.length, 4);
  assert.equal($('weather-days').children[0].textContent, 'Mandag: 4° til 11°');
});

test('vejr: viser gamle data med tidspunkt, når nettet forsvinder', async () => {
  const app = await mount({ settings: { place: PLACE } });
  app.world.online = false;
  app.clock.time = new Date(2026, 10, 1, 15, 0);
  await app.handle.refreshWeather();
  assert.equal($('weather-temp').textContent, '9°');
  assert.ok($('weather-note').textContent.includes('14:32'), 'tidspunkt');
  app.world.online = true;
  await app.handle.refreshWeather();
  assert.equal($('weather-note').textContent, 'Aarhus');
});

test('vejr: fejl uden gemte data giver klar besked', async () => {
  const world = fakeWorld();
  world.weatherStatus = 500;
  await mount({ world, settings: { place: PLACE } });
  assert.equal($('weather-text').textContent, 'Vejret kan ikke hentes lige nu');
});

test('login: uden klient-id åbnes indstillinger', async () => {
  const app = await mount();
  assert.equal($('login').hidden, false);
  $('login').click();
  await pause();
  assert.ok($('settings').open, 'dialog åben');
  assert.equal(app.navigated.length, 0);
  $('settings').close();
});

test('login: med klient-id sendes man til Spotify', async () => {
  const app = await mount({ settings: { clientId: 'klient' } });
  $('login').click();
  await pause(50);
  const url = new URL(app.navigated[0]);
  assert.equal(url.host, 'accounts.spotify.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://example.test/hjem/');
});

test('login: det indbyggede klient-id bruges, uden at noget skal tastes', async () => {
  const app = await mount({ options: { defaultClientId: undefined } });
  $('login').click();
  await pause(50);
  assert.equal(new URL(app.navigated[0]).searchParams.get('client_id'), DEFAULT_CLIENT_ID);
  assert.equal($('settings').open, false, 'indstillinger åbnes ikke');
  $('settings-open').click();
  assert.equal($('client-id').value, DEFAULT_CLIENT_ID);
  $('settings').close();
});

test('login: et selvvalgt klient-id går forud for det indbyggede', async () => {
  const app = await mount({ settings: { clientId: 'mit-eget' }, options: { defaultClientId: undefined } });
  $('login').click();
  await pause(50);
  assert.equal(new URL(app.navigated[0]).searchParams.get('client_id'), 'mit-eget');
});

test('login: retur fra Spotify gemmer login, rydder adressen og viser playlister', async () => {
  const first = await mount({ settings: { clientId: 'klient' } });
  $('login').click();
  await pause(50);
  const state = new URL(first.navigated[0]).searchParams.get('state');
  const app = await mount({
    storage: first.storage, pageUrl: `https://example.test/hjem/?code=abc&state=${state}`,
  });
  assert.equal(app.getCleared(), 1);
  assert.equal($('login').hidden, true);
  assert.equal($('playlists').children.length, 2);
  assert.equal($('track-title').textContent, 'Første sang');
});

test('login: falsk state afvises, adressen ryddes og man er stadig ude', async () => {
  const app = await mount({ pageUrl: 'https://example.test/hjem/?code=abc&state=falsk', settings: { clientId: 'k' } });
  assert.equal(app.getCleared(), 1);
  assert.equal($('login').hidden, false);
  assert.equal($('message').hidden, false);
  assert.equal(app.world.count('/api/token'), 0);
});

test('login: udløbet login viser login-knappen igen', async () => {
  const app = await mount({ loggedIn: true });
  app.world.tokenStatus = 400;
  app.clock.time = new Date(2026, 10, 1, 17, 0);
  await app.handle.pollPlayback();
  assert.equal($('login').hidden, false);
  assert.equal($('track-title').textContent, 'Intet spiller');
});

test('login: loginkode overføres fra Safari til hjemmeskærm', async () => {
  const safari = await mount({ loggedIn: true, settings: { clientId: 'klient' } });
  $('settings-open').click();
  $('export-code').click();
  const code = $('login-code').value;
  assert.ok(code.length > 5, 'kode vist');
  $('settings').close();

  const app = await mount({ settings: {} });
  $('settings-open').click();
  $('login-code').value = code;
  $('import-code').click();
  await pause(20);
  assert.equal($('client-id').value, 'klient');
  assert.equal($('login-status').textContent, 'Logget ind');
  assert.equal($('playlists').children.length, 2);
  assert.ok(safari.storage !== app.storage, 'to adskilte lagre');
  $('settings').close();
});

test('login: ugyldig loginkode giver besked', async () => {
  await mount();
  $('settings-open').click();
  $('login-code').value = 'noget vrøvl';
  $('import-code').click();
  await pause();
  assert.equal($('message').textContent, 'Koden er ikke gyldig');
  $('settings').close();
});

test('log ud: fjerner login og playlister', async () => {
  await mount({ loggedIn: true });
  $('settings-open').click();
  $('logout').click();
  assert.equal($('playlists').children.length, 0);
  assert.equal($('login').hidden, false);
  $('settings').close();
});

test('afspiller: viser sang og kunstner', async () => {
  await mount({ loggedIn: true });
  assert.equal($('track-title').textContent, 'Første sang');
  assert.equal($('track-artist').textContent, 'Kunstner A');
  assert.equal($('play-pause').getAttribute('aria-label'), 'Pause');
  assert.equal($('open-spotify').hidden, true);
});

test('afspiller: pause og afspil skifter knap og kald', async () => {
  const app = await mount({ loggedIn: true });
  $('play-pause').click();
  await pause(20);
  assert.equal(app.world.count('/v1/me/player/pause', 'PUT'), 1);
  assert.equal($('play-pause').getAttribute('aria-label'), 'Afspil');
  $('play-pause').click();
  await pause(20);
  assert.equal(app.world.count('/v1/me/player/play', 'PUT'), 1);
  assert.equal($('play-pause').getAttribute('aria-label'), 'Pause');
});

test('afspiller: næste og forrige opdaterer sangen', async () => {
  await mount({ loggedIn: true });
  $('next').click();
  await pause(20);
  assert.equal($('track-title').textContent, 'Næste sang');
  $('previous').click();
  await pause(20);
  assert.equal($('track-title').textContent, 'Forrige sang');
});

test('afspiller: tryk på playliste starter den på iPad’en', async () => {
  const app = await mount({ loggedIn: true });
  $('playlists').children[1].querySelector('button').click();
  await pause(20);
  const call = app.world.calls.find((c) => c.path === '/v1/me/player/play');
  assert.deepEqual(JSON.parse(call.body), { context_uri: 'spotify:playlist:aften' });
  assert.ok(call.url.includes('device_id=ipad'));
});

test('afspiller: lukket Spotify viser Åbn Spotify og forklaring', async () => {
  const world = fakeWorld();
  world.devices = [];
  world.track = null;
  await mount({ world, loggedIn: true });
  $('playlists').children[0].querySelector('button').click();
  await pause(20);
  assert.equal($('open-spotify').hidden, false);
  assert.equal($('open-spotify').getAttribute('href'), 'spotify:');
  assert.equal($('player-note').textContent, 'Spotify er ikke åben på iPad’en');
});

test('afspiller: serverfejl vises uden at siden går i stå', async () => {
  const app = await mount({ loggedIn: true });
  app.world.apiStatus = 503;
  $('next').click();
  await pause(20);
  assert.equal($('message').textContent, 'Spotify afviste kaldet');
  app.world.apiStatus = null;
  await app.handle.pollPlayback();
  assert.equal($('track-title').textContent, 'Første sang');
});

test('afspiller: netudfald under hentning giver stille besked', async () => {
  const app = await mount({ loggedIn: true });
  $('message').hidden = true;
  app.world.online = false;
  await app.handle.pollPlayback();
  assert.equal($('player-note').textContent, 'Ingen forbindelse til nettet');
  assert.equal($('message').hidden, true, 'ingen pop-up hvert 5. sekund');
  assert.equal($('login').hidden, true, 'stadig logget ind');
});

test('afspiller: playlister hentes igen, når nettet kommer tilbage', async () => {
  const world = fakeWorld();
  world.online = false;
  const app = await mount({ world, loggedIn: true });
  assert.equal($('playlists').children.length, 0);
  world.online = true;
  await app.handle.pollPlayback();
  assert.equal($('playlists').children.length, 2);
  const before = world.count('/v1/me/playlists');
  await app.handle.pollPlayback();
  assert.equal(world.count('/v1/me/playlists'), before, 'hentes ikke hver gang');
});

test('afspiller: to samtidige hentninger giver kun ét kald', async () => {
  const app = await mount({ loggedIn: true });
  const before = app.world.count('/v1/me/player');
  await Promise.all([app.handle.pollPlayback(), app.handle.pollPlayback(), app.handle.pollPlayback()]);
  assert.equal(app.world.count('/v1/me/player'), before + 1);
});

test('afspiller: playlisten beholder sin plads, når intet har ændret sig', async () => {
  const app = await mount({ loggedIn: true });
  const first = $('playlists').children[0];
  await app.handle.loadPlaylists();
  assert.equal($('playlists').children[0], first);
});

test('ur: uændret tid og billede skrives ikke om hvert sekund', async () => {
  const app = await mount({ image: 'data:image/jpeg;base64,AAAA' });
  const observer = new MutationObserver(() => {});
  observer.observe($('time'), { characterData: true, childList: true, subtree: true });
  let writes = 0;
  const realSet = document.documentElement.style.setProperty;
  document.documentElement.style.setProperty = function patched(...args) {
    writes++;
    return realSet.apply(this, args);
  };
  app.handle.tickClock();
  app.handle.tickClock();
  delete document.documentElement.style.setProperty;
  const changes = observer.takeRecords().length;
  observer.disconnect();
  assert.equal(changes, 0, 'tekst urørt');
  assert.equal(writes, 0, 'billede urørt');
});

test('ur: går af sig selv, uden at nogen kalder det', async () => {
  const app = await mount({ options: { autoRun: true } });
  assert.equal($('time').textContent, '14:32');
  app.clock.time = new Date(2026, 10, 1, 14, 33);
  for (let i = 0; i < 40 && $('time').textContent !== '14:33'; i++) await pause(50);
  assert.equal($('time').textContent, '14:33');
});

test('vejr: prøver selv igen kort efter, når nettet var væk ved start', async () => {
  const world = fakeWorld();
  world.online = false;
  await mount({ world, settings: { place: PLACE }, options: { autoRun: true, weatherRetryMs: 20 } });
  assert.equal($('weather-text').textContent, 'Vejret kan ikke hentes lige nu');
  world.online = true;
  for (let i = 0; i < 40 && !$('weather-temp').textContent; i++) await pause(50);
  assert.equal($('weather-temp').textContent, '9°');
});

test('vejr: henter ikke igen hvert minut, når alt er i orden', async () => {
  const world = fakeWorld();
  await mount({ world, settings: { place: PLACE }, options: { autoRun: true, weatherRetryMs: 20 } });
  const before = world.count('/v1/forecast');
  await pause(200);
  assert.equal(world.count('/v1/forecast'), before);
});

test('vækkeur: alarmlyden stopper af sig selv efter maksimaltiden', async () => {
  const alarm = { enabled: true, time: '07:00', days: [1], playlistUri: null };
  const app = await mount({ settings: { alarm }, time: new Date(2026, 10, 2, 7, 0), options: { alarmMaxMs: 30 } });
  for (let i = 0; i < 20 && $('alarm-overlay').hidden; i++) await pause(10);
  assert.equal(app.sound.started, 1);
  for (let i = 0; i < 40 && !$('alarm-overlay').hidden; i++) await pause(50);
  assert.equal($('alarm-overlay').hidden, true);
  assert.ok(app.sound.stopped >= 1, 'lyd stoppet');
});

test('afspiller: skjult side henter ikke afspilning', async () => {
  const app = await mount({ loggedIn: true });
  const before = app.world.count('/v1/me/player');
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
  await app.handle.pollPlayback();
  delete document.hidden;
  assert.ok(descriptor, 'browser understøtter hidden');
  assert.equal(app.world.count('/v1/me/player'), before);
});

test('sikkerhed: navne fra Spotify vises som tekst, aldrig som kode', async () => {
  const evil = '<img src=x onerror="window.pwned=1">';
  const world = fakeWorld();
  world.track = { name: evil, artists: [{ name: evil }], album: { images: [{ url: 'javascript:alert(1)' }] } };
  world.playlists = [{ id: 'x', name: evil, uri: 'spotify:playlist:x', images: [] }];
  await mount({ world, loggedIn: true });
  await pause(20);
  assert.equal($('track-title').textContent, evil);
  assert.equal($('track-title').querySelector('img'), null);
  assert.equal($('playlists').querySelector('img'), null);
  assert.equal($('cover').hidden, true, 'javascript-adresse bruges ikke');
  assert.equal(window.pwned, undefined);
});

test('sikkerhed: huskepunkter vises som tekst', async () => {
  await mount();
  $('todo-input').value = '<b onmouseover=x>hej</b>';
  $('todo-form').requestSubmit();
  assert.equal($('todo-list').querySelector('b'), null);
});

test('huskeliste: tilføj, afkryds, slet og gem mellem genstarter', async () => {
  const first = await mount();
  $('todo-input').value = 'Køb mælk';
  $('todo-form').requestSubmit();
  $('todo-input').value = 'Aflever opgave';
  $('todo-form').requestSubmit();
  assert.equal($('todo-input').value, '');
  assert.equal($('todo-list').children.length, 2);
  $('todo-list').children[0].querySelector('.todo-toggle').click();
  assert.ok($('todo-list').children[0].classList.contains('done'));

  await mount({ storage: first.storage });
  assert.equal($('todo-list').children.length, 2);
  assert.ok($('todo-list').children[0].classList.contains('done'), 'afkrydsning bevaret');
  $('todo-list').children[0].querySelector('.todo-remove').click();
  assert.equal($('todo-list').children.length, 1);
  assert.ok($('todo-list').textContent.includes('Aflever opgave'));
});

test('huskeliste: tomt punkt ignoreres', async () => {
  await mount();
  $('todo-input').value = '    ';
  $('todo-form').requestSubmit();
  assert.equal($('todo-list').children.length, 0);
});

test('indstillinger: alt gemmes og gælder efter genstart', async () => {
  const first = await mount({ loggedIn: true });
  $('settings-open').click();
  $('client-id').value = '  minklient ';
  $('night-start').value = '21:30';
  $('night-end').value = '06:15';
  $('alarm-enabled').checked = true;
  $('alarm-time').value = '06:45';
  for (const box of $('alarm-days').querySelectorAll('input')) box.checked = box.value === '1';
  $('alarm-playlist').value = 'spotify:playlist:morgen';
  $('settings-save').click();
  assert.equal($('settings').open, false);
  assert.equal($('next-alarm').textContent, 'Vækkes man 06:45');

  await mount({ storage: first.storage, loggedIn: true });
  $('settings-open').click();
  assert.equal($('client-id').value, 'minklient');
  assert.equal($('night-start').value, '21:30');
  assert.equal($('alarm-time').value, '06:45');
  assert.equal($('alarm-playlist').value, 'spotify:playlist:morgen');
  assert.equal($('alarm-days').querySelectorAll('input:checked').length, 1);
  $('settings').close();
});

test('indstillinger: annullér gemmer ingenting', async () => {
  const app = await mount();
  $('settings-open').click();
  $('client-id').value = 'ændret';
  $('settings-cancel').click();
  assert.equal(app.storage.get('settings').clientId, undefined);
});

test('indstillinger: playliste bevares, når playlister ikke kan hentes', async () => {
  const alarm = { enabled: true, time: '07:00', days: [1], playlistUri: 'spotify:playlist:gl', playlistName: 'Gammel' };
  const world = fakeWorld();
  world.apiStatus = 500;
  await mount({ world, loggedIn: true, settings: { alarm } });
  $('settings-open').click();
  assert.equal($('alarm-playlist').value, 'spotify:playlist:gl');
  $('settings').close();
});

test('indstillinger: retur-tasten lukker ikke vinduet og søger i byfeltet', async () => {
  await mount();
  $('settings-open').click();
  $('city-input').value = 'Aarhus';
  $('city-input').focus();
  $('settings-form').requestSubmit();
  await pause(20);
  assert.ok($('settings').open, 'stadig åben');
  assert.equal($('city-results').children.length, 1);
  $('client-id').focus();
  $('settings-form').requestSubmit();
  assert.ok($('settings').open, 'stadig åben fra andet felt');
  $('settings').close();
});

test('indstillinger: ny natplan gælder med det samme, selvom månen var brugt', async () => {
  const app = await mount({ time: new Date(2026, 10, 1, 12, 0) });
  $('night-toggle').click();
  assert.ok(document.documentElement.classList.contains('night'), 'månen');
  $('settings-open').click();
  $('night-start').value = '22:00';
  $('night-end').value = '07:00';
  await $('settings-save').click();
  assert.equal(document.documentElement.classList.contains('night'), false);
  assert.equal(app.storage.get('night.override'), null);
});

test('by: søg, vælg og vejret skifter', async () => {
  const app = await mount();
  $('settings-open').click();
  $('city-input').value = 'Aarhus';
  $('city-search').click();
  await pause(20);
  assert.equal($('city-results').children.length, 1);
  $('city-results').querySelector('button').click();
  await pause(20);
  assert.equal($('place-current').textContent, 'Valgt: Aarhus');
  assert.equal($('weather-temp').textContent, '9°');
  assert.equal(app.storage.get('settings').place.name, 'Aarhus');
  $('settings').close();
});

test('by: ukendt by og tomt felt giver besked', async () => {
  await mount();
  $('settings-open').click();
  $('city-search').click();
  await pause();
  assert.equal($('message').textContent, 'Skriv navnet på din by');
  $('city-input').value = 'xyzzy';
  $('city-search').click();
  await pause(20);
  assert.equal($('message').textContent, 'Fandt ingen by med det navn');
  $('settings').close();
});

test('nat: starter og slutter efter tidsplan', async () => {
  const app = await mount({ time: new Date(2026, 10, 1, 23, 0) });
  const root = document.documentElement;
  assert.ok(root.classList.contains('night'), '23:00');
  assert.equal(getComputedStyle(document.querySelector('.player-card')).visibility, 'hidden');
  assert.equal(getComputedStyle($('time')).visibility, 'visible');
  app.clock.time = new Date(2026, 10, 2, 7, 0);
  app.handle.tickClock();
  assert.equal(root.classList.contains('night'), false);
});

test('nat: et tryk viser kontroller, månen kan tvinge nat til og fra', async () => {
  await mount({ time: new Date(2026, 10, 1, 12, 0) });
  const root = document.documentElement;
  $('night-toggle').click();
  assert.ok(root.classList.contains('night'), 'tændt med månen');
  document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  assert.ok(root.classList.contains('night-peek'), 'kig');
  assert.equal(getComputedStyle(document.querySelector('.player-card')).visibility, 'visible');
  $('night-toggle').click();
  assert.equal(root.classList.contains('night'), false, 'slukket med månen');
  assert.equal(root.classList.contains('night-peek'), false, 'kig afsluttet');
});

test('vækkeur: starter playliste til tiden', async () => {
  const alarm = { enabled: true, time: '07:00', days: [1], playlistUri: 'spotify:playlist:morgen' };
  const app = await mount({ loggedIn: true, settings: { alarm }, time: new Date(2026, 10, 2, 6, 59) });
  assert.equal(app.world.count('/v1/me/player/play'), 0);
  app.clock.time = new Date(2026, 10, 2, 7, 0, 1);
  await app.handle.tickClock();
  const call = app.world.calls.find((c) => c.path === '/v1/me/player/play');
  assert.deepEqual(JSON.parse(call.body), { context_uri: 'spotify:playlist:morgen' });
  assert.equal($('alarm-overlay').hidden, true);
  await app.handle.tickClock();
  assert.equal(app.world.count('/v1/me/player/play'), 1, 'kun én gang');
});

test('vækkeur: lukket Spotify får skærm og lyd til at ringe, og stop virker', async () => {
  const alarm = { enabled: true, time: '07:00', days: [1], playlistUri: 'spotify:playlist:morgen' };
  const world = fakeWorld();
  world.devices = [];
  const app = await mount({ world, loggedIn: true, settings: { alarm }, time: new Date(2026, 10, 2, 7, 0) });
  await pause(20);
  assert.equal($('alarm-overlay').hidden, false);
  assert.equal(app.sound.started, 1);
  assert.equal($('alarm-reason').textContent, 'Spotify er ikke åben på iPad’en');
  $('alarm-stop').click();
  assert.equal($('alarm-overlay').hidden, true);
  assert.ok(app.sound.stopped >= 1);
});

test('vækkeur: uden login ringer det stadig', async () => {
  const alarm = { enabled: true, time: '07:00', days: [1], playlistUri: 'spotify:playlist:morgen' };
  await mount({ settings: { alarm }, time: new Date(2026, 10, 2, 7, 0) });
  await pause(20);
  assert.equal($('alarm-overlay').hidden, false);
});

test('vækkeur: slået fra gør ingenting og vises ikke', async () => {
  const alarm = { enabled: false, time: '07:00', days: [1], playlistUri: 'p' };
  const app = await mount({ loggedIn: true, settings: { alarm }, time: new Date(2026, 10, 2, 7, 0) });
  await pause(20);
  assert.equal(app.world.count('/v1/me/player/play'), 0);
  assert.equal($('alarm-overlay').hidden, true);
  assert.equal($('next-alarm').textContent, '');
});

test('tema: eget billede vælges, gemmes og kan fjernes', async () => {
  const app = await mount();
  const canvas = Object.assign(document.createElement('canvas'), { width: 3000, height: 2000 });
  canvas.getContext('2d').fillRect(0, 0, 3000, 2000);
  const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/png'); });
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'baggrund.png', { type: 'image/png' }));
  $('settings-open').click();
  $('image-input').files = transfer.files;
  $('image-input').dispatchEvent(new Event('change'));
  for (let i = 0; i < 40 && !app.storage.get('theme.image'); i++) await pause(50);
  const saved = app.storage.get('theme.image');
  assert.ok(saved?.startsWith('data:image/jpeg'), 'gemt som jpeg');
  assert.ok(document.documentElement.classList.contains('has-image'), 'vist');
  const width = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image.naturalWidth);
    image.onerror = reject;
    image.src = saved;
  });
  assert.equal(width, 1600, 'skaleret ned');
  $('image-remove').click();
  assert.equal(document.documentElement.classList.contains('has-image'), false);
  $('settings').close();
});

test('tema: for stort billede beholder det gamle med besked', async () => {
  const backend = createMemoryBackend();
  const realSet = backend.setItem;
  backend.setItem = (key, value) => {
    if (key === 'home.theme.image') throw new Error('quota');
    realSet(key, value);
  };
  const app = await mount({ storage: createStorage(backend) });
  const canvas = Object.assign(document.createElement('canvas'), { width: 10, height: 10 });
  const blob = await new Promise((resolve) => { canvas.toBlob(resolve, 'image/png'); });
  const transfer = new DataTransfer();
  transfer.items.add(new File([blob], 'b.png', { type: 'image/png' }));
  $('settings-open').click();
  $('image-input').files = transfer.files;
  $('image-input').dispatchEvent(new Event('change'));
  for (let i = 0; i < 40 && $('message').hidden; i++) await pause(50);
  assert.equal($('message').textContent, 'Billedet er for stort til at gemme');
  assert.equal(app.storage.get('theme.image'), null);
  $('settings').close();
});

test('tema: en fil, der ikke er et billede, giver besked', async () => {
  await mount();
  const transfer = new DataTransfer();
  transfer.items.add(new File(['ikke et billede'], 'x.png', { type: 'image/png' }));
  $('settings-open').click();
  $('image-input').files = transfer.files;
  $('image-input').dispatchEvent(new Event('change'));
  for (let i = 0; i < 40 && $('message').hidden; i++) await pause(50);
  assert.equal($('message').textContent, 'Billedet kunne ikke læses');
  $('settings').close();
});

test('tema: temavælgeren har kun det neutrale tema, indtil design er valgt', async () => {
  await mount();
  $('settings-open').click();
  assert.equal($('theme-select').options.length, 1);
  assert.equal($('theme-select').value, 'neutral');
  $('settings').close();
});

test('robusthed: alt nede fra start, uret kører stadig', async () => {
  const world = fakeWorld();
  world.online = false;
  const app = await mount({ world, loggedIn: true, settings: { place: PLACE } });
  assert.equal($('time').textContent, '14:32');
  app.clock.time = new Date(2026, 10, 1, 14, 40);
  app.handle.tickClock();
  assert.equal($('time').textContent, '14:40');
  assert.equal($('weather-text').textContent, 'Vejret kan ikke hentes lige nu');
});

test('robusthed: ødelagt lager får ikke siden til at gå ned', async () => {
  const backend = createMemoryBackend();
  for (const key of ['settings', 'todo.items', 'night.override', 'spotify.tokens', 'theme.image', 'weather.cache']) {
    backend.setItem(`home.${key}`, '{ødelagt');
  }
  await mount({ storage: createStorage(backend) });
  assert.equal($('time').textContent, '14:32');
  $('todo-input').value = 'virker stadig';
  $('todo-form').requestSubmit();
  assert.equal($('todo-list').children.length, 1);
});

test('robusthed: et døgn med tilfældige fejl giver ingen uhåndterede fejl', async () => {
  let seed = 8;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const alarm = { enabled: true, time: '07:00', days: [0, 1, 2, 3, 4, 5, 6], playlistUri: 'spotify:playlist:morgen' };
  const app = await mount({ loggedIn: true, settings: { place: PLACE, alarm }, time: new Date(2026, 10, 1, 0, 0) });
  let time = app.clock.time.getTime();
  for (let i = 0; i < 4000; i++) {
    time += 21600;
    app.clock.time = new Date(time);
    app.world.online = rnd() > 0.1;
    app.world.apiStatus = rnd() < 0.05 ? [401, 403, 429, 500][Math.floor(rnd() * 4)] : null;
    app.world.tokenStatus = 200;
    await app.handle.tickClock();
    await app.handle.pollPlayback();
    if (i % 40 === 0) await app.handle.refreshWeather();
    if (i % 200 === 0) await app.handle.loadPlaylists();
  }
  await pause(20);
  assert.equal($('time').textContent.length, 5);
  assert.deepEqual(unhandled, []);
});

test('udseende: passer til iPad uden at noget stikker ud, og knapper kan rammes', async () => {
  await mount({ loggedIn: true, settings: { place: PLACE } });
  for (let i = 0; i < 12; i++) {
    $('todo-input').value = `Et ret langt huskepunkt nummer ${i} der måske går ud over kanten af kortet`;
    $('todo-form').requestSubmit();
  }
  const root = document.documentElement;
  assert.ok(root.scrollWidth <= root.clientWidth, `bredde ${root.scrollWidth}/${root.clientWidth}`);
  assert.ok(root.scrollHeight <= root.clientHeight, `højde ${root.scrollHeight}/${root.clientHeight}`);
  for (const card of document.querySelectorAll('.card')) {
    const box = card.getBoundingClientRect();
    assert.ok(box.bottom <= window.innerHeight + 1 && box.right <= window.innerWidth + 1, `${card.className} indenfor`);
  }
  for (const button of document.querySelectorAll('.layout button:not([hidden])')) {
    const box = button.getBoundingClientRect();
    assert.ok(box.height >= 44, `${button.id || button.className} højde ${box.height}`);
  }
});

const summary = await runAll();
document.title = `${summary.passed}/${summary.total}`;
