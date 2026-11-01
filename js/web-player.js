const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
const PLAYER_NAME = 'Værelset';
const START_TIMEOUT_MS = 20000;

// Lader siden selv spille musik via Spotifys webafspiller. Virker den ikke på
// enheden, er getDeviceId bare null, og siden bruger Spotify-appen i stedet.
export function createWebPlayer({
  win = window, getToken, onReady, onUnavailable, onAutoplayFailed, onPlaybackError, timeoutMs = START_TIMEOUT_MS,
}) {
  let player = null;
  let deviceId = null;
  let started = false;
  let activated = false;
  let timer = null;

  function fail(reason) {
    clearTimeout(timer);
    deviceId = null;
    onUnavailable?.(reason);
  }

  function create() {
    player = new win.Spotify.Player({
      name: PLAYER_NAME,
      volume: 1,
      getOAuthToken: (callback) => {
        getToken().then(callback).catch(() => {});
      },
    });
    player.addListener('ready', ({ device_id: id }) => {
      clearTimeout(timer);
      deviceId = id;
      onReady?.();
    });
    player.addListener('not_ready', () => {
      deviceId = null;
      activated = false;
      onUnavailable?.('not_ready');
    });
    for (const error of ['initialization_error', 'account_error', 'authentication_error']) {
      player.addListener(error, () => fail(error));
    }
    player.addListener('playback_error', () => onPlaybackError?.());
    player.addListener('autoplay_failed', () => onAutoplayFailed?.());
    player.connect()
      .then((connected) => {
        if (!connected) fail('connect');
      })
      .catch(() => fail('connect'));
  }

  return {
    start() {
      if (started) return;
      started = true;
      timer = setTimeout(() => fail('timeout'), timeoutMs);
      if (win.Spotify?.Player) {
        create();
        return;
      }
      win.onSpotifyWebPlaybackSDKReady = create;
      const script = win.document.createElement('script');
      script.src = SDK_URL;
      script.onerror = () => {
        // Nettet kan være væk ved opstart. Så må start prøves igen senere.
        script.remove?.();
        started = false;
        fail('script');
      };
      win.document.head.append(script);
    },

    getDeviceId: () => deviceId,

    // iOS kræver, at lyd er låst op af et tryk. Skal kaldes direkte fra et tryk på skærmen.
    activate() {
      if (!player || activated) return;
      activated = true;
      player.activateElement()?.catch?.(() => {});
    },

    stop() {
      clearTimeout(timer);
      player?.disconnect();
      player = null;
      deviceId = null;
      started = false;
      activated = false;
    },
  };
}
