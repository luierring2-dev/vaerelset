import { test, assert, fakeFetch, json } from './harness.js';
import { createMemoryBackend, createStorage } from '../js/storage.js';
import { dayName, formatDate, formatTime } from '../js/clock.js';
import { createWeatherService, describeWeatherCode, forecastUrl, parseForecast, searchCity } from '../js/weather.js';
import { createAlarmRunner, dueOccurrence, nextOccurrence } from '../js/alarm.js';
import { createTodoList } from '../js/todo.js';
import { applyAppearance, fitInside, isNightActive, isNightTime, nextNightChange, resolveThemeId, toggleNight } from '../js/theme.js';
import { createSettings, DEFAULT_SETTINGS, normalizeSettings } from '../js/settings.js';

const newStorage = () => createStorage(createMemoryBackend());

test('lager: gemmer og læser værdier', () => {
  const storage = newStorage();
  assert.equal(storage.get('x', 'std'), 'std');
  assert.ok(storage.set('x', { a: 1 }));
  assert.deepEqual(storage.get('x'), { a: 1 });
  storage.remove('x');
  assert.equal(storage.get('x'), null);
});

test('lager: ødelagt JSON giver standardværdien', () => {
  const backend = createMemoryBackend();
  backend.setItem('home.x', '{ikke json');
  assert.equal(createStorage(backend).get('x', 7), 7);
});

test('lager: fuldt lager melder fejl uden at kaste', () => {
  const backend = { getItem: () => null, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('blokeret'); } };
  const storage = createStorage(backend);
  assert.equal(storage.set('x', 1), false);
  storage.remove('x');
});

test('ur: viser tid med kolon og foranstillet nul', () => {
  assert.equal(formatTime(new Date(2026, 10, 1, 7, 5)), '07:05');
  assert.equal(formatTime(new Date(2026, 10, 1, 0, 0)), '00:00');
  assert.equal(formatTime(new Date(2026, 10, 1, 23, 59)), '23:59');
});

test('ur: viser dansk dato', () => {
  assert.equal(formatDate(new Date(2026, 10, 1)), 'Søndag 1. november');
  assert.equal(formatDate(new Date(2027, 1, 25)), 'Torsdag 25. februar');
  assert.equal(dayName(new Date(2026, 10, 7)), 'Lørdag');
});

test('vejr: oversætter alle WMO-koder', () => {
  for (const code of [0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99]) {
    assert.ok(describeWeatherCode(code) !== 'Ukendt vejr', `kode ${code}`);
  }
  assert.equal(describeWeatherCode(1234), 'Ukendt vejr');
});

function forecastJson() {
  const hourly = { time: [], temperature_2m: [], weather_code: [] };
  for (let h = 0; h < 48; h++) {
    const day = h < 24 ? '01' : '02';
    hourly.time.push(`2026-11-${day}T${String(h % 24).padStart(2, '0')}:00`);
    hourly.temperature_2m.push(5.4 + h / 10);
    hourly.weather_code.push(3);
  }
  return {
    current: { temperature_2m: 9.6, weather_code: 61 },
    hourly,
    daily: {
      time: ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'],
      temperature_2m_max: [10.2, 11.5, 8.4, 7],
      temperature_2m_min: [3.2, 4.5, 1.4, -0.6],
      weather_code: [3, 0, 71, 95],
    },
  };
}

test('vejr: læser svaret fra Open-Meteo', () => {
  const result = parseForecast(forecastJson(), new Date(2026, 10, 1, 14, 32));
  assert.equal(result.temperature, 10);
  assert.equal(result.text, 'Regn');
  assert.deepEqual(result.hours.map((h) => h.label), ['15:00', '18:00', '21:00', '00:00']);
  assert.deepEqual(result.days.map((d) => d.label), ['Mandag', 'Tirsdag', 'Onsdag']);
  assert.equal(result.days[2].low, -1);
});

test('vejr: klarer svar uden timer og dage', () => {
  const result = parseForecast({ current: { temperature_2m: 1, weather_code: 0 } }, new Date());
  assert.deepEqual(result.hours, []);
  assert.deepEqual(result.days, []);
});

test('vejr: adressen indeholder sted og felter', () => {
  const url = new URL(forecastUrl({ latitude: 55.67, longitude: 12.56 }));
  assert.equal(url.searchParams.get('latitude'), '55.67');
  assert.equal(url.searchParams.get('timezone'), 'auto');
  assert.ok(url.searchParams.get('daily').includes('temperature_2m_max'));
});

test('vejr: bysøgning kobler navn og region', async () => {
  const fetchFn = fakeFetch(() => json({ results: [{ name: 'Aarhus', admin1: 'Midtjylland', country: 'Danmark', latitude: 56.1, longitude: 10.2 }] }));
  const [city] = await searchCity(' Aarhus ', fetchFn);
  assert.equal(city.region, 'Midtjylland, Danmark');
  assert.ok(fetchFn.calls[0].url.includes('name=Aarhus&'));
});

test('vejr: bysøgning uden resultater giver tom liste', async () => {
  assert.deepEqual(await searchCity('xyzzy', fakeFetch(() => json({}))), []);
});

test('vejr: viser seneste data, når nettet er væk', async () => {
  const storage = newStorage();
  const place = { name: 'Aarhus', latitude: 56, longitude: 10 };
  let online = true;
  const fetchFn = fakeFetch(() => {
    if (!online) throw new TypeError('offline');
    return json(forecastJson());
  });
  const service = createWeatherService({ fetch: fetchFn, storage, now: () => new Date(2026, 10, 1, 14, 0) });
  const first = await service.refresh(place);
  assert.equal(first.stale, false);
  online = false;
  const second = await service.refresh(place);
  assert.equal(second.stale, true);
  assert.equal(second.data.temperature, 10);
  assert.equal(second.fetchedAt, first.fetchedAt);
});

test('vejr: serverfejl uden gemte data giver tomt svar', async () => {
  const service = createWeatherService({ fetch: fakeFetch(() => json({}, 500)), storage: newStorage(), now: () => new Date() });
  const result = await service.refresh({ name: 'Aarhus', latitude: 1, longitude: 1 });
  assert.equal(result.data, null);
  assert.equal(result.stale, true);
});

test('vejr: gemte data fra en anden by bruges ikke', async () => {
  const storage = newStorage();
  let online = true;
  const fetchFn = fakeFetch(() => {
    if (!online) throw new TypeError('offline');
    return json(forecastJson());
  });
  const service = createWeatherService({ fetch: fetchFn, storage, now: () => new Date(2026, 10, 1) });
  await service.refresh({ name: 'Aarhus', latitude: 1, longitude: 1 });
  online = false;
  const other = await service.refresh({ name: 'Odense', latitude: 2, longitude: 2 });
  assert.equal(other.data, null);
});

const weekdays = { enabled: true, time: '07:00', days: [1, 2, 3, 4, 5], playlistUri: 'spotify:playlist:a' };

test('vækkeur: finder næste vækning', () => {
  const sunday = new Date(2026, 10, 1, 12, 0);
  assert.equal(nextOccurrence(weekdays, sunday).getTime(), new Date(2026, 10, 2, 7, 0).getTime());
  const mondayEarly = new Date(2026, 10, 2, 6, 59);
  assert.equal(nextOccurrence(weekdays, mondayEarly).getTime(), new Date(2026, 10, 2, 7, 0).getTime());
  const fridayLate = new Date(2026, 10, 6, 7, 1);
  assert.equal(nextOccurrence(weekdays, fridayLate).getTime(), new Date(2026, 10, 9, 7, 0).getTime());
});

test('vækkeur: slået fra eller uden dage giver ingen vækning', () => {
  const now = new Date(2026, 10, 2, 6, 0);
  assert.equal(nextOccurrence({ ...weekdays, enabled: false }, now), null);
  assert.equal(nextOccurrence({ ...weekdays, days: [] }, now), null);
  assert.equal(nextOccurrence(null, now), null);
  assert.equal(nextOccurrence({ ...weekdays, time: 'bad' }, now), null);
});

test('vækkeur: en dag om ugen findes en uge frem', () => {
  const alarm = { ...weekdays, days: [1] };
  const justAfter = new Date(2026, 10, 2, 7, 1);
  assert.equal(nextOccurrence(alarm, justAfter).getTime(), new Date(2026, 10, 9, 7, 0).getTime());
});

test('vækkeur: er kun aktuelt i to minutter', () => {
  assert.equal(dueOccurrence(weekdays, new Date(2026, 10, 2, 6, 59, 59)), null);
  assert.ok(dueOccurrence(weekdays, new Date(2026, 10, 2, 7, 0, 0)));
  assert.ok(dueOccurrence(weekdays, new Date(2026, 10, 2, 7, 2, 0)));
  assert.equal(dueOccurrence(weekdays, new Date(2026, 10, 2, 7, 2, 1)), null);
  assert.equal(dueOccurrence(weekdays, new Date(2026, 10, 1, 7, 0, 0)), null, 'søndag');
});

test('vækkeur: virker hen over midnat', () => {
  const alarm = { ...weekdays, time: '23:59', days: [0] };
  assert.ok(dueOccurrence(alarm, new Date(2026, 10, 2, 0, 0, 30)));
});

test('vækkeur: starter musikken én gang', async () => {
  const started = [];
  const storage = newStorage();
  let time = new Date(2026, 10, 2, 7, 0, 0);
  const runner = createAlarmRunner({
    getAlarm: () => weekdays,
    storage,
    now: () => time,
    startMusic: async (uri) => started.push(uri),
    onRing: () => { throw new Error('skulle ikke ringe'); },
  });
  assert.equal(await runner.tick(), true);
  time = new Date(2026, 10, 2, 7, 0, 5);
  assert.equal(await runner.tick(), false);
  assert.deepEqual(started, ['spotify:playlist:a']);
});

test('vækkeur: ringer, når Spotify fejler eller playliste mangler', async () => {
  const rung = [];
  const make = (alarm, startMusic) => createAlarmRunner({
    getAlarm: () => alarm,
    storage: newStorage(),
    now: () => new Date(2026, 10, 2, 7, 0, 0),
    startMusic,
    onRing: (error) => rung.push(error.message),
  });
  await make(weekdays, async () => { throw new Error('nede'); }).tick();
  await make({ ...weekdays, playlistUri: null }, async () => {}).tick();
  assert.deepEqual(rung, ['nede', 'Ingen playliste valgt']);
});

test('vækkeur: genindlæst side vækker ikke igen', async () => {
  const storage = newStorage();
  let count = 0;
  const make = () => createAlarmRunner({
    getAlarm: () => weekdays, storage, now: () => new Date(2026, 10, 2, 7, 1), startMusic: async () => { count++; }, onRing() {},
  });
  await make().tick();
  await make().tick();
  assert.equal(count, 1);
});

test('huskeliste: tilføj, afkryds og slet', () => {
  let n = 0;
  const list = createTodoList(newStorage(), () => `id${++n}`);
  assert.ok(list.add('  Køb mælk  '));
  assert.equal(list.add('   '), false);
  assert.equal(list.add(null), false);
  list.add('Aflever opgave');
  assert.deepEqual(list.items().map((i) => i.text), ['Køb mælk', 'Aflever opgave']);
  list.toggle('id1');
  assert.equal(list.items()[0].done, true);
  list.toggle('id1');
  assert.equal(list.items()[0].done, false);
  list.remove('id1');
  assert.equal(list.items().length, 1);
});

test('huskeliste: forkorter lang tekst og tåler ødelagte data', () => {
  const storage = newStorage();
  const list = createTodoList(storage, () => 'a');
  list.add('x'.repeat(500));
  assert.equal(list.items()[0].text.length, 200);
  storage.set('todo.items', 'ikke en liste');
  assert.deepEqual(list.items(), []);
  storage.set('todo.items', [null, { id: 1 }, { id: 'ok', text: 'god' }]);
  assert.equal(list.items().length, 1);
});

test('nat: tidsrum over midnat', () => {
  const at = (h, m = 0) => new Date(2026, 10, 1, h, m);
  assert.equal(isNightTime(at(21, 59), '22:00', '07:00'), false);
  assert.equal(isNightTime(at(22, 0), '22:00', '07:00'), true);
  assert.equal(isNightTime(at(3), '22:00', '07:00'), true);
  assert.equal(isNightTime(at(6, 59), '22:00', '07:00'), true);
  assert.equal(isNightTime(at(7), '22:00', '07:00'), false);
});

test('nat: tidsrum inden for samme dag og ens tider', () => {
  const at = (h) => new Date(2026, 10, 1, h);
  assert.equal(isNightTime(at(13), '12:00', '14:00'), true);
  assert.equal(isNightTime(at(14), '12:00', '14:00'), false);
  assert.equal(isNightTime(at(12), '12:00', '12:00'), false);
});

test('nat: månen gælder til tidsplanen skifter', () => {
  const night = { start: '22:00', end: '07:00' };
  const noon = new Date(2026, 10, 1, 12, 0);
  const override = toggleNight(noon, night, null);
  assert.equal(override.value, true);
  assert.equal(override.until, new Date(2026, 10, 1, 22, 0).getTime());
  assert.equal(isNightActive(noon, night, override), true);
  const later = new Date(2026, 10, 1, 21, 59);
  assert.equal(isNightActive(later, night, override), true);
  assert.equal(isNightActive(new Date(2026, 10, 2, 8, 0), night, override), false);
  assert.equal(isNightActive(noon, night, toggleNight(noon, night, override)), false);
});

test('nat: næste skift kan ligge i morgen', () => {
  const change = nextNightChange(new Date(2026, 10, 1, 23, 0), '22:00', '07:00');
  assert.equal(change.getTime(), new Date(2026, 10, 2, 7, 0).getTime());
});

test('tema: ukendt tema falder tilbage', () => {
  assert.equal(resolveThemeId('neutral'), 'neutral');
  assert.equal(resolveThemeId('findes-ikke'), 'neutral');
});

test('tema: sætter klasser og baggrundsbillede', () => {
  const root = document.createElement('div');
  applyAppearance(root, { themeId: 'x', image: 'data:image/jpeg;base64,AAA', night: true });
  assert.equal(root.dataset.theme, 'neutral');
  assert.ok(root.classList.contains('night'));
  assert.ok(root.classList.contains('has-image'));
  applyAppearance(root, { themeId: 'neutral', image: 'javascript:alert(1)', night: false });
  assert.equal(root.classList.contains('has-image'), false);
  assert.equal(root.style.getPropertyValue('--background-image'), '');
});

test('tema: billeder skaleres ned, ikke op', () => {
  assert.deepEqual(fitInside(4000, 3000), { width: 1600, height: 1200 });
  assert.deepEqual(fitInside(3000, 4000), { width: 1200, height: 1600 });
  assert.deepEqual(fitInside(800, 600), { width: 800, height: 600 });
});

test('indstillinger: standard ved tomt lager og ødelagte data', () => {
  assert.deepEqual(normalizeSettings(null), JSON.parse(JSON.stringify(DEFAULT_SETTINGS)));
  const bad = normalizeSettings({
    clientId: 5,
    place: { name: 'x', latitude: 'ikke tal', longitude: 1 },
    night: { start: '25:00', end: 'nej' },
    alarm: { time: '99:99', days: [1, 1, 9, 'x', 3] },
  });
  assert.equal(bad.clientId, '');
  assert.equal(bad.place, null);
  assert.equal(bad.night.start, '22:00');
  assert.equal(bad.alarm.time, '07:00');
  assert.deepEqual(bad.alarm.days, [1, 3]);
});

test('indstillinger: delvis opdatering bevarer resten', () => {
  const settings = createSettings(newStorage());
  settings.update({ clientId: ' abc ' });
  const next = settings.update({ themeId: 'neutral' });
  assert.equal(next.clientId, 'abc');
  assert.deepEqual(settings.load().alarm.days, [1, 2, 3, 4, 5]);
});
