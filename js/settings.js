const KEY = 'settings';

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DEFAULT_SETTINGS = Object.freeze({
  clientId: '',
  place: null,
  themeId: 'neutral',
  night: { start: '22:00', end: '07:00' },
  alarm: {
    enabled: false,
    time: '07:00',
    days: [1, 2, 3, 4, 5],
    playlistUri: null,
    playlistName: null,
  },
});

function validPlace(place) {
  return place && typeof place.name === 'string'
    && Number.isFinite(place.latitude) && Number.isFinite(place.longitude)
    ? place
    : null;
}

export function normalizeSettings(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const defaults = DEFAULT_SETTINGS;
  const alarm = value.alarm ?? {};
  const night = value.night ?? {};
  return {
    clientId: typeof value.clientId === 'string' ? value.clientId.trim() : '',
    place: validPlace(value.place),
    themeId: typeof value.themeId === 'string' ? value.themeId : defaults.themeId,
    night: {
      start: TIME_PATTERN.test(night.start) ? night.start : defaults.night.start,
      end: TIME_PATTERN.test(night.end) ? night.end : defaults.night.end,
    },
    alarm: {
      enabled: Boolean(alarm.enabled),
      time: TIME_PATTERN.test(alarm.time) ? alarm.time : defaults.alarm.time,
      days: Array.isArray(alarm.days)
        ? [...new Set(alarm.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))]
        : [...defaults.alarm.days],
      playlistUri: typeof alarm.playlistUri === 'string' ? alarm.playlistUri : null,
      playlistName: typeof alarm.playlistName === 'string' ? alarm.playlistName : null,
    },
  };
}

export function createSettings(storage) {
  return {
    load: () => normalizeSettings(storage.get(KEY)),
    save: (settings) => storage.set(KEY, normalizeSettings(settings)),
    update(change) {
      const next = normalizeSettings({ ...normalizeSettings(storage.get(KEY)), ...change });
      storage.set(KEY, next);
      return next;
    },
  };
}
