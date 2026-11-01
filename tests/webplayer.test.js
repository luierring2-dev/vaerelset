import { test, assert } from './harness.js';
import { createWebPlayer } from '../js/web-player.js';

const tick = () => new Promise((resolve) => { setTimeout(resolve, 0); });

function setup({ withSdk = true, connected = true, timeoutMs = 10000, getToken = async () => 'token' } = {}) {
  const log = { unavailable: [], ready: 0, autoplay: 0, playbackErrors: 0, scripts: [], players: [] };

  class FakePlayer {
    constructor(options) {
      this.options = options;
      this.listeners = {};
      this.activations = 0;
      this.disconnected = false;
      log.players.push(this);
    }

    addListener(name, handler) {
      this.listeners[name] = handler;
    }

    emit(name, payload) {
      this.listeners[name]?.(payload);
    }

    connect() {
      return connected === 'reject' ? Promise.reject(new Error('nej')) : Promise.resolve(connected);
    }

    activateElement() {
      this.activations++;
      return Promise.resolve();
    }

    disconnect() {
      this.disconnected = true;
    }
  }

  const win = {
    document: {
      createElement: () => ({}),
      head: { append: (script) => log.scripts.push(script) },
    },
  };
  if (withSdk) win.Spotify = { Player: FakePlayer };

  const player = createWebPlayer({
    win,
    getToken,
    timeoutMs,
    onReady: () => { log.ready++; },
    onUnavailable: (reason) => log.unavailable.push(reason),
    onAutoplayFailed: () => { log.autoplay++; },
    onPlaybackError: () => { log.playbackErrors++; },
  });
  return { player, log, win, FakePlayer };
}

test('webafspiller: henter Spotifys script, når det mangler', () => {
  const { player, log, win, FakePlayer } = setup({ withSdk: false });
  player.start();
  assert.equal(log.scripts.length, 1);
  assert.equal(log.scripts[0].src, 'https://sdk.scdn.co/spotify-player.js');
  assert.equal(log.players.length, 0, 'venter på scriptet');
  win.Spotify = { Player: FakePlayer };
  win.onSpotifyWebPlaybackSDKReady();
  assert.equal(log.players.length, 1);
  player.stop();
});

test('webafspiller: bruger scriptet direkte, hvis det allerede er der', () => {
  const { player, log } = setup();
  player.start();
  assert.equal(log.scripts.length, 0);
  assert.equal(log.players.length, 1);
  player.stop();
});

test('webafspiller: starter kun én gang', () => {
  const { player, log } = setup();
  player.start();
  player.start();
  assert.equal(log.players.length, 1);
  player.stop();
});

test('webafspiller: hedder Værelset og henter login ved behov', async () => {
  const { player, log } = setup();
  player.start();
  const { options } = log.players[0];
  assert.equal(options.name, 'Værelset');
  const token = await new Promise((resolve) => { options.getOAuthToken(resolve); });
  assert.equal(token, 'token');
  player.stop();
});

test('webafspiller: mislykket login giver ingen uhåndteret fejl', async () => {
  const { player, log } = setup({ getToken: async () => { throw new Error('ude'); } });
  const unhandled = [];
  const listener = (event) => {
    event.preventDefault();
    unhandled.push(String(event.reason));
  };
  window.addEventListener('unhandledrejection', listener);
  player.start();
  let called = false;
  log.players[0].options.getOAuthToken(() => { called = true; });
  await new Promise((resolve) => { setTimeout(resolve, 30); });
  window.removeEventListener('unhandledrejection', listener);
  assert.equal(called, false);
  assert.deepEqual(unhandled, []);
  player.stop();
});

test('webafspiller: er klar først efter ready og giver enhedens id', () => {
  const { player, log } = setup();
  player.start();
  assert.equal(player.getDeviceId(), null);
  log.players[0].emit('ready', { device_id: 'side' });
  assert.equal(player.getDeviceId(), 'side');
  assert.equal(log.ready, 1);
  player.stop();
});

test('webafspiller: mister enheden ved not_ready og kan komme tilbage', () => {
  const { player, log } = setup();
  player.start();
  const fake = log.players[0];
  fake.emit('ready', { device_id: 'side' });
  fake.emit('not_ready', { device_id: 'side' });
  assert.equal(player.getDeviceId(), null);
  assert.deepEqual(log.unavailable, ['not_ready']);
  fake.emit('ready', { device_id: 'side2' });
  assert.equal(player.getDeviceId(), 'side2');
  player.stop();
});

test('webafspiller: fejl melder, at den ikke er til rådighed, og den prøves ikke igen', () => {
  for (const event of ['initialization_error', 'account_error', 'authentication_error']) {
    const { player, log } = setup();
    player.start();
    log.players[0].emit('ready', { device_id: 'side' });
    log.players[0].emit(event, { message: 'nej' });
    assert.deepEqual(log.unavailable, [event]);
    assert.equal(player.getDeviceId(), null, event);
    player.start();
    assert.equal(log.players.length, 1, event);
    player.stop();
  }
});

test('webafspiller: script der ikke kan hentes, kan prøves igen', () => {
  const { player, log } = setup({ withSdk: false });
  player.start();
  log.scripts[0].onerror();
  assert.deepEqual(log.unavailable, ['script']);
  player.start();
  assert.equal(log.scripts.length, 2);
  player.stop();
});

test('webafspiller: giver op efter tidsgrænsen', async () => {
  const { player, log } = setup({ withSdk: false, timeoutMs: 5 });
  player.start();
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  assert.deepEqual(log.unavailable, ['timeout']);
  player.stop();
});

test('webafspiller: ready stopper tidsgrænsen', async () => {
  const { player, log } = setup({ timeoutMs: 5 });
  player.start();
  log.players[0].emit('ready', { device_id: 'side' });
  await new Promise((resolve) => { setTimeout(resolve, 40); });
  assert.deepEqual(log.unavailable, []);
  player.stop();
});

test('webafspiller: mislykket forbindelse melder, at den ikke er til rådighed', async () => {
  for (const connected of [false, 'reject']) {
    const { player, log } = setup({ connected });
    player.start();
    await tick();
    assert.deepEqual(log.unavailable, ['connect']);
    player.stop();
  }
});

test('webafspiller: tryk låser lyd op én gang, og igen efter not_ready', () => {
  const { player, log } = setup();
  player.activate();
  player.start();
  const fake = log.players[0];
  player.activate();
  player.activate();
  assert.equal(fake.activations, 1);
  fake.emit('not_ready', {});
  player.activate();
  assert.equal(fake.activations, 2);
  player.stop();
});

test('webafspiller: videresender blokeret afspilning og afspilningsfejl', () => {
  const { player, log } = setup();
  player.start();
  log.players[0].emit('autoplay_failed');
  log.players[0].emit('playback_error', { message: 'nej' });
  assert.equal(log.autoplay, 1);
  assert.equal(log.playbackErrors, 1);
  player.stop();
});

test('webafspiller: stop afbryder og nulstiller', () => {
  const { player, log } = setup();
  player.start();
  log.players[0].emit('ready', { device_id: 'side' });
  player.stop();
  assert.ok(log.players[0].disconnected, 'afbrudt');
  assert.equal(player.getDeviceId(), null);
  player.stop();
});
