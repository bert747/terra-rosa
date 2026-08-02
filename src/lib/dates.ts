export function formatDateUk(isoDate: string | null | undefined): string {
  if (!isoDate) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return isoDate;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function ordinal(day: number): string {
  if (day >= 11 && day <= 13) return `${day}th`;
  switch (day % 10) {
    case 1: return `${day}st`;
    case 2: return `${day}nd`;
    case 3: return `${day}rd`;
    default: return `${day}th`;
  }
}

/** e.g. "Sunday 2nd August" — for headings, not for anything parsed back. */
export function formatDateWithWeekday(isoDate: string | null | undefined): string {
  if (!isoDate || !isIsoDate(isoDate)) return "";
  const d = new Date(`${isoDate}T00:00:00Z`);
  const weekday = WEEKDAY_NAMES[d.getUTCDay()];
  const month = MONTH_NAMES[d.getUTCMonth()];
  return `${weekday} ${ordinal(d.getUTCDate())} ${month}`;
}

export function parseUkDateToIso(input: string): string | null {
  const raw = input.trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!m) return null;
  const day = Number(m[1]);
  const month = Number(m[2]);
  const year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const candidate = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const d = new Date(`${candidate}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  if (d.toISOString().slice(0, 10) !== candidate) return null;
  return candidate;
}

export function isIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function nightsBetween(startIso: string, endIso: string | null): number {
  if (!endIso || !isIsoDate(startIso) || !isIsoDate(endIso)) return 0;
  const start = new Date(`${startIso}T00:00:00Z`).getTime();
  const end = new Date(`${endIso}T00:00:00Z`).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  return Math.max(0, Math.round((end - start) / dayMs));
}
