import type { Locator } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Asserts that a table's `<tbody>` contains no visually-empty `th`/`td` cells.
 *
 * This is used across multiple pages to keep "blank cell" checks consistent.
 *
 * @param table Table locator
 * @param opts.context Human-readable label used in assertion messages
 * @param opts.rowKeyCss Optional CSS selector used to extract a row identifier (e.g. `'th[scope=\"row\"]'` for ticker rows)
 * @param opts.rowKeyExtractor Optional extraction mode for the row key (defaults to first whitespace token)
 * @param opts.skipRowKeys Optional set of row keys to skip (e.g. known exception tickers)
 */
export async function assertNoEmptyTbodyCells(
  table: Locator,
  opts: {
    context: string;
    rowKeyCss?: string;
    rowKeyExtractor?: 'first_token' | 'full_text';
    skipColumnNames?: readonly string[];
    skipRowKeys?: ReadonlySet<string>;
  },
): Promise<void> {
  const empties = await table.evaluate((tbl, arg) => {
    const normalize = (s: string) => s.replace(/\u00a0/g, ' ').trim().replace(/\s+/g, ' ');
    const out: Array<{ row: number; col: number; raw: string; rowKey?: string }> = [];
  
    const wantedSkips = new Set(
      (arg?.skipColumnNames ?? []).map((s) => normalize(String(s)).toLowerCase()),
    );
  
    const skipCols = new Set<number>();
  
    // Find matching header columns by header text.
    const headerRows = Array.from(tbl.querySelectorAll('thead tr'));
    for (const row of headerRows) {
      const cells = Array.from(row.children);
      for (let i = 0; i < cells.length; i++) {
        const text = normalize(cells[i]?.textContent ?? '').toLowerCase();
        if (wantedSkips.has(text)) {
          skipCols.add(i);
        }
      }
    }
  
    const tbodyRows = Array.from(tbl.querySelectorAll('tbody tr'));
    for (let i = 0; i < tbodyRows.length; i++) {
      const row = tbodyRows[i]!;
  
      let key = '';
      if (arg?.rowKeyCss) {
        const el = row.querySelector(arg.rowKeyCss);
        const rawKey = normalize(el?.textContent ?? '');
        if (rawKey) {
          if (arg.rowKeyExtractor === 'full_text') key = rawKey;
          else key = (rawKey.split(/\s+/)[0] ?? '').trim();
        }
      }
  
      if (key && arg?.skipRowKeysUpper?.includes(key.toUpperCase())) continue;
  
      const cells = Array.from(row.querySelectorAll('th, td'));
      for (let j = 0; j < cells.length; j++) {
        if (skipCols.has(j)) continue;
  
        const raw = cells[j]?.textContent ?? '';
        if (normalize(raw).length === 0) {
          out.push({ row: i + 1, col: j + 1, raw, rowKey: key || undefined });
        }
      }
    }
  
    return { rowCount: tbodyRows.length, empties: out };
  }, {
    rowKeyCss: opts.rowKeyCss ?? null,
    rowKeyExtractor: opts.rowKeyExtractor ?? 'first_token',
    skipRowKeysUpper: opts.skipRowKeys ? Array.from(opts.skipRowKeys).map((s) => String(s).toUpperCase()) : null,
    skipColumnNames: opts.skipColumnNames ?? [],
  });

  expect(empties.rowCount, `${opts.context}: expected at least one <tbody> row`).toBeGreaterThan(0);
  expect(
    empties.empties.length,
    empties.empties.length === 0
      ? ''
      : [
          `${opts.context}: empty cell(s) found.`,
          `• First empty: row ${empties.empties[0]!.row}${empties.empties[0]!.rowKey ? ` (${empties.empties[0]!.rowKey})` : ''}, column ${empties.empties[0]!.col}.`,
          `• Raw cell text: ${JSON.stringify(empties.empties[0]!.raw)}`,
          empties.empties.length > 1 ? `• Total empty cells found: ${empties.empties.length}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
  ).toBe(0);
}

