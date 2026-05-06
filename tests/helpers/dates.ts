import Holidays from 'date-holidays';
import { DateTime } from 'luxon';

/** IANA timezone identifier used for "ET" expectations in tests. */
const NY_TZ = 'America/New_York';

/** US holiday calendar used to decide whether a working day is "open". */
const hd = new Holidays('US');

/**
 * Returns today's calendar date parts in America/New_York.
 *
 * Uses `en-CA` formatting to get a stable `YYYY-MM-DD` string, then parses it.
 */
function todayPartsET(): { y: number; m: number; d: number } {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: NY_TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const [y, m, d] = s.split('-').map(Number);
  return { y, m, d };
}

/**
 * Returns whether it is currently Saturday/Sunday in New York time.
 *
 * Used to widen expectations in places where data can lag over weekends.
 */
function isWeekendET(): boolean {
  const now = DateTime.now().setZone(NY_TZ);
  return now.weekday === 6 || now.weekday === 7;
}

/** M/D/YYYY without leading zeros, matching site (e.g. 4/18/2026). */
export function formatUsMdy(parts: { y: number; m: number; d: number }): string {
  return `${parts.m}/${parts.d}/${parts.y}`;
}

/**
 * Minimal subset of the `date-holidays` holiday record we care about.
 *
 * The library can return a single rule or a list of rules for a given date.
 */
type HolidayRule = { type?: string; name?: string };

/**
 * Returns whether a holiday rule should be treated as closing the working day.
 *
 * We only consider `public` and `bank` days as closures and intentionally ignore
 * observance-only events like Easter for these checks.
 */
function holidayClosesWorkingDay(rule: HolidayRule): boolean {
  const t = rule.type ?? '';
  if (t !== 'public' && t !== 'bank') return false;
  const n = String(rule.name ?? '').toLowerCase();
  // Easter is not treated as a US non-working day for these checks (and is usually `observance` anyway).
  if (n.includes('easter')) return false;
  return true;
}

/**
 * Monday–Friday in New York **and** not a US federal-style holiday (`public` / `bank` in `date-holidays`).
 * Observance-only days (e.g. Easter Sunday) do not close the working day.
 */
export function isUsWorkingDayET(y: number, m: number, d: number): boolean {
  const dt = DateTime.fromObject({ year: y, month: m, day: d }, { zone: NY_TZ }).set({ hour: 12 });
  const wd = dt.weekday; // 1 = Mon … 7 = Sun
  if (wd === 6 || wd === 7) return false;

  const raw = hd.isHoliday(dt.toJSDate());
  if (!raw) return true;
  const rules: HolidayRule[] = Array.isArray(raw) ? raw : [raw as HolidayRule];
  return !rules.some(holidayClosesWorkingDay);
}

/**
 * Last US working day strictly before **today’s** calendar date in America/New_York.
 * Skips weekends and US `public` / `bank` holidays (not observance-only days such as Easter).
 */
export function previousWorkingDayET_usMdy(): string {
  let cur = DateTime.now().setZone(NY_TZ).minus({ days: 1 }).startOf('day');
  for (let i = 0; i < 366; i++) {
    if (isUsWorkingDayET(cur.year, cur.month, cur.day)) {
      return `${cur.month}/${cur.day}/${cur.year}`;
    }
    cur = cur.minus({ days: 1 });
  }
  throw new Error('Could not resolve previous working day within 366 days');
}

/** Previous US working day N times back (N=1 equals `previousWorkingDayET_usMdy()`). */
export function previousWorkingDayET_usMdy_n(n: number): string {
  if (!Number.isFinite(n) || n < 1) throw new Error(`n must be >= 1, got ${n}`);
  let cur = DateTime.now().setZone(NY_TZ).startOf('day');
  let found = 0;
  for (let i = 0; i < 366; i++) {
    cur = cur.minus({ days: 1 });
    if (!isUsWorkingDayET(cur.year, cur.month, cur.day)) continue;
    found++;
    if (found === n) return `${cur.month}/${cur.day}/${cur.year}`;
  }
  throw new Error(`Could not resolve previous working day #${n} within 366 days`);
}

/** Today's calendar date in America/New_York as `M/D/YYYY` (no leading zeros). */
export function todayET_usMdy(): string {
  return formatUsMdy(todayPartsET());
}

/** Last calendar day of the month preceding the current month in America/New_York. */
export function lastDayOfPreviousMonthET_usMdy(): string {
  const { y, m } = todayPartsET();
  const firstOfThisMonth = new Date(Date.UTC(y, m - 1, 1));
  const lastPrev = new Date(firstOfThisMonth);
  lastPrev.setUTCDate(0);
  return formatUsMdy({
    y: lastPrev.getUTCFullYear(),
    m: lastPrev.getUTCMonth() + 1,
    d: lastPrev.getUTCDate(),
  });
}

/** Last calendar day of the month **two months before** today’s calendar month in America/New_York (Luxon). */
export function lastDayOfTwoMonthsPriorMonthET_usMdy(): string {
  const end = DateTime.now().setZone(NY_TZ).minus({ months: 2 }).endOf('month');
  return `${end.month}/${end.day}/${end.year}`;
}

/**
 * Performance data rolls on the **1st** of each ET calendar month at **09:30 ET**.
 * - Any day except the 1st: expect last day of the **previous** calendar month.
 * - On the 1st **before** 09:30 ET: expect last day of the month **two months** before the current month.
 * - On the 1st **at or after** 09:30 ET: expect last day of the **previous** calendar month.
 */
export function performanceExpectedPriorMonthEndSnapshotET_usMdy(): string {
  const now = DateTime.now().setZone(NY_TZ);
  if (now.day === 1) {
    const minutes = now.hour * 60 + now.minute;
    if (minutes < 9 * 60 + 30) return lastDayOfTwoMonthsPriorMonthET_usMdy();
  }
  return lastDayOfPreviousMonthET_usMdy();
}

/** Canonical `M/D/YYYY` (no leading zeros) for stable equality checks. */
export function normalizeUsMdy(usMdy: string): string {
  const m = usMdy.trim().match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  if (!m) throw new Error(`Could not parse US date from: ${JSON.stringify(usMdy)}`);
  return `${Number(m[1])}/${Number(m[2])}/${Number(m[3])}`;
}

export type AsOfPublishWindow = 'during_window' | 'after_window';

/**
 * Controls which "as of" date we should expect in the UI based on New York time (ET).
 *
 * The system updates happen intraday. We treat the "early window" as:
 * - 07:27–09:50 ET: existing expectations (older as-of dates) apply.
 * - After 09:50 ET: some views roll forward to "today" (ET calendar date).
 */
export function currentAsOfPublishWindowET(): AsOfPublishWindow {
  const now = DateTime.now().setZone(NY_TZ);
  const minutes = now.hour * 60 + now.minute;
  const windowStart = 7 * 60 + 27;
  const windowEnd = 9 * 60 + 50;
  if (minutes >= windowStart && minutes <= windowEnd) return 'during_window';
  if (minutes > windowEnd) return 'after_window';
  return 'during_window';
}

export type ExpectedUsMdy =
  | { mode: 'exact'; date: string; reason?: string }
  | { mode: 'one_of'; dates: string[]; reason?: string };

/** Builds an expectation for an exact US date \(normalized to `M/D/YYYY`\). */
export function expectedUsMdyExact(date: string, reason?: string): ExpectedUsMdy {
  return { mode: 'exact', date: normalizeUsMdy(date), reason };
}

/** Builds an expectation that accepts any of the provided dates \(normalized to `M/D/YYYY`\). */
export function expectedUsMdyOneOf(dates: string[], reason?: string): ExpectedUsMdy {
  return { mode: 'one_of', dates: dates.map(normalizeUsMdy), reason };
}

/** Whether the value came from the browser UI or from a downloaded/parsed CSV file. */
export type AsOfAssertionSource = 'ui' | 'csv';

/**
 * Asserts that an "as of" date matches the expected value(s), with a helpful error message.
 *
 * `source` controls whether the message says "site" or "CSV" but uses the same normalization rules.
 */
export function assertUsMdyMatchesExpected(
  actualUsMdy: string,
  expected: ExpectedUsMdy,
  context: string,
  source: AsOfAssertionSource = 'ui',
): void {
  const shownLine = source === 'csv' ? `Shown on CSV: ${normalizeUsMdy(actualUsMdy)}` : `Shown on site: ${normalizeUsMdy(actualUsMdy)}`;
  const actual = normalizeUsMdy(actualUsMdy);
  if (expected.mode === 'exact') {
    if (actual !== expected.date) {
      throw new Error(
        [
          `${context}: as-of date mismatch (America/New_York).`,
          expected.reason ? `Reason: ${expected.reason}` : '',
          '',
          shownLine,
          `Expected: ${expected.date}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }
    return;
  }

  if (!expected.dates.includes(actual)) {
    throw new Error(
      [
        `${context}: as-of date mismatch (America/New_York).`,
        expected.reason ? `Reason: ${expected.reason}` : '',
        '',
        shownLine,
        `Expected one of: ${expected.dates.join(', ')}`,
      ]
        .filter(Boolean)
          .join('\n'),
    );
  }
}

/**
 * Centralized business rules for "as of" expectations across different pages/views.
 *
 * These are intentionally time-dependent in America/New_York and account for:
 * - weekend tolerance where feeds can lag
 * - intraday publish windows (some views roll to "today" after a time cutoff)
 * - performance month-end snapshot behavior
 */
export const expectedAsOf = {
  productTable: {
    overviewFeesUi(): ExpectedUsMdy {
      return isWeekendET()
        ? expectedUsMdyOneOf(
            [previousWorkingDayET_usMdy_n(1), previousWorkingDayET_usMdy_n(2)],
            'Weekend tolerance: data can lag by one extra working day.',
          )
        : expectedUsMdyExact(previousWorkingDayET_usMdy_n(1), 'Overview & Fees stays on previous working day.');
    },
    characteristicsUi(): ExpectedUsMdy {
      return currentAsOfPublishWindowET() === 'after_window'
        ? expectedUsMdyExact(todayET_usMdy(), 'After intraday publish window, Characteristics rolls to today.')
        : isWeekendET()
          ? expectedUsMdyOneOf(
              [previousWorkingDayET_usMdy_n(1), previousWorkingDayET_usMdy_n(2)],
              'Weekend tolerance: during early window, Characteristics can lag by one extra working day.',
            )
          : expectedUsMdyExact(previousWorkingDayET_usMdy_n(1), 'During early window, Characteristics shows previous working day.');
    },
    characteristicsCsv(): ExpectedUsMdy {
      return this.characteristicsUi();
    },
    performanceUi(): ExpectedUsMdy {
      return expectedUsMdyExact(
        performanceExpectedPriorMonthEndSnapshotET_usMdy(),
        'Performance uses prior month-end snapshot; on the 1st ET before 09:30, prior snapshot has not rolled yet.',
      );
    },
  },
  fund: {
    etfMarketDataUi(): ExpectedUsMdy {
      return isWeekendET()
        ? expectedUsMdyOneOf(
            [previousWorkingDayET_usMdy_n(1), previousWorkingDayET_usMdy_n(2)],
            'Weekend tolerance: ETF Market Data can lag by one extra working day.',
          )
        : expectedUsMdyExact(previousWorkingDayET_usMdy_n(1), 'ETF Market Data stays on previous working day.');
    },
    outcomeUi(): ExpectedUsMdy {
      return currentAsOfPublishWindowET() === 'after_window'
        ? expectedUsMdyExact(todayET_usMdy(), 'After intraday publish window, Outcome UI rolls to today.')
        : isWeekendET()
          ? expectedUsMdyOneOf(
              [previousWorkingDayET_usMdy_n(1), previousWorkingDayET_usMdy_n(2)],
              'Weekend tolerance: during early window, Outcome UI can lag by one extra working day.',
            )
          : expectedUsMdyExact(previousWorkingDayET_usMdy_n(1), 'During early window, Outcome UI shows previous working day.');
    },
    holdingsUi(): ExpectedUsMdy {
      return expectedUsMdyExact(todayET_usMdy(), 'Holdings table shows today (FoF and non-FoF).');
    },
    holdingsFofChartStamp(): ExpectedUsMdy {
      return currentAsOfPublishWindowET() === 'after_window'
        ? expectedUsMdyExact(todayET_usMdy(), 'After 09:50 ET, FoF holdings chart stamp is today.')
        : expectedUsMdyExact(previousWorkingDayET_usMdy_n(1), 'Before 09:50 ET, FoF holdings chart stamp is previous working day.');
    },
    performanceUi(): ExpectedUsMdy {
      return expectedUsMdyExact(
        performanceExpectedPriorMonthEndSnapshotET_usMdy(),
        'Performance uses prior month-end snapshot; on the 1st ET before 09:30, prior snapshot has not rolled yet.',
      );
    },
    // Chart CSV rule remains "previous working day row exists" (not an as-of match).
  },
} as const;

/**
 * Requires the displayed As-of date to **exactly match** the previous US working day in New York (no tolerance).
 */
export function assertAsOfIsPreviousWorkingDayET(usMdy: string): void {
  const actual = normalizeUsMdy(usMdy);
  const expected = previousWorkingDayET_usMdy();
  if (actual !== expected) {
    throw new Error(
      [
        '"Data as of" does not match the previous U.S. working day (America/New_York).',
        '',
        `Shown on site or CSV: ${actual}`,
        `Expected (last U.S. business day before today — weekends skipped; federal public/bank holidays skipped; Easter Sunday not counted as a closure): ${expected}`,
        '',
        'If the table is still being updated, the as-of date may be behind; once the feed is current, this check should pass.',
      ].join('\n'),
    );
  }
}
