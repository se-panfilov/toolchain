export const periods = ['day', 'week', 'month', 'year'] as const;
export type Period = (typeof periods)[number];

export const periodLabels: Record<Period, string> = { day: 'последние 24 часа', week: 'последние 7 дней', month: 'последний месяц', year: 'последний год' };

/** Move a local date back by whole calendar months. Clamp the day to the last day of the target month, for example 31 March → 28 or 29 February. */
function monthsBack(now: Date, months: number): Date {
  const target = new Date(now.getTime());
  target.setDate(1);
  target.setMonth(target.getMonth() - months);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(now.getDate(), last));
  target.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  return target;
}

/**
 * Return the Unix time (seconds) where the period starts.
 * `day` and `week` are fixed durations of 24 and 168 hours. `month` and `year` are calendar steps in the local time zone.
 * Built-in Date operations are sufficient here, so the package has no date library dependency.
 */
export function periodStart(period: Period, now = new Date()): number {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new Error('Некорректное текущее время.');
  const start = period === 'day' ? time - 24 * 3600 * 1000 : period === 'week' ? time - 7 * 24 * 3600 * 1000 : monthsBack(now, period === 'month' ? 1 : 12).getTime();
  const seconds = Math.floor(start / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > 253402300799) throw new Error('Начало периода должно находиться между 1970 и 9999 годом.');
  return seconds;
}
