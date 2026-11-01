import { dayName, formatDate, formatTime } from './clock.js';
import { createAlarmRunner, nextOccurrence } from './alarm.js';
import { DEFAULT_CLIENT_ID } from './config.js';
import { createMusicView } from './music.js';
import { createAlarmSound } from './sound.js';
import { createSettings } from './settings.js';
import {
  AuthRequiredError, createSpotify, NetworkError, NoDeviceError, redirectUriFrom,
} from './spotify.js';
import { createStorage } from './storage.js';
import { applyAppearance, imageFileToDataUrl, isNightActive, THEMES, resolveThemeId, toggleNight } from './theme.js';
import { createTodoList } from './todo.js';
import { createWeatherService, searchCity } from './weather.js';
import { createWebPlayer } from './web-player.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const WEATHER_INTERVAL = 15 * MINUTE;
const PLAYLIST_INTERVAL = 60 * MINUTE;
const PLAYBACK_INTERVAL = 5 * SECOND;
const NIGHT_PEEK_MS = 10 * SECOND;
const MESSAGE_MS = 5 * SECOND;
const ALARM_MAX_MS = 15 * MINUTE;
const ALARM_CHECK_MS = 10 * SECOND;
const AUTOPLAY_ALARM_WINDOW_MS = MINUTE;

export function start(deps = {}) {
  const doc = deps.document ?? document;
  const fetchFn = deps.fetch ?? ((...args) => fetch(...args));
  const storage = deps.storage ?? createStorage(localStorage);
  const now = deps.now ?? (() => new Date());
  const navigate = deps.navigate ?? ((url) => location.assign(url));
  const pageUrl = deps.pageUrl ?? location.href;
  const clearUrl = deps.clearUrl ?? (() => history.replaceState(null, '', redirectUriFrom(location.href)));
  const alarmSound = deps.alarmSound ?? createAlarmSound();
  const settleMs = deps.settleMs ?? 500;
  const alarmMaxMs = deps.alarmMaxMs ?? ALARM_MAX_MS;
  const alarmCheckMs = deps.alarmCheckMs ?? ALARM_CHECK_MS;
  const weatherRetryMs = deps.weatherRetryMs ?? MINUTE;

  const $ = (id) => doc.getElementById(id);
  const root = doc.documentElement;
  const listeners = new AbortController();
  const timers = [];
  const { signal } = listeners;

  const settings = createSettings(storage, deps.defaultClientId ?? DEFAULT_CLIENT_ID);
  const todos = createTodoList(storage);
  const weather = createWeatherService({ fetch: fetchFn, storage, now });
  const redirectUri = redirectUriFrom(pageUrl);
  const spotify = createSpotify({
    getClientId: () => settings.load().clientId,
    fetch: fetchFn,
    storage,
    now,
    redirectUri,
    getPreferredDeviceId: () => webPlayer.getDeviceId(),
  });
  const webPlayer = (deps.createWebPlayer ?? createWebPlayer)({
    getToken: () => spotify.getAccessToken(),
    onReady: () => renderPlayer(),
    onUnavailable: () => renderPlayer(),
    onAutoplayFailed: handleAutoplayFailed,
    onPlaybackError: () => showMessage('Nummeret kunne ikke afspilles'),
  });

  const state = {
    playback: null,
    playlists: [],
    playlistsLoaded: false,
    weatherMissing: false,
    noDevice: false,
    polling: false,
    stopped: false,
    alarmStartedAt: null,
    image: storage.get('theme.image'),
  };
  let messageTimer = null;
  let peekTimer = null;
  let alarmTimer = null;

  // Uret kører hvert sekund, så teksten skrives kun, når den faktisk ændrer sig.
  function setText(id, text) {
    const node = $(id);
    if (node.textContent !== text) node.textContent = text;
  }

  // Uret kører hvert sekund, så teksten skrives kun, når den faktisk ændrer sig.
  function setText(id, text) {
    const node = $(id);
    if (node.textContent !== text) node.textContent = text;
  }

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showMessage(text) {
    const box = $('message');
    box.textContent = text;
    box.hidden = false;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => { box.hidden = true; }, MESSAGE_MS);
  }

  // ---- Ur, natfunktion og vækkeur ----

  function renderAppearance() {
    const current = settings.load();
    applyAppearance(root, {
      themeId: current.themeId,
      image: state.image,
      night: isNightActive(now(), current.night, storage.get('night.override')),
    });
  }

  function renderNextAlarm() {
    const next = nextOccurrence(settings.load().alarm, now());
    setText('next-alarm', next ? `Vækkes ${dayName(next).slice(0, 3).toLowerCase()} ${formatTime(next)}` : '');
  }

  const alarmRunner = createAlarmRunner({
    getAlarm: () => settings.load().alarm,
    storage,
    now,
    startMusic: async (uri) => {
      state.alarmStartedAt = now().getTime();
      await spotify.playPlaylist(uri);
      setTimeout(pollPlayback, settleMs);
      setTimeout(verifyAlarmMusic, alarmCheckMs);
    },
    onRing: ringAlarm,
  });

  // iOS kan blokere lyden, selvom Spotify svarer, at alt er i orden. Et vækkeur må ikke fejle i stilhed.
  async function verifyAlarmMusic() {
    if (state.stopped) return;
    try {
      const playback = await spotify.getPlayback();
      if (!playback?.isPlaying) ringAlarm(new Error('Musikken startede ikke'));
    } catch (error) {
      ringAlarm(error);
    }
  }

  function handleAutoplayFailed() {
    const sinceAlarm = now().getTime() - (state.alarmStartedAt ?? -Infinity);
    if (sinceAlarm < AUTOPLAY_ALARM_WINDOW_MS) ringAlarm(new Error('iPad’en blokerede musikken'));
    else showMessage('Tryk på afspil for at starte musikken');
  }

  function ringAlarm(error) {
    $('alarm-reason').textContent = errorText(error);
    $('alarm-overlay').hidden = false;
    alarmSound.start();
    clearTimeout(alarmTimer);
    alarmTimer = setTimeout(stopAlarm, alarmMaxMs);
  }

  function stopAlarm() {
    clearTimeout(alarmTimer);
    $('alarm-overlay').hidden = true;
    alarmSound.stop();
  }

  function tickClock() {
    const current = now();
    setText('time', formatTime(current));
    setText('date', formatDate(current));
    renderAppearance();
    renderNextAlarm();
    return alarmRunner.tick();
  }

  // ---- Vejr ----

  async function refreshWeather() {
    const { place } = settings.load();
    const clear = () => {
      $('weather-temp').textContent = '';
      $('weather-hours').replaceChildren();
      $('weather-days').replaceChildren();
    };
    if (!place) {
      clear();
      state.weatherMissing = false;
      $('weather-text').textContent = 'Vælg din by i indstillinger';
      $('weather-note').textContent = '';
      return;
    }
    const result = await weather.refresh(place);
    state.weatherMissing = result.stale;
    if (!result.data) {
      clear();
      $('weather-text').textContent = 'Vejret kan ikke hentes lige nu';
      $('weather-note').textContent = place.name;
      return;
    }
    const { data } = result;
    $('weather-temp').textContent = `${data.temperature}°`;
    $('weather-text').textContent = data.text;
    $('weather-note').textContent = result.stale
      ? `Fra ${formatTime(new Date(result.fetchedAt))}, ingen forbindelse`
      : place.name;
    $('weather-hours').replaceChildren(...data.hours.map((hour) => element('li', '', `${hour.label}: ${hour.temperature}°`)));
    $('weather-days').replaceChildren(...data.days.map((day) => element('li', '', `${day.label}: ${day.low}° til ${day.high}°`)));
  }

  // ---- Musik ----

  function errorText(error) {
    if (error instanceof NetworkError) return 'Ingen forbindelse til nettet';
    return error?.message || 'Noget gik galt';
  }

  function renderPlayer(note = '') {
    const { playback, noDevice } = state;
    const loggedIn = spotify.isLoggedIn();
    const hasTrack = Boolean(playback?.title);

    const needsNewLogin = spotify.needsNewLogin();

    for (const prefix of ['track', 'music-now']) {
      $(`${prefix}-title`).textContent = hasTrack ? playback.title : 'Intet spiller';
      $(`${prefix}-artist`).textContent = hasTrack ? playback.artist : '';
    }

    const cover = $('cover');
    const coverUrl = playback?.coverUrl?.startsWith('https://') ? playback.coverUrl : null;
    if (coverUrl && cover.getAttribute('src') !== coverUrl) cover.src = coverUrl;
    cover.hidden = !coverUrl;

    const playing = Boolean(playback?.isPlaying);
    for (const prefix of ['', 'music-']) {
      $(`${prefix}icon-play`).toggleAttribute('hidden', playing);
      $(`${prefix}icon-pause`).toggleAttribute('hidden', !playing);
      $(`${prefix}play-pause`).setAttribute('aria-label', playing ? 'Pause' : 'Afspil');
    }

    $('login').hidden = loggedIn && !needsNewLogin;
    $('music-open').hidden = !loggedIn || needsNewLogin;
    // Når siden selv kan spille, er Spotify-appen ikke nødvendig.
    const appNeeded = loggedIn && !webPlayer.getDeviceId() && (noDevice || !playback);
    $('open-spotify').hidden = !appNeeded;
    $('music-open-spotify').hidden = !appNeeded;

    let text = note;
    if (!loggedIn) text = 'Ikke logget ind på Spotify';
    else if (needsNewLogin) text = 'Log ind igen for at bruge musikskærmen';
    else if (noDevice) text = 'Spotify er ikke åben på iPad’en';
    else if (!text && playback?.deviceName) text = `Spiller på ${playback.deviceName}`;
    $('player-note').textContent = text;
  }

  function startWebPlayer() {
    if (spotify.isLoggedIn() && !spotify.needsNewLogin()) webPlayer.start();
  }

  function openMusic() {
    if (spotify.isLoggedIn() && !spotify.needsNewLogin()) music.open();
  }

  function handleSpotifyError(error, { quiet = false } = {}) {
    if (error instanceof NoDeviceError) state.noDevice = true;
    if (error instanceof AuthRequiredError) state.playback = null;
    renderPlayer(error instanceof NoDeviceError || error instanceof AuthRequiredError ? '' : errorText(error));
    if (!quiet) showMessage(errorText(error));
  }

  async function pollPlayback() {
    if (state.stopped) return;
    if (!spotify.isLoggedIn()) {
      renderPlayer();
      return;
    }
    if (state.polling || doc.hidden) return;
    state.polling = true;
    try {
      state.playback = await spotify.getPlayback();
      state.noDevice = false;
      renderPlayer();
      // Mislykkedes hentningen ved opstart, skal listen ikke vente en hel time.
      if (!state.playlistsLoaded) await loadPlaylists();
    } catch (error) {
      handleSpotifyError(error, { quiet: true });
    } finally {
      state.polling = false;
    }
  }

  async function loadPlaylists() {
    if (!spotify.isLoggedIn()) {
      state.playlists = [];
      state.playlistsLoaded = false;
      renderPlaylists();
      return;
    }
    try {
      const playlists = await spotify.getPlaylists();
      state.playlistsLoaded = true;
      // Listen tegnes ikke om uden grund, for så mister man sin plads i den.
      if (JSON.stringify(playlists) === JSON.stringify(state.playlists)) return;
      state.playlists = playlists;
      renderPlaylists();
    } catch (error) {
      handleSpotifyError(error, { quiet: true });
    }
  }

  function renderPlaylists() {
    const buttons = state.playlists.map((playlist) => {
      const button = element('button', 'playlist-button', playlist.name);
      button.type = 'button';
      button.addEventListener('click', () => playerAction(() => spotify.playPlaylist(playlist.uri)));
      const item = element('li');
      item.append(button);
      return item;
    });
    $('playlists').replaceChildren(...buttons);
  }

  async function playerAction(action) {
    try {
      await action();
      state.noDevice = false;
      await wait(settleMs);
      await pollPlayback();
    } catch (error) {
      handleSpotifyError(error);
    }
  }

  const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  async function login() {
    if (!settings.load().clientId) {
      openSettings();
      showMessage('Skriv dit klient-id fra Spotify først');
      return;
    }
    try {
      navigate(await spotify.beginLogin());
    } catch (error) {
      showMessage(errorText(error));
    }
  }

  async function finishLoginFromUrl() {
    const search = new URL(pageUrl).search;
    try {
      if (await spotify.completeLogin(search)) showMessage('Logget ind på Spotify');
    } catch (error) {
      showMessage(errorText(error));
    }
    if (new URLSearchParams(search).has('code') || new URLSearchParams(search).has('error')) clearUrl();
  }

  // ---- Huskeliste ----

  function renderTodos() {
    const items = todos.items().map((todo) => {
      const item = element('li', `todo-item${todo.done ? ' done' : ''}`);
      const toggle = element('button', 'todo-toggle', `${todo.done ? '☑' : '☐'} ${todo.text}`);
      toggle.type = 'button';
      toggle.setAttribute('aria-pressed', String(todo.done));
      toggle.addEventListener('click', () => { todos.toggle(todo.id); renderTodos(); });
      const remove = element('button', 'todo-remove', '✕');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Slet ${todo.text}`);
      remove.addEventListener('click', () => { todos.remove(todo.id); renderTodos(); });
      item.append(toggle, remove);
      return item;
    });
    $('todo-list').replaceChildren(...items);
  }

  // ---- Indstillinger ----

  function fillSelect(select, options, selected) {
    select.replaceChildren(...options.map(({ value, label }) => {
      const option = element('option', '', label);
      option.value = value;
      option.selected = value === selected;
      return option;
    }));
  }

  function renderLoginStatus() {
    const loggedIn = spotify.isLoggedIn();
    $('login-status').textContent = loggedIn ? 'Logget ind' : 'Ikke logget ind';
    $('logout').hidden = !loggedIn;
    $('export-code').hidden = !loggedIn;
    $('settings-login').hidden = loggedIn;
  }

  function renderPlaceCurrent() {
    const { place } = settings.load();
    $('place-current').textContent = place ? `Valgt: ${place.name}` : 'Ingen by valgt';
  }

  function alarmPlaylistOptions(alarm) {
    const options = [{ value: '', label: 'Ingen (alarmlyd)' }];
    for (const playlist of state.playlists) options.push({ value: playlist.uri, label: playlist.name });
    if (alarm.playlistUri && !state.playlists.some((playlist) => playlist.uri === alarm.playlistUri)) {
      options.push({ value: alarm.playlistUri, label: alarm.playlistName ?? 'Gemt playliste' });
    }
    return options;
  }

  function openSettings() {
    const current = settings.load();
    $('client-id').value = current.clientId;
    $('redirect-uri').textContent = redirectUri;
    $('alarm-enabled').checked = current.alarm.enabled;
    $('alarm-time').value = current.alarm.time;
    for (const box of $('alarm-days').querySelectorAll('input')) {
      box.checked = current.alarm.days.includes(Number(box.value));
    }
    fillSelect($('alarm-playlist'), alarmPlaylistOptions(current.alarm), current.alarm.playlistUri ?? '');
    $('night-start').value = current.night.start;
    $('night-end').value = current.night.end;
    fillSelect($('theme-select'), THEMES.map((theme) => ({ value: theme.id, label: theme.name })), resolveThemeId(current.themeId));
    $('image-remove').hidden = !state.image;
    $('city-results').replaceChildren();
    $('city-input').value = '';
    $('login-code').value = '';
    renderPlaceCurrent();
    renderLoginStatus();
    $('settings').showModal();
  }

  function saveSettings() {
    const days = [...$('alarm-days').querySelectorAll('input:checked')].map((box) => Number(box.value));
    const select = $('alarm-playlist');
    const playlistUri = select.value || null;
    settings.update({
      clientId: $('client-id').value,
      themeId: $('theme-select').value,
      night: { start: $('night-start').value, end: $('night-end').value },
      alarm: {
        enabled: $('alarm-enabled').checked,
        time: $('alarm-time').value,
        days,
        playlistUri,
        playlistName: playlistUri ? select.options[select.selectedIndex].textContent : null,
      },
    });
    // En ny natplan skal gælde med det samme, ikke først når månen udløber.
    storage.remove('night.override');
    $('settings').close();
    renderPlayer();
    return tickClock();
  }

  async function runCitySearch() {
    const name = $('city-input').value.trim();
    if (!name) {
      showMessage('Skriv navnet på din by');
      return;
    }
    try {
      const results = await searchCity(name, fetchFn);
      if (!results.length) showMessage('Fandt ingen by med det navn');
      $('city-results').replaceChildren(...results.map((place) => {
        const label = place.region ? `${place.name}, ${place.region}` : place.name;
        const button = element('button', 'playlist-button', label);
        button.type = 'button';
        button.addEventListener('click', () => {
          settings.update({ place });
          $('city-results').replaceChildren();
          renderPlaceCurrent();
          refreshWeather();
        });
        const item = element('li');
        item.append(button);
        return item;
      }));
    } catch (error) {
      showMessage(errorText(error));
    }
  }

  async function chooseImage(file) {
    if (!file) return;
    try {
      const dataUrl = await imageFileToDataUrl(file);
      if (!storage.set('theme.image', dataUrl)) {
        showMessage('Billedet er for stort til at gemme');
        return;
      }
      state.image = dataUrl;
      $('image-remove').hidden = false;
      renderAppearance();
    } catch {
      showMessage('Billedet kunne ikke læses');
    }
  }

  // ---- Knapper ----

  function on(id, type, handler) {
    $(id).addEventListener(type, handler, { signal });
  }

  const togglePlayback = () => playerAction(() => (state.playback?.isPlaying ? spotify.pause() : spotify.play()));
  const music = createMusicView({
    doc,
    spotify,
    play: playerAction,
    errorText,
    onAuthRequired: () => renderPlayer(),
    signal,
  });

  on('play-pause', 'click', togglePlayback);
  on('music-play-pause', 'click', togglePlayback);
  on('next', 'click', () => playerAction(() => spotify.next()));
  on('music-next', 'click', () => playerAction(() => spotify.next()));
  on('previous', 'click', () => playerAction(() => spotify.previous()));
  on('music-open', 'click', openMusic);
  on('cover-frame', 'click', openMusic);
  on('login', 'click', login);
  on('alarm-stop', 'click', stopAlarm);

  on('todo-form', 'submit', (event) => {
    event.preventDefault();
    if (todos.add($('todo-input').value)) $('todo-input').value = '';
    renderTodos();
  });

  on('night-toggle', 'click', () => {
    const current = settings.load();
    storage.set('night.override', toggleNight(now(), current.night, storage.get('night.override')));
    root.classList.remove('night-peek');
    renderAppearance();
  });

  // Retur-tasten må ikke lukke vinduet og smide det, man har skrevet.
  on('settings-form', 'submit', (event) => {
    event.preventDefault();
    if (doc.activeElement === $('city-input')) runCitySearch();
  });

  on('settings-open', 'click', openSettings);
  on('settings-cancel', 'click', () => $('settings').close());
  on('settings-save', 'click', saveSettings);
  on('city-search', 'click', runCitySearch);
  on('image-input', 'change', (event) => chooseImage(event.target.files[0]));
  on('image-remove', 'click', () => {
    storage.remove('theme.image');
    state.image = null;
    $('image-remove').hidden = true;
    renderAppearance();
  });

  on('settings-login', 'click', () => {
    settings.update({ clientId: $('client-id').value });
    login();
  });
  on('logout', 'click', () => {
    spotify.logout();
    state.playback = null;
    state.playlists = [];
    renderPlaylists();
    renderPlayer();
    renderLoginStatus();
  });
  on('export-code', 'click', () => {
    try {
      $('login-code').value = spotify.exportLoginCode();
    } catch (error) {
      showMessage(errorText(error));
    }
  });
  on('import-code', 'click', async () => {
    try {
      const clientId = spotify.importLoginCode($('login-code').value);
      settings.update({ clientId });
      $('client-id').value = clientId;
      $('login-code').value = '';
      renderLoginStatus();
      showMessage('Logget ind på Spotify');
      await loadPlaylists();
      await pollPlayback();
      startWebPlayer();
    } catch (error) {
      showMessage(errorText(error));
    }
  });

  doc.addEventListener('pointerdown', () => {
    if (!root.classList.contains('night')) return;
    root.classList.add('night-peek');
    clearTimeout(peekTimer);
    peekTimer = setTimeout(() => root.classList.remove('night-peek'), NIGHT_PEEK_MS);
  }, { signal, capture: true });

  // pointerdown tæller ikke som et tryk, der må låse lyd op på iOS. Det gør disse to.
  for (const type of ['touchend', 'click']) {
    doc.addEventListener(type, () => webPlayer.activate(), { signal, capture: true });
  }

  doc.addEventListener('visibilitychange', () => {
    if (doc.hidden) return;
    tickClock();
    pollPlayback();
    refreshWeather();
    requestWakeLock();
  }, { signal });

  doc.defaultView?.addEventListener('online', () => {
    refreshWeather();
    pollPlayback();
    startWebPlayer();
  }, { signal });

  // Virker ikke altid i hjemmeskærms-apps på iPadOS 17, derfor også Autolås: Aldrig.
  function requestWakeLock() {
    doc.defaultView?.navigator?.wakeLock?.request('screen').catch(() => {});
  }

  // ---- Opstart ----

  const ready = (async () => {
    tickClock();
    renderTodos();
    renderPlayer();
    await finishLoginFromUrl();
    renderPlayer();
    startWebPlayer();
    await Promise.all([refreshWeather(), loadPlaylists(), pollPlayback()]);
  })();

  if (deps.autoRun !== false) {
    timers.push(
      setInterval(tickClock, SECOND),
      setInterval(pollPlayback, PLAYBACK_INTERVAL),
      setInterval(refreshWeather, WEATHER_INTERVAL),
      setInterval(() => { if (state.weatherMissing) refreshWeather(); }, weatherRetryMs),
      setInterval(loadPlaylists, PLAYLIST_INTERVAL),
    );
    requestWakeLock();
  }

  return {
    ready,
    tickClock,
    pollPlayback,
    refreshWeather,
    loadPlaylists,
    stop() {
      state.stopped = true;
      listeners.abort();
      timers.forEach(clearInterval);
      [messageTimer, peekTimer, alarmTimer].forEach(clearTimeout);
      alarmSound.stop();
      webPlayer.stop();
    },
  };
}
