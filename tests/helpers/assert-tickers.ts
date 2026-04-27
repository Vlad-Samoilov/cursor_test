import { expect } from '@playwright/test';

export type TickerMismatch = {
  missing: string[];
  extra: string[];
  hasDuplicateRows: boolean;
  expectedCount: number;
  actualRowCount: number;
  uniqueCount: number;
};

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

/** Plain-language explanation for terminal + HTML report. */
export function formatTickerMismatchBrief(m: TickerMismatch): string {
  const parts: string[] = [];
  parts.push(`Rows in table: ${m.actualRowCount}. Unique tickers: ${m.uniqueCount}. Expected symbols: ${m.expectedCount}.`);
  if (m.hasDuplicateRows) parts.push('Duplicate ticker rows detected.');
  if (m.missing.length) parts.push(`Missing (${m.missing.length}): ${m.missing.join(', ')}.`);
  if (m.extra.length) parts.push(`Unexpected (${m.extra.length}): ${m.extra.join(', ')}.`);
  return parts.join(' ');
}

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
