import { expect } from '@playwright/test';

/**
 * Result of comparing ticker symbols observed in the UI vs the expected allowlist.
 *
 * The analysis is designed for a "one ticker per row" table model.
 */
export type TickerMismatch = {
  /** Expected tickers missing from the table. */
  missing: string[];
  /** Unexpected tickers present in the table. */
  extra: string[];
  /** Whether the table contains duplicate ticker rows. */
  hasDuplicateRows: boolean;
  /** Number of tickers in the expected allowlist. */
  expectedCount: number;
  /** Total number of rows parsed from the table. */
  actualRowCount: number;
  /** Number of unique tickers found in `actual`. */
  uniqueCount: number;
};

/**
 * Computes set-like differences between `actual` and `expected` tickers.
 *
 * Notes:
 * - `actual` may contain duplicates if the table rendered the same ticker multiple times.
 * - `expected` is treated as the authoritative allowlist.
 */
export function analyzeTickerSets(actual: string[], expected: readonly string[]): TickerMismatch {
  const uniq = [...new Set(actual)];
  const missing = [...expected].filter((t) => !uniq.includes(t)).sort();
  const extra = uniq.filter((t) => !expected.includes(t)).sort();
  const hasDuplicateRows = uniq.length !== actual.length;
  return {
    missing,
    extra,
    hasDuplicateRows,
    expectedCount: expected.length,
    actualRowCount: actual.length,
    uniqueCount: uniq.length,
  };
}

/**
 * Asserts that the table's ticker column matches the expected allowlist exactly.
 *
 * This check requires:
 * - no duplicate rows (one row per ticker)
 * - no missing tickers
 * - no unexpected tickers
 * - row count equals expected count
 */
export function assertTickerColumnMatches(
  actual: string[],
  expected: readonly string[],
  context: string,
): void {
  const mismatch = analyzeTickerSets(actual, expected);
  const setsEqual =
    !mismatch.hasDuplicateRows &&
    mismatch.missing.length === 0 &&
    mismatch.extra.length === 0 &&
    mismatch.actualRowCount === expected.length;

  expect(
    setsEqual,
    `${context}\n\n${formatTickerMismatchExplanation(context, mismatch)}`,
  ).toBe(true);
}

/**
 * Builds a detailed, human-readable explanation of a mismatch for assertion messages.
 *
 * The output is formatted for both terminal logs and Playwright HTML report rendering.
 */
function formatTickerMismatchExplanation(title: string, m: TickerMismatch): string {
  const lines: string[] = [
    'What went wrong',
    '---------------',
    `• ${title}`,
    '',
    'Numbers',
    '-------',
    `• Rows in the table: ${m.actualRowCount}`,
    `• Unique ticker symbols: ${m.uniqueCount}`,
    `• Symbols we expect (${m.expectedCount}): full list is in tests/fixtures/tickers.ts`,
    '',
  ];
  if (m.hasDuplicateRows) {
    lines.push('Issue: at least one ticker appears in more than one row.');
    lines.push('');
  }
  if (m.missing.length) {
    lines.push(`Missing symbols — should be in the Ticker column (${m.missing.length}):`);
    lines.push(`  ${m.missing.join(', ')}`);
    lines.push('');
  }
  if (m.extra.length) {
    lines.push(`Unexpected symbols — in the table but not in our expected list (${m.extra.length}):`);
    lines.push(`  ${m.extra.join(', ')}`);
    lines.push('');
  }
  if (!m.hasDuplicateRows && !m.missing.length && !m.extra.length) {
    lines.push('Ticker sets align; if you still see this message, compare row counts.');
  }
  return lines.join('\n');
}
