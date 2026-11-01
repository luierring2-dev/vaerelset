import { test, assert, fakeFetch, json, empty } from './harness.js';
import { createMemoryBackend, createStorage } from '../js/storage.js';
import { createAlarmRunner, dueOccurrence, nextOccurrence } from '../js/alarm.js';
import { isNightActive, isNightTime, nextNightChange, toggleNight } from '../js/theme.js';
import { normalizeSettings } from '../js/settings.js';
import { createSpotify, parsePlayback, SpotifyError, NetworkError } from '../js/spotify.js';
import { parseForecast } from '../js/weather.js';
import { createTodoList } from '../js/todo.js';

// Fast frø, så en fejl kan genskabes.
function random(seed) {
  let x = seed;
  return () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return x / 4294967296;
  };
}

const MINUTE = 60000;

test('simulering: vækkeur ringer præcis én gang pr. hverdag i et helt år', async () => {
  const fired = [];
  let time = new Date(2026, 0, 1).getTime();
  const end = new Date(2027, 0, 1).getTime();
  const runner = createAlarmRunner({
    getAlarm: () => ({ enabled: true, time: '07:00', days: [1, 2, 3, 4, 5], playlistUri: 'p' }),
    storage: createStorage(createMemoryBackend()),
    now: () => new Date(time),
    startMusic: async () => fired.push(new Date(time)),
    onRing() {},
  });
  for (; time < end; time += 30000) await runner.tick();

  let weekdays = 0;
  for (let d = new Date(2026, 0, 1); d.getFullYear() === 2026; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    if (d.getDay() >= 1 && d.getDay() <= 5) weekdays++;
  }
  assert.equal(fired.length, weekdays);
  assert.ok(fired.every((d) => d.getHours() === 7 && d.getMinutes() === 0), 'tidspunkt');
});

test('simulering: vækkeur overlever ujævn timing (langsom iPad)', async () => {
  const rnd = random(42);
  let fired = 0;
  let time = new Date(2026, 10, 2, 6, 50).getTime();
  const runner = createAlarmRunner({
    getAlarm: () => ({ enabled: true, time: '07:00', days: [1], playlistUri: 'p' }),
    storage: createStorage(createMemoryBackend()),
    now: () => new Date(time),
    startMusic: async () => { fired++; },
    onRing() {},
  });
  while (time < new Date(2026, 10, 2, 7, 30).getTime()) {
    await runner.tick();
    time += 5000 + rnd() * 90000;
  }
  assert.equal(fired, 1);
});

test('simulering: tilfældige vækkeure, næste vækning er altid gyldig', () => {
  const rnd = random(7);
  for (let i = 0; i < 5000; i++) {
    const days = [0, 1, 2, 3, 4, 5, 6].filter(() => rnd() < 0.5);
    const hh = String(Math.floor(rnd() * 24)).padStart(2, '0');
    const mm = String(Math.floor(rnd() * 60)).padStart(2, '0');
    const alarm = { enabled: true, time: `${hh}:${mm}`, days };
    const now = new Date(2026, Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 28), Math.floor(rnd() * 24), Math.floor(rnd() * 60));
    const next = nextOccurrence(alarm, now);
    if (!days.length) {
      assert.equal(next, null);
      continue;
    }
    assert.ok(next > now, 'efter nu');
    assert.ok(next - now <= 8 * 24 * 60 * MINUTE, 'inden for en uge');
    assert.ok(days.includes(next.getDay()), 'rigtig dag');
    assert.ok(dueOccurrence(alarm, next), 'aktuel på tidspunktet');
  }
});

test('simulering: sommertid ændrer ikke, at vækkeuret går', async () => {
  // Natten til 25. oktober 2026 og 28. marts 2027 skifter urene i Danmark.
  for (const [y, m, d] of [[2026, 9, 25], [2027, 2, 28]]) {
    const alarm = { enabled: true, time: '07:00', days: [0, 1, 2, 3, 4, 5, 6], playlistUri: 'p' };
    const next = nextOccurrence(alarm, new Date(y, m, d, 1, 0));
    assert.equal(next.getHours(), 7);
    assert.equal(next.getDate(), d);
  }
});

test('simulering: nat og måne stemmer hele døgnet for tilfældige tidsrum', () => {
  const rnd = random(99);
  const time = () => `${String(Math.floor(rnd() * 24)).padStart(2, '0')}:${String(Math.floor(rnd() * 60)).padStart(2, '0')}`;
  for (let i = 0; i < 300; i++) {
    const night = { start: time(), end: time() };
    if (night.start === night.end) continue;
    let changes = 0;
    let previous = null;
    for (let minute = 0; minute < 24 * 60; minute++) {
      const now = new Date(2026, 5, 15, 0, minute);
      const current = isNightTime(now, night.start, night.end);
      if (previous !== null && previous !== current) changes++;
      previous = current;
      if (minute % 97 === 0) {
        const change = nextNightChange(now, night.start, night.end);
        assert.ok(change > now, 'næste skift efter nu');
        const override = toggleNight(now, night, null);
        assert.equal(isNightActive(now, night, override), !current, 'månen vender tilstanden');
        assert.equal(isNightActive(change, night, override), isNightTime(change, night.start, night.end), 'månen slipper');
      }
    }
    assert.ok(changes <= 2, 'højst to skift i døgnet');
  }
});

test('simulering: tilfældigt affald i indstillinger får aldrig siden til at fejle', () => {
  const rnd = random(5);
  const junk = [null, undefined, 0, 1, -1, '', 'x', '25:99', [], {}, [1, 'a', null], { a: 1 }, true, NaN];
  const pick = () => junk[Math.floor(rnd() * junk.length)];
  for (let i = 0; i < 5000; i++) {
    const result = normalizeSettings({
      clientId: pick(), place: pick(), themeId: pick(), night: pick(),
      alarm: rnd() < 0.5 ? pick() : { enabled: pick(), time: pick(), days: pick(), playlistUri: pick() },
    });
    assert.equal(typeof result.clientId, 'string');
    assert.ok(/^\d\d:\d\d$/.test(result.alarm.time), 'tid');
    assert.ok(Array.isArray(result.alarm.days), 'dage');
    nextOccurrence(result.alarm, new Date());
    isNightTime(new Date(), result.night.start, result.night.end);
  }
});

test('simulering: mærkelige Spotify-svar får aldrig afspilleren til at fejle', () => {
  const rnd = random(11);
  const junk = [null, undefined, 0, '', 'x', [], {}, [null], { name: null }, { images: [] }];
  const pick = () => junk[Math.floor(rnd() * junk.length)];
  for (let i = 0; i < 5000; i++) {
    const item = rnd() < 0.3 ? pick() : { name: pick(), album: rnd() < 0.5 ? pick() : { images: [] }, show: rnd() < 0.5 ? undefined : { name: 'x' } };
    parsePlayback({ is_playing: pick(), device: pick(), item });
  }
});

test('simulering: et døgn med ustabilt net og Spotify ender uden logout eller løkke', async () => {
  const rnd = random(2026);
  const backend = createMemoryBackend();
  const storage = createStorage(backend);
  let time = new Date(2026, 10, 1).getTime();
  storage.set('spotify.tokens', { access: 'A', refresh: 'R', expiresAt: time + 3600000 });
  const fetchFn = fakeFetch((call) => {
    const roll = rnd();
    if (roll < 0.1) throw new TypeError('offline');
    if (roll < 0.15) return json({}, 503);
    if (roll < 0.17) return json({}, 429, { 'Retry-After': '10' });
    if (call.url.includes('/api/token')) return json({ access_token: 'A', expires_in: 3600 });
    if (roll < 0.2) return json({}, 401);
    if (call.url.endsWith('/me/player')) return roll < 0.5 ? empty() : json({ is_playing: true, item: { name: 's' } });
    return empty();
  });
  const spotify = createSpotify({ getClientId: () => 'c', fetch: fetchFn, storage, now: () => new Date(time), redirectUri: 'https://x.test/' });

  let ok = 0;
  let expected = 0;
  const polls = (24 * 3600) / 5;
  for (let i = 0; i < polls; i++) {
    time += 5000;
    try {
      await spotify.getPlayback();
      ok++;
    } catch (error) {
      assert.ok(error instanceof SpotifyError || error instanceof NetworkError, `uventet ${error.name}`);
      expected++;
    }
  }
  assert.equal(spotify.isLoggedIn(), true, 'stadig logget ind');
  assert.ok(ok > polls * 0.5, `mange kald lykkes (${ok})`);
  assert.equal(ok + expected, polls);
  assert.ok(fetchFn.calls.length < polls * 2.1, 'ingen kaldeløkke');
});

test('simulering: huskeliste med tusindvis af tilfældige handlinger', () => {
  const rnd = random(3);
  let n = 0;
  const list = createTodoList(createStorage(createMemoryBackend()), () => `id${++n}`);
  const model = new Map();
  for (let i = 0; i < 3000; i++) {
    const ids = [...model.keys()];
    const id = ids[Math.floor(rnd() * ids.length)];
    const roll = rnd();
    if (roll < 0.5 || !id) {
      list.add(`Punkt ${i}`);
      model.set(`id${n}`, false);
    } else if (roll < 0.8) {
      list.toggle(id);
      model.set(id, !model.get(id));
    } else {
      list.remove(id);
      model.delete(id);
    }
  }
  assert.deepEqual(list.items().map((item) => [item.id, item.done]), [...model.entries()]);
});

test('simulering: vejrsvar med huller får aldrig siden til at fejle', () => {
  const rnd = random(21);
  for (let i = 0; i < 2000; i++) {
    const json2 = { current: { temperature_2m: rnd() * 40 - 20, weather_code: Math.floor(rnd() * 100) } };
    if (rnd() < 0.5) json2.hourly = { time: ['2026-11-01T15:00'], temperature_2m: [1], weather_code: [1] };
    if (rnd() < 0.5) json2.daily = { time: ['2026-11-02'], temperature_2m_max: [1], temperature_2m_min: [0], weather_code: [1] };
    const result = parseForecast(json2, new Date(2026, 10, 1, 12));
    assert.ok(Number.isInteger(result.temperature) || Object.is(result.temperature, -0), 'heltal');
  }
});
