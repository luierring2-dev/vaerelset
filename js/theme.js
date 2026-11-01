// Designet er ikke besluttet endnu. Et nyt tema er en linje her og en
// [data-theme="..."]-blok med CSS-variabler i style.css.
export const THEMES = [{ id: 'neutral', name: 'Neutral (midlertidig)' }];

const MAX_IMAGE_SIDE = 1600;

export function resolveThemeId(id) {
  return THEMES.some((theme) => theme.id === id) ? id : THEMES[0].id;
}

function minutesOf(time) {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

export function isNightTime(now, start, end) {
  const current = now.getHours() * 60 + now.getMinutes();
  const from = minutesOf(start);
  const to = minutesOf(end);
  if (from === to) return false;
  return from < to ? current >= from && current < to : current >= from || current < to;
}

export function nextNightChange(now, start, end) {
  const candidates = [start, end].flatMap((time) => {
    const minutes = minutesOf(time);
    return [0, 1].map((offset) => new Date(
      now.getFullYear(), now.getMonth(), now.getDate() + offset, Math.floor(minutes / 60), minutes % 60,
    ));
  });
  return candidates.filter((date) => date > now).sort((a, b) => a - b)[0];
}

// Månen på skærmen gælder kun, indtil tidsplanen selv skifter næste gang.
export function isNightActive(now, night, override) {
  if (override && now.getTime() < override.until) return override.value;
  return isNightTime(now, night.start, night.end);
}

export function toggleNight(now, night, override) {
  const value = !isNightActive(now, night, override);
  return { value, until: nextNightChange(now, night.start, night.end).getTime() };
}

export function fitInside(width, height, maxSide = MAX_IMAGE_SIDE) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export async function imageFileToDataUrl(file) {
  const bitmap = await createImageBitmap(file);
  const { width, height } = fitInside(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.8);
}

export function applyAppearance(root, { themeId, image, night }) {
  root.dataset.theme = resolveThemeId(themeId);
  root.classList.toggle('night', Boolean(night));
  const usable = typeof image === 'string' && image.startsWith('data:image/');
  root.classList.toggle('has-image', usable);
  const value = usable ? `url("${image}")` : '';
  // Kaldes hvert sekund. Et uændret billede må ikke tegnes om på en ældre iPad.
  if (root.style.getPropertyValue('--background-image') === value) return;
  if (usable) root.style.setProperty('--background-image', value);
  else root.style.removeProperty('--background-image');
}
