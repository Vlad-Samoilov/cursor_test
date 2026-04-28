import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import fs from 'node:fs';
import {
  assertUsMdyMatchesExpected,
  expectedAsOf,
  lastDayOfPreviousMonthET_usMdy,
  normalizeUsMdy,
  previousWorkingDayET_usMdy,
  previousWorkingDayET_usMdy_n,
  todayET_usMdy,
} from '../helpers/dates';
import { PERFORMANCE_SKIP_TICKERS, TICKERS_FOF } from '../fixtures/tickers';
import { splitCsvLine } from '../helpers/characteristics-csv';
import { DateTime } from 'luxon';

const NY_TZ = 'America/New_York';

function isWeekendET(): boolean {
  const now = DateTime.now().setZone(NY_TZ);
  return now.weekday === 6 || now.weekday === 7;
}

export type FundTab =
  | 'Outcome period details'
  | 'Holdings'
  | 'Performance'
  | 'Overview'
  | 'Documents';

export class FundPage {
  constructor(readonly page: Page) {}

  private extractUsMdyFromText(text: string): string | null {
    const m = text.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
    return m?.[1] ? normalizeUsMdy(m[1]) : null;
  }

  private async readPanelDataAsOfUsDate(panel: Locator): Promise<string> {
    const candidates = panel.getByText(/Data as of\s+\d{1,2}\/\d{1,2}\/\d{4}/i);
    const n = await candidates.count();
    for (let i = 0; i < n; i++) {
      const c = candidates.nth(i);
      if (!(await c.isVisible().catch(() => false))) continue;
      const raw = ((await c.evaluate((el) => el.parentElement?.innerText ?? el.textContent ?? '')) ?? '')
        .trim()
        .replace(/\s+/g, ' ');
      const parsed = this.extractUsMdyFromText(raw);
      if (parsed) return parsed;
    }
    throw new Error('could not find a visible "Data as of MM/DD/YYYY" label in the active panel');
  }

  sidebarSection(title: 'ETF Details' | 'ETF Market Data'): Locator {
    return this.page
      .locator('.page-sidebar__section')
      .filter({ has: this.page.getByRole('heading', { name: new RegExp(`^${title}$`, 'i') }) });
  }

  async assertSidebarValuesFilled(title: 'ETF Details' | 'ETF Market Data'): Promise<void> {
    const section = this.sidebarSection(title);
    await expect(section, `${title}: section should be visible`).toBeVisible();
    const vals = section.locator('.page-sidebar__value');
    const n = await vals.count();
    expect(n, `${title}: expected at least one .page-sidebar__value`).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const raw = await vals.nth(i).innerText();
      expect(
        raw.trim().length > 0,
        `${title}: empty value cell #${i + 1}. Raw: ${JSON.stringify(raw)}`,
      ).toBeTruthy();
    }
  }

  /** “As of M/D/YYYY” lines in ETF Market Data (typically NAV + Closing price). */
  async assertTwoAsOfDatesArePreviousWorkingDay(): Promise<void> {
    const section = this.sidebarSection('ETF Market Data');
    const text = await section.innerText();
    const matches = [...text.matchAll(/As of (\d{1,2}\/\d{1,2}\/\d{4})/gi)].map((m) =>
      normalizeUsMdy(m[1]!),
    );
    expect(matches.length, `ETF Market Data: expected at least two "As of M/D/YYYY" lines`).toBeGreaterThanOrEqual(2);
    const expected = expectedAsOf.fund.etfMarketDataUi();
    for (const d of matches) {
      assertUsMdyMatchesExpected(d, expected, 'Fund page → ETF Market Data (UI)');
    }
  }

  async clickTab(name: FundTab): Promise<void> {
    await this.page.getByRole('tab', { name: new RegExp(name, 'i') }).click();
    await this.visibleTabpanel.waitFor({ state: 'visible', timeout: 60_000 });
  }

  async assertTabAbsent(name: FundTab): Promise<void> {
    await expect(this.page.getByRole('tab', { name: new RegExp(name, 'i') })).toHaveCount(0);
  }

  get visibleTabpanel(): Locator {
    return this.page.getByRole('tabpanel').filter({ visible: true }).first();
  }

  /** All HTML tables under a scope that have `<tbody>` rows — no blank body cells. */
  async assertAllDataTablesFilled(scope: Locator, context: string): Promise<void> {
    const tables = scope.locator('table');
    const tn = await tables.count();
    expect(tn > 0, `${context}: expected at least one table`).toBeTruthy();
    for (let i = 0; i < tn; i++) {
      const tb = tables.nth(i);
      if ((await tb.locator('tbody tr').count()) === 0) continue;
      await this.assertTableBodyHasNoEmptyCells(tb);
    }
  }

  private async assertTableBodyHasNoEmptyCells(table: Locator): Promise<void> {
    const empties = await table.evaluate((tbl) => {
      const normalize = (s: string) => s.replace(/\u00a0/g, ' ').trim();
      const out: Array<{ row: number; col: number; raw: string }> = [];
      const rows = Array.from(tbl.querySelectorAll('tbody tr'));
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        const cells = Array.from(row.querySelectorAll('th, td'));
        for (let j = 0; j < cells.length; j++) {
          const raw = cells[j]?.textContent ?? '';
          if (normalize(raw).length === 0) out.push({ row: i + 1, col: j + 1, raw });
        }
      }
      return { rowCount: rows.length, empties: out };
    });

    expect(empties.rowCount, 'fund page table should have at least one body row').toBeGreaterThan(0);
    expect(
      empties.empties.length,
      empties.empties.length === 0
        ? ''
        : [
            `Empty cell(s) in fund page table.`,
            `• First empty: row ${empties.empties[0]!.row}, column ${empties.empties[0]!.col}.`,
            `• Raw cell text: ${JSON.stringify(empties.empties[0]!.raw)}`,
          ].join('\n'),
    ).toBe(0);
  }

  /**
   * Outcome tab: “Data from …” stamp matches expected as-of behavior.
   */
  async assertOutcomePeriodDateSignals(): Promise<void> {
    const panel = this.visibleTabpanel;
    const text = await panel.innerText();

    const dataFrom = text.match(/Data from (\d{1,2}\/\d{1,2}\/\d{4})/i);
    expect(dataFrom, 'Outcome tab: expected copy "Data from M/D/YYYY" for chart data').toBeTruthy();
    assertUsMdyMatchesExpected(
      normalizeUsMdy(dataFrom![1]),
      expectedAsOf.fund.outcomeUi(),
      'Fund page → Outcome period details (Data from …)',
    );
  }

  private extractFirstDateFromText(text: string): string | null {
    const us = text.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
    if (us?.[1]) return normalizeUsMdy(us[1]);

    // Highcharts accessibility labels often look like: "Tuesday, Apr 21, 2026, …"
    const named = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),\s+(\d{4})\b/);
    if (named) {
      const mon = named[1];
      const day = Number(named[2]);
      const year = Number(named[3]);
      const monthMap: Record<string, number> = {
        Jan: 1,
        Feb: 2,
        Mar: 3,
        Apr: 4,
        May: 5,
        Jun: 6,
        Jul: 7,
        Aug: 8,
        Sep: 9,
        Oct: 10,
        Nov: 11,
        Dec: 12,
      };
      const m = monthMap[mon];
      if (m) return `${m}/${day}/${year}`;
    }

    const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
    if (iso) {
      const y = Number(iso[1]);
      const m = Number(iso[2]);
      const d = Number(iso[3]);
      return `${m}/${d}/${y}`;
    }
    return null;
  }

  async downloadOutcomeChartCsv(): Promise<string> {
    const [download] = await Promise.all([
      this.page.waitForEvent('download'),
      this.page
        .getByRole('link', { name: /Download chart data \(CSV\)/i })
        .first()
        .click(),
    ]);
    const p = await download.path();
    expect(p, 'Chart CSV should download to a temp file').toBeTruthy();
    return p!;
  }

  /** Chart CSV export — ≥1 row contains previous working day (slash or ISO date). */
  assertOutcomeChartCsvHasRowForPreviousWorkingDay(filePath: string): void {
    let raw = fs.readFileSync(filePath, 'utf-8');
    raw = raw.replace(/^\uFEFF/, '');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
    expect(lines.length > 1, 'CSV should include header + data rows').toBeTruthy();
    const needles = isWeekendET() ? [previousWorkingDayET_usMdy_n(1), previousWorkingDayET_usMdy_n(2)] : [previousWorkingDayET_usMdy_n(1)];
    const isos = needles.map((needle) => {
      const [mm, dd, yyyy] = needle.split('/').map(Number);
      return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
    });
    let hit = false;
    for (let i = 1; i < lines.length; i++) {
      const flat = splitCsvLine(lines[i]).join(',');
      for (let j = 0; j < needles.length; j++) {
        if (flat.includes(needles[j]!) || flat.includes(isos[j]!)) hit = true;
      }
    }
    expect(hit, `Outcome chart CSV: expected ≥1 data row mentioning ${needles.join(' or ')} (or ISO forms)`).toBe(true);
  }

  async assertHoldingsTab(ticker: string): Promise<void> {
    await this.clickTab('Holdings');
    const panel = this.visibleTabpanel;
    const text = await panel.innerText();

    if (TICKERS_FOF.includes(ticker as (typeof TICKERS_FOF)[number])) {
      const tableAsOf = await this.readPanelDataAsOfUsDate(panel);
      assertUsMdyMatchesExpected(
        tableAsOf,
        expectedAsOf.fund.holdingsUi(),
        'Fund page → Holdings (FoF table as-of)',
      );

      await this.assertAllDataTablesFilled(panel, 'Holdings tab (FoF) tables');

      const chartExpected = expectedAsOf.fund.holdingsFofChartStamp();
      // The FoF holdings view contains TWO "Data as of" stamps: one above the holdings table (today),
      // and another for the chart. We want the chart one — empirically it appears later in the panel.
      const stamps = panel.getByText(/Data as of\s+\d{1,2}\/\d{1,2}\/\d{4}/i);
      const sn = await stamps.count();
      expect(sn, 'Holdings tab (FoF): expected at least one "Data as of M/D/YYYY" stamp').toBeGreaterThan(0);
      const lastStamp = stamps.nth(sn - 1);
      const lastText = ((await lastStamp.innerText().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ');
      const m = lastText.match(/\b(\d{1,2}\/\d{1,2}\/\d{4})\b/);
      expect(m, `Holdings tab (FoF): could not parse US date from chart stamp: ${JSON.stringify(lastText)}`).toBeTruthy();
      assertUsMdyMatchesExpected(normalizeUsMdy(m![1]!), chartExpected, 'Fund page → Holdings (FoF chart stamp)');
      return;
    }

    const asOf = text.match(/As of (\d{1,2}\/\d{1,2}\/\d{4})/i);
    expect(asOf, 'Holdings tab: expected an "As of M/D/YYYY" near holdings').toBeTruthy();
    assertUsMdyMatchesExpected(normalizeUsMdy(asOf![1]), expectedAsOf.fund.holdingsUi(), 'Fund page → Holdings (UI)');
    await this.assertAllDataTablesFilled(panel, 'Holdings tab');
  }

  async assertPerformanceTab(ticker: string): Promise<void> {
    if (PERFORMANCE_SKIP_TICKERS.includes(ticker as (typeof PERFORMANCE_SKIP_TICKERS)[number])) return;

    await this.clickTab('Performance');
    const panel = this.visibleTabpanel;
    const text = await panel.innerText();

    const asOf = text.match(/\bAs of\s+(\d{1,2}\/\d{1,2}\/\d{4})\b/i);
    if (asOf?.[1]) {
      const expected = lastDayOfPreviousMonthET_usMdy();
      expect(
        asOf[1].trim(),
        `Performance tab: when an "As of" date is shown, it should match prior month-end ${expected}`,
      ).toBe(expected);
    }

    await this.assertAllDataTablesFilled(panel, 'Performance tab');
  }

  async assertOverviewOrDocumentsTab(tabName: 'Overview' | 'Documents'): Promise<void> {
    await this.clickTab(tabName);
    const panel = this.visibleTabpanel;
    await expect(panel).toBeVisible();
    const text = await panel.innerText();
    expect(text.trim().length, `${tabName} tab should show meaningful content`).toBeGreaterThan(120);
    const lower = text.toLowerCase();
    expect(lower.includes('404') && lower.includes('not found')).toBe(false);
  }
}

