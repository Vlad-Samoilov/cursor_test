import { test, expect } from './fixtures/test';
import { ALL_TICKERS, NON_FOF_TICKERS, PERFORMANCE_SKIP_TICKERS, TICKERS_FOF } from './fixtures/tickers';
import {
  assertAsOfIsPreviousWorkingDayET,
  assertUsMdyMatchesExpected,
  expectedAsOf,
} from './helpers/dates';
import { assertTickerColumnMatches } from './helpers/assert-tickers';
import { parseCharacteristicsCsvDownload } from './helpers/characteristics-csv';
import { ProductTablePage } from './po/product-table.po';

test.describe('Product table @smoke', () => {
  /* Not using mode: 'serial' — in serial mode Playwright skips the rest of the group after one failure. */
  test.describe.configure({ timeout: 120_000 });

  test('1. Overview & Fees — tickers, no blank cells, as-of matches prior US working day (ET)', async ({ page }) => {
    await test.step('Open Product Table → Overview & Fees', async () => {
      const pt = new ProductTablePage(page);
      await pt.goto();
      await pt.openTab('Overview & Fees');
    });

    const pt = new ProductTablePage(page);

    await test.step('Ticker column lists every expected ETF symbol', async () => {
      const tickers = await pt.collectTickerSymbols();
      assertTickerColumnMatches(
        tickers,
        ALL_TICKERS,
        'Overview & Fees tab — compare Ticker column to the full expected list',
      );
    });

    await test.step('No empty cells in the table body', async () => {
      await pt.assertNoEmptyCells({ skipRowTickers: PERFORMANCE_SKIP_TICKERS });
    });

    await test.step('"Data as of" equals expected value (ET)', async () => {
      const asOf = await pt.readPrimaryAsOfUsDate();
      assertUsMdyMatchesExpected(asOf, expectedAsOf.productTable.overviewFeesUi(), 'Product Table → Overview & Fees (UI)');
    });
  });

  test('2. Characteristics — FoF excluded; other tickers; no blank cells; as-of prior US working day (ET)', async ({
    page,
  }) => {
    await test.step('Open Product Table → Characteristics', async () => {
      const pt = new ProductTablePage(page);
      await pt.goto();
      await pt.openTab('Characteristics');
    });

    const pt = new ProductTablePage(page);
    const tickers = await pt.collectTickerSymbols();

    await test.step('Fund-of-Funds tickers must not appear (SPBU, SPBX, SPBW)', async () => {
      for (const f of TICKERS_FOF) {
        expect(tickers, `Characteristics tab must not list FoF ticker ${f}`).not.toContain(f);
      }
    });

    await test.step('Ticker column lists every non–FoF ETF symbol', async () => {
      assertTickerColumnMatches(
        tickers,
        NON_FOF_TICKERS,
        'Characteristics tab — FoF symbols excluded; all other tickers must appear',
      );
    });

    await test.step('No empty cells in the table body', async () => {
      await pt.assertNoEmptyCells();
    });

    await test.step('"Data as of" equals previous U.S. working day (ET)', async () => {
      const asOf = await pt.readPrimaryAsOfUsDate();
      assertUsMdyMatchesExpected(asOf, expectedAsOf.productTable.characteristicsUi(), 'Product Table → Characteristics (UI)');
    });
  });

  test('3. Characteristics — CSV matches screen; FoF excluded; as-of is previous U.S. working day', async ({ page }) => {
    await test.step('Open Product Table → Characteristics', async () => {
      const pt = new ProductTablePage(page);
      await pt.goto();
      await pt.openTab('Characteristics');
    });
    const pt = new ProductTablePage(page);

    const uiAsOf = await test.step('Read "Data as of" on the page (before download)', async () => {
      return pt.readPrimaryAsOfUsDate();
    });

    const parsed = await test.step('Download CSV and parse columns', async () => {
      const path = await pt.downloadTableCsv();
      return parseCharacteristicsCsvDownload(path);
    });

    await test.step('CSV "As of date" matches the on-screen date', async () => {
      expect(
        parsed.asOfDate,
        'The first column of the file (As of date) should match the "Data as of" you see on the page before downloading. Mismatch means the export is out of sync with the UI.',
      ).toBe(uiAsOf);
    });

    await test.step('CSV "As of date" matches expected as-of behavior', async () => {
      assertUsMdyMatchesExpected(
        parsed.asOfDate,
        expectedAsOf.productTable.characteristicsCsv(),
        'Product Table → Characteristics (CSV)',
        'csv',
      );
    });

    await test.step('CSV tickers: no FoF; same set as non-FoF list', async () => {
      for (const f of TICKERS_FOF) {
        expect(
          parsed.tickers,
          `CSV must not include FoF ticker ${f} (Characteristic download excludes these).`,
        ).not.toContain(f);
      }
      assertTickerColumnMatches(
        parsed.tickers,
        NON_FOF_TICKERS,
        'CSV Ticker column (from Ticker_Start Date before the underscore) must match the non-FoF set',
      );
    });
  });

  test('4. Performance — all tickers; no blank cells; as-of last day of prior month (ET)', async ({ page }) => {
    await test.step('Open Product Table → Performance', async () => {
      const pt = new ProductTablePage(page);
      await pt.goto();
      await pt.openTab('Performance');
    });

    const pt = new ProductTablePage(page);

    await test.step('Ticker column lists every expected ETF symbol', async () => {
      const tickers = await pt.collectTickerSymbols();
      assertTickerColumnMatches(
        tickers,
        ALL_TICKERS,
        'Performance tab — all products should be listed',
      );
    });

    await test.step('No empty cells in the table body', async () => {
      await pt.assertNoEmptyCells();
    });

    await test.step('"Data as of" is the last day of the previous month (ET month)', async () => {
      const asOf = await pt.readVisibleAsOfUsDate();
      assertUsMdyMatchesExpected(asOf, expectedAsOf.productTable.performanceUi(), 'Product Table → Performance (UI)');
    });
  });

  test('5. Documents — all tickers in Ticker column', async ({ page }) => {
    await test.step('Open Product Table → Documents', async () => {
      const pt = new ProductTablePage(page);
      await pt.goto();
      await pt.openTab('Documents');
    });
    const pt = new ProductTablePage(page);

    await test.step('Ticker column lists every expected ETF symbol', async () => {
      const tickers = await pt.collectTickerSymbols();
      assertTickerColumnMatches(tickers, ALL_TICKERS, 'Documents tab — ticker list should match full product universe');
    });
  });

  test('6. Filters + Clear filters — random filters change results and restore baseline', async ({ page }, testInfo) => {
    testInfo.setTimeout(120_000);
    const pt = new ProductTablePage(page);
    await pt.goto();
    await pt.expandFiltersIfCollapsed();

    const baseline = await pt.collectTickerSymbols();
    expect(baseline.length, 'baseline table should have rows').toBeGreaterThan(0);

    const seed = Number(process.env.SMOKE_SEED ?? Date.now());
    const rng = mulberry32(seed + testInfo.workerIndex);

    // Use a stable allowlist rather than trying to "discover" checkbox names (not reliable on this site).
    const allowlist = [
      // Protection Type
      'Buffer5',
      'Buffer10',
      'Buffer15',
      'Buffer20',
      'Buffer100',
      'Floor5',
      // Upside Opportunity
      'Capped',
      'Uncapped',
      // Outcome Period
      '3 months',
      '6 months',
      '12 months',
      // Series
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ];

    const available: string[] = [];
    for (const f of allowlist) {
      if (await pt.filterCheckboxExists(f)) available.push(f);
    }
    expect(available.length, 'should have some filter checkboxes available').toBeGreaterThan(5);

    let picked: string[] = [];
    let filtered: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt++) {
      const pickCount = Math.min(3, Math.max(1, Math.floor(rng() * 3) + 1));
      picked = pickRandomSubset(available, pickCount, rng);

      await test.step(`Apply random filters (seed=${seed}) attempt ${attempt}: ${picked.join(', ')}`, async () => {
        for (const f of picked) await pt.applyFilterCheckboxByName(new RegExp(`^${escapeRegExp(f)}$`, 'i'));
      });

      filtered = await pt.collectTickerSymbols();
      if (filtered.length > 0 && filtered.join(',') !== baseline.join(',')) break;

      // If we filtered down to 0 rows (or no change), reset and try another random combo.
      await pt.clearFilters();
    }

    expect(filtered.length, `filtered table should still have rows (picked: ${picked.join(', ')})`).toBeGreaterThan(0);
    expect(filtered.join(','), 'filters should change the result set').not.toBe(baseline.join(','));

    await test.step('Clear filters restores baseline', async () => {
      await pt.clearFilters();
    });

    const restored = await pt.collectTickerSymbols();
    expect(restored.join(','), 'clear filters should restore the baseline set').toBe(baseline.join(','));
  });

  test('7. Sorting — random column random asc/desc changes visible order', async ({ page }, testInfo) => {
    const pt = new ProductTablePage(page);
    await pt.goto();
    await pt.openTab('Overview & Fees');

    const before = await pt.readFirstNTickers(10);
    expect(before.length, 'should have tickers before sorting').toBeGreaterThan(0);

    const seed = Number(process.env.SMOKE_SEED ?? Date.now());
    const rng = mulberry32(seed + 1000 + testInfo.workerIndex);

    const sortable = await pt.listSortableColumnNames();
    // Prefer columns that are likely to reorder rows.
    const candidates = sortable.filter((n) => !/Fact Sheet/i.test(n));
    expect(candidates.length, 'should find sortable column headers').toBeGreaterThan(0);
    const col = candidates[Math.floor(rng() * candidates.length)]!;

    const wantDesc = rng() < 0.5;
    await test.step(`Sort random column (seed=${seed}): ${col} → ${wantDesc ? 'desc' : 'asc'}`, async () => {
      // 1 click = some direction, 2 clicks = the opposite. We don't rely on aria-sort being present.
      const clicks = wantDesc ? 2 : 1;
      for (let i = 0; i < clicks; i++) await pt.sortByColumn(new RegExp(`^${escapeRegExp(col)}$`, 'i'));
    });

    const after = await pt.readFirstNTickers(10);
    expect(after.length, 'should have tickers after sorting').toBeGreaterThan(0);
    expect(after.join(','), 'sorting should change visible order').not.toBe(before.join(','));
  });
});

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function pickRandomSubset<T>(arr: T[], count: number, rng: () => number): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, count);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
