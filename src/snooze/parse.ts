export type SnoozeParse =
  { readonly ok: true; readonly at: Date } | { readonly ok: false; readonly error: string };

export type SnoozePresetId =
  'later_today' | 'tomorrow' | 'this_weekend' | 'next_week' | 'next_month';
export interface SnoozePreset {
  readonly id: SnoozePresetId;
  readonly label: string;
  readonly phrase: string;
}

export const SNOOZE_PRESETS: readonly SnoozePreset[] = [
  { id: 'later_today', label: 'Later today', phrase: 'later today' },
  { id: 'tomorrow', label: 'Tomorrow', phrase: 'tomorrow' },
  { id: 'this_weekend', label: 'This weekend', phrase: 'this weekend' },
  { id: 'next_week', label: 'Next week', phrase: 'next week' },
  { id: 'next_month', label: 'Next month', phrase: 'next month' },
];

const UNRECOGNIZED = 'Try “3d”, “tomorrow 9am”, “fri”, “oct 20 14:00”';
const PASSED = 'That time has already passed';
const MIN_YEAR = 1970;
const LEAP_SEARCH_YEARS = 8;
const NO_SUCH_DATE = 'That date does not exist';
const TOO_LATE = 'Too late for later today';
const DEFAULT_MINUTES = 9 * 60;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const QUARTER_MS = 900_000;
const DAY_MS = 86_400_000;
const MONTH_DAYS = 30;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};
const WEEKDAYS: Readonly<Record<string, number>> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};
const UNIT_MS: Readonly<Record<string, number>> = { m: MINUTE_MS, h: HOUR_MS };
const UNIT_DAYS: Readonly<Record<string, number>> = { d: 1, w: 7, mo: MONTH_DAYS };

const MONTH = Object.keys(MONTHS).join('|');
const WEEKDAY = Object.keys(WEEKDAYS).join('|');
const CLOCK = String.raw`\d{1,2}(?::\d{2})?\s?(?:am|pm)|\d{1,2}:\d{2}|noon`;
const AT_CLOCK = String.raw`(?: (?:at )?(${CLOCK}))?`;
const AT_CLOCK_OR_HOUR = String.raw`(?: (?:at )?(${CLOCK}|\d{1,2}))?`;

const DURATION =
  /^(?:in )?(\d{1,4}) ?(minutes?|mins?|m|hours?|hrs?|h|days?|d|weeks?|w|months?|mo)$/;
const BARE_DAYS = /^\d{1,4}$/;
const DAY_WORD = new RegExp(String.raw`^(today|tomorrow)${AT_CLOCK_OR_HOUR}$`);
const WEEKDAY_FORM = new RegExp(String.raw`^(?:next )?(${WEEKDAY})${AT_CLOCK}$`);
const CLOCK_ALONE = new RegExp(String.raw`^(?:at )?(${CLOCK})$`);
const ISO_DATE = new RegExp(String.raw`^(\d{4})-(\d{2})-(\d{2})${AT_CLOCK}$`);
const MONTH_DAY = new RegExp(String.raw`^(${MONTH}) (\d{1,2})(?: (\d{4}))?${AT_CLOCK}$`);
const DAY_MONTH = new RegExp(String.raw`^(\d{1,2}) (${MONTH})(?: (\d{4}))?${AT_CLOCK}$`);
const CLOCK_PARTS = /^(?:(\d{1,2})(?::(\d{2}))?\s?(am|pm)|(\d{1,2}):(\d{2})|(\d{1,2}))$/;
const WHITESPACE = /\s+/g;

const fail = (error: string): SnoozeParse => ({ ok: false, error });

const finish = (at: Date, now: Date): SnoozeParse => {
  if (Number.isNaN(at.getTime())) return fail(UNRECOGNIZED);
  return at.getTime() > now.getTime() ? { ok: true, at } : fail(PASSED);
};

const minutesOfDay = (hour: number, minute: number): number | null =>
  hour < 24 && minute < 60 ? hour * 60 + minute : null;

// `time` is undefined when the phrase has none; null when it is malformed.
const parseClock = (time: string | undefined): number | null | undefined => {
  if (time === undefined) return undefined;
  if (time === 'noon') return 12 * 60;
  const m = CLOCK_PARTS.exec(time);
  if (m === null) return null;
  if (m[3] !== undefined) {
    const hour = Number(m[1]);
    if (hour < 1 || hour > 12) return null;
    const minute = Number(m[2] ?? '0');
    if (minute > 59) return null;
    return ((hour % 12) + (m[3] === 'pm' ? 12 : 0)) * 60 + minute;
  }
  if (m[4] !== undefined) return minutesOfDay(Number(m[4]), Number(m[5]));
  return minutesOfDay(Number(m[6]), 0);
};

const dayAt = (base: Date, offsetDays: number, minutes: number): Date =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays, 0, minutes);

const atClock = (
  base: Date,
  offsetDays: number,
  time: string | undefined,
  now: Date,
): SnoozeParse => {
  const minutes = parseClock(time);
  if (minutes === null) return fail(UNRECOGNIZED);
  return finish(dayAt(base, offsetDays, minutes ?? DEFAULT_MINUTES), now);
};

const parseDuration = (amount: number, unit: string, now: Date): SnoozeParse => {
  const key = unit.startsWith('mo') ? 'mo' : unit.charAt(0);
  const ms = UNIT_MS[key];
  if (ms !== undefined) return finish(new Date(now.getTime() + amount * ms), now);
  const days = (UNIT_DAYS[key] ?? 0) * amount;
  return finish(
    new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + days,
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
      now.getMilliseconds(),
    ),
    now,
  );
};

const laterToday = (now: Date): SnoozeParse => {
  const at = new Date(Math.ceil((now.getTime() + 3 * HOUR_MS) / QUARTER_MS) * QUARTER_MS);
  return at.getDate() === now.getDate() ? finish(at, now) : fail(TOO_LATE);
};

const thisWeekend = (now: Date): SnoozeParse => {
  const dow = now.getDay();
  const today = dayAt(now, 0, DEFAULT_MINUTES);
  if (dow === 6 && now.getTime() < today.getTime()) return finish(today, now);
  return finish(dayAt(now, (6 - dow + 7) % 7 || 7, DEFAULT_MINUTES), now);
};

const nextMonth = (now: Date): SnoozeParse => {
  const lastDay = new Date(now.getFullYear(), now.getMonth() + 2, 0).getDate();
  const day = Math.min(now.getDate(), lastDay);
  return finish(new Date(now.getFullYear(), now.getMonth() + 1, day, 0, DEFAULT_MINUTES), now);
};

const calendarDate = (year: number, month: number, day: number, minutes: number): Date | null => {
  const at = new Date(year, month, day, 0, minutes);
  return at.getMonth() === month && at.getDate() === day ? at : null;
};

const parseDate = (
  year: string | undefined,
  month: number,
  day: number,
  time: string | undefined,
  now: Date,
): SnoozeParse => {
  const parsed = parseClock(time);
  if (parsed === null) return fail(UNRECOGNIZED);
  const minutes = parsed ?? DEFAULT_MINUTES;
  if (year !== undefined) {
    if (Number(year) < MIN_YEAR) return fail(UNRECOGNIZED);
    const at = calendarDate(Number(year), month, day, minutes);
    return at === null ? fail(NO_SUCH_DATE) : finish(at, now);
  }
  for (let y = now.getFullYear(); y <= now.getFullYear() + LEAP_SEARCH_YEARS; y++) {
    const at = calendarDate(y, month, day, minutes);
    if (at !== null && at.getTime() > now.getTime()) return { ok: true, at };
  }
  return fail(NO_SUCH_DATE);
};

export function parseSnooze(text: string, now: Date): SnoozeParse {
  const s = text.trim().toLowerCase().replace(WHITESPACE, ' ');

  const duration = DURATION.exec(s);
  if (duration !== null) return parseDuration(Number(duration[1]), duration[2] ?? '', now);
  if (BARE_DAYS.test(s)) return parseDuration(Number(s), 'd', now);

  if (s === 'later today' || s === 'later') return laterToday(now);
  if (s === 'this weekend') return thisWeekend(now);
  if (s === 'next week')
    return finish(dayAt(now, (1 - now.getDay() + 7) % 7 || 7, DEFAULT_MINUTES), now);
  if (s === 'next month') return nextMonth(now);

  const dayWord = DAY_WORD.exec(s);
  if (dayWord !== null) return atClock(now, dayWord[1] === 'tomorrow' ? 1 : 0, dayWord[2], now);

  const weekday = WEEKDAY_FORM.exec(s);
  if (weekday !== null) {
    const target = WEEKDAYS[weekday[1] ?? ''] ?? 0;
    return atClock(now, (target - now.getDay() + 7) % 7 || 7, weekday[2], now);
  }

  const clock = CLOCK_ALONE.exec(s);
  if (clock !== null) {
    const minutes = parseClock(clock[1]);
    if (minutes === null || minutes === undefined) return fail(UNRECOGNIZED);
    const today = dayAt(now, 0, minutes);
    return finish(today.getTime() > now.getTime() ? today : dayAt(now, 1, minutes), now);
  }

  const iso = ISO_DATE.exec(s);
  if (iso !== null) return parseDate(iso[1], Number(iso[2]) - 1, Number(iso[3]), iso[4], now);

  const monthDay = MONTH_DAY.exec(s);
  if (monthDay !== null) {
    return parseDate(
      monthDay[3],
      MONTHS[monthDay[1] ?? ''] ?? 0,
      Number(monthDay[2]),
      monthDay[4],
      now,
    );
  }

  const dayMonth = DAY_MONTH.exec(s);
  if (dayMonth !== null) {
    return parseDate(
      dayMonth[3],
      MONTHS[dayMonth[2] ?? ''] ?? 0,
      Number(dayMonth[1]),
      dayMonth[4],
      now,
    );
  }

  return fail(UNRECOGNIZED);
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const pad2 = (n: number): string => String(n).padStart(2, '0');
const localDayNumber = (d: Date): number =>
  Math.round(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS);

export function formatSnoozeTime(at: Date, now: Date): string {
  const clock = `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const diff = localDayNumber(at) - localDayNumber(now);
  if (diff === 0) return `Today, ${clock}`;
  if (diff === 1) return `Tomorrow, ${clock}`;
  const weekday = DAY_NAMES[at.getDay()];
  if (diff > 1 && diff <= 6) return `${weekday}, ${clock}`;
  const year = at.getFullYear() === now.getFullYear() ? '' : ` ${at.getFullYear()}`;
  return `${weekday} ${at.getDate()} ${MONTH_NAMES[at.getMonth()]}${year}, ${clock}`;
}
