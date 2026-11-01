import { dayName, formatTime } from './clock.js';
import { fetchWithTimeout, NetworkError } from './http.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';

const CACHE_KEY = 'weather.cache';

const WEATHER_TEXT = [
  [[0], 'Klart'],
  [[1], 'Mest klart'],
  [[2], 'Let skyet'],
  [[3], 'Skyet'],
  [[45, 48], 'Tåge'],
  [[51, 53, 55, 56, 57], 'Støvregn'],
  [[61, 63, 65, 66, 67], 'Regn'],
  [[71, 73, 75, 77], 'Sne'],
  [[80, 81, 82], 'Regnbyger'],
  [[85, 86], 'Snebyger'],
  [[95, 96, 99], 'Torden'],
];

export function describeWeatherCode(code) {
  const match = WEATHER_TEXT.find(([codes]) => codes.includes(code));
  return match ? match[1] : 'Ukendt vejr';
}

export function parseForecast(json, now) {
  const hours = [];
  const times = json.hourly?.time ?? [];
  for (let i = 0; i < times.length && hours.length < 4; i++) {
    const time = new Date(times[i]);
    if (time > now && time.getHours() % 3 === 0) {
      hours.push({
        label: formatTime(time),
        temperature: Math.round(json.hourly.temperature_2m[i]),
        text: describeWeatherCode(json.hourly.weather_code[i]),
      });
    }
  }

  const days = [];
  const dates = json.daily?.time ?? [];
  for (let i = 0; i < dates.length && days.length < 3; i++) {
    const date = new Date(`${dates[i]}T12:00`);
    if (date.toDateString() !== now.toDateString() && date > now) {
      days.push({
        label: dayName(date),
        high: Math.round(json.daily.temperature_2m_max[i]),
        low: Math.round(json.daily.temperature_2m_min[i]),
        text: describeWeatherCode(json.daily.weather_code[i]),
      });
    }
  }

  return {
    temperature: Math.round(json.current.temperature_2m),
    text: describeWeatherCode(json.current.weather_code),
    hours,
    days,
  };
}

export function forecastUrl(place) {
  const params = new URLSearchParams({
    latitude: place.latitude,
    longitude: place.longitude,
    current: 'temperature_2m,weather_code',
    hourly: 'temperature_2m,weather_code',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min',
    timezone: 'auto',
    forecast_days: '4',
  });
  return `${FORECAST_URL}?${params}`;
}

export async function searchCity(name, fetchFn) {
  const params = new URLSearchParams({ name: name.trim(), count: '5', language: 'da', format: 'json' });
  const response = await fetchWithTimeout(fetchFn, `${GEOCODING_URL}?${params}`);
  if (!response.ok) throw new NetworkError();
  const json = await response.json();
  return (json.results ?? []).map((result) => ({
    name: result.name,
    region: [result.admin1, result.country].filter(Boolean).join(', '),
    latitude: result.latitude,
    longitude: result.longitude,
  }));
}

export function createWeatherService({ fetch: fetchFn, storage, now }) {
  return {
    async refresh(place) {
      const current = now();
      try {
        const response = await fetchWithTimeout(fetchFn, forecastUrl(place));
        if (!response.ok) throw new NetworkError();
        const data = parseForecast(await response.json(), current);
        const entry = { place: place.name, data, fetchedAt: current.getTime() };
        storage.set(CACHE_KEY, entry);
        return { ...entry, stale: false };
      } catch {
        const cached = storage.get(CACHE_KEY);
        if (cached?.place === place.name) return { ...cached, stale: true };
        return { place: place.name, data: null, fetchedAt: null, stale: true };
      }
    },
  };
}
