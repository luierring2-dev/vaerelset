const DAYS = ['Søndag', 'Mandag', 'Tirsdag', 'Onsdag', 'Torsdag', 'Fredag', 'Lørdag'];
const MONTHS = [
  'januar', 'februar', 'marts', 'april', 'maj', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'december',
];

const pad = (n) => String(n).padStart(2, '0');

export function formatTime(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatDate(date) {
  return `${DAYS[date.getDay()]} ${date.getDate()}. ${MONTHS[date.getMonth()]}`;
}

export function dayName(date) {
  return DAYS[date.getDay()];
}
