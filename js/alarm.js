const LAST_FIRED_KEY = 'alarm.lastFired';
const DUE_WINDOW_MS = 2 * 60 * 1000;

function occurrenceOn(alarm, date) {
  const [hours, minutes] = alarm.time.split(':').map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes, 0, 0);
}

function isUsable(alarm) {
  return Boolean(alarm?.enabled && /^\d{2}:\d{2}$/.test(alarm.time ?? '') && alarm.days?.length);
}

function shiftDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

export function nextOccurrence(alarm, now) {
  if (!isUsable(alarm)) return null;
  for (let offset = 0; offset <= 7; offset++) {
    const day = shiftDays(now, offset);
    const occurrence = occurrenceOn(alarm, day);
    if (alarm.days.includes(day.getDay()) && occurrence > now) return occurrence;
  }
  return null;
}

// Den vækning, der skulle være sket for højst to minutter siden. Vinduet gør,
// at en vækning stadig går i gang, selvom siden har været langsom et øjeblik.
export function dueOccurrence(alarm, now) {
  if (!isUsable(alarm)) return null;
  for (const offset of [0, -1]) {
    const day = shiftDays(now, offset);
    if (!alarm.days.includes(day.getDay())) continue;
    const occurrence = occurrenceOn(alarm, day);
    const age = now - occurrence;
    if (age >= 0 && age <= DUE_WINDOW_MS) return occurrence;
  }
  return null;
}

export function createAlarmRunner({ getAlarm, storage, now, startMusic, onRing }) {
  return {
    async tick() {
      const alarm = getAlarm();
      const occurrence = dueOccurrence(alarm, now());
      if (!occurrence) return false;

      const id = occurrence.getTime();
      if (storage.get(LAST_FIRED_KEY) === id) return false;
      storage.set(LAST_FIRED_KEY, id);

      try {
        if (!alarm.playlistUri) throw new Error('Ingen playliste valgt');
        await startMusic(alarm.playlistUri);
      } catch (error) {
        onRing(error);
      }
      return true;
    },
  };
}
