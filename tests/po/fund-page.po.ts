import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import fs from 'node:fs';
import {
  assertUsMdyMatchesExpected,
  expectedAsOf,
  normalizeUsMdy,
  previousWorkingDayET_usMdy,
  previousWorkingDayET_usMdy_n,
  todayET_usMdy,
} from '../helpers/dates';
import { PERFORMANCE_SKIP_TICKERS, TICKERS_FOF } from '../fixtures/tickers';
import { splitCsvLine } from '../helpers/characteristics-csv';
import { readVisibleDataAsOfUsMdy } from '../helpers/ui-asof';
import { assertNoEmptyTbodyCells } from '../helpers/table-asserts';
import { DateTime } from 'luxon';

/** IANA timezone identifier used for "ET" expectations in tests. */
const NY_TZ = 'America/New_York';

/** Escapes a string for use inside a `RegExp` source (exact-match tab labels). */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Returns whether it is currently Saturday/Sunday in New York time.
 *
 * Used to widen expected date matching for exports that may lag over the weekend.
 */
function isWeekendET(): boolean {
  const now = DateTime.now().setZone(NY_TZ);
  return now.weekday === 6 || now.weekday === 7;
}

/**
 * Tabs available on the Fund page.
 *
 * Note: strings are matched against tab accessible names (case-insensitive).
 */
export type FundTab =
  | 'Outcome period details'
  | 'Holdings'
  | 'Performance'
  | 'Overview'
  | 'Documents';

/**
 * Page Object for an ETF "Fund" detail page.
 *
 * Responsibilities:
 * - switch between fund tabs and wait for the active panel
 * - validate “as of”/“data from” date stamps against expected business rules
 * - validate that tables contain filled cells
 * - download and validate CSV exports (chart/table)
 */
export class FundPage {
  /** Creates a page object bound to the provided Playwright `Page`. */
  constructor(readonly page: Page) {}

  /**
   * Reads the first visible "Data as of M/D/YYYY" label within a panel and returns the date.
   *
   * We explicitly check visibility because the DOM can contain stale stamps from other tabs/panels.
   */
  private async readPanelDataAsOfUsDate(panel: Locator): Promise<string> {
    const usMdy = await readVisibleDataAsOfUsMdy(panel);
    return normalizeUsMdy(usMdy);
  }

  /**
   * Returns the sidebar section locator for the given title.
   *
   * Sidebar sections appear as `.page-sidebar__section` blocks with a heading.
   */
  sidebarSection(title: 'ETF Details' | 'ETF Market Data'): Locator {
    return this.page
      .locator('.page-sidebar__section')
      .filter({ has: this.page.getByRole('heading', { name: new RegExp(`^${title}$`, 'i') }) });
  }

  /**
   * Asserts that all values in the requested sidebar section are non-empty.
   *
   * This validates that data tiles rendered and are not missing/blank.
   */
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

  /**
   * Exact accessible-name match for a fund tab (case-insensitive).
   *
   * Using `^…$` avoids matching a shorter tab label that is a substring of another.
   */
  private tabAccessibleNamePattern(name: FundTab): RegExp {
    return new RegExp(`^${escapeRegExp(name)}$`, 'i');
  }

  /**
   * Locator for the tabpanel whose accessible name matches the fund tab label.
   *
   * Prefer this (with {@link clickTab}) over “first visible tabpanel”, which can resolve to the wrong panel
   * if the UI did not finish switching tabs.
   */
  tabPanelFor(name: FundTab): Locator {
    return this.page.getByRole('tabpanel', { name: this.tabAccessibleNamePattern(name) });
  }

  /**
   * Locator for the in-tab title the site shows when that section is active (user-visible proof of tab switch).
   *
   * Prefer this over `toBeVisible` on Elementor `aria-controls` wrappers, which can stay `hidden` while the tab
   * is already `aria-selected`. Uses flexible text/regex (whitespace, `&` vs entity) and `h2` / `span` as on prod.
   * Holdings: FoF pages may omit `h2.tab__title`; a `heading` role fallback matches the same visible title.
   */
  private tabContentMarker(name: FundTab): Locator {
    switch (name) {
      case 'Outcome period details':
        return this.page
          .locator('span.opd-title__text')
          .filter({ hasText: /Outcome\s+Period\s+Details/i });
      case 'Overview':
        return this.page.locator('h2.tab__title').filter({ hasText: /^\s*ETF Summary\s*$/i });
      case 'Performance':
        return this.page
          .locator('h2.tab__title')
          .filter({ hasText: /ETF Performance\s*[&＆]?\s*Index History/i });
      case 'Holdings':
        // Non-FoF uses `h2.tab__title`; FoF holdings can use a plain heading without that class.
        return this.page
          .locator('h2.tab__title')
          .filter({ hasText: /^\s*Holdings\s*$/i })
          .or(this.page.getByRole('heading', { name: /^\s*Holdings\s*$/i }));
      case 'Documents':
        return this.page.locator('h2.tab__title').filter({ hasText: /^\s*Documents\s*$/i });
    }
  }

  /**
   * After the tab is selected, waits for that tab’s section title and returns a `tabpanel` scope for assertions.
   *
   * Resolution order: tabpanel that **contains** the visible marker (best for Elementor), else role+name tabpanel.
   */
  private async resolveTabPanelAfterClick(name: FundTab): Promise<Locator> {
    const marker = this.tabContentMarker(name);
    const markerFirst = marker.first();
    await expect(markerFirst, `Tab "${name}" should show its section title`).toBeVisible({ timeout: 60_000 });

    const panelWithMarker = this.page.getByRole('tabpanel').filter({ has: markerFirst });
    if ((await panelWithMarker.count()) > 0) {
      const panel = panelWithMarker.first();
      await expect(panel, `tabpanel containing "${name}" marker`).toBeVisible({ timeout: 15_000 });
      return panel;
    }

    const byRole = this.tabPanelFor(name);
    await expect(byRole, `tabpanel for "${name}" (by accessible name)`).toBeVisible({ timeout: 15_000 });
    return byRole;
  }

  /**
   * Clicks a fund tab, asserts it is selected, and waits for that tab’s panel — not merely “some” visible panel.
   *
   * Waits **3s** after the current view has settled before clicking, so Elementor / async tab strips are less likely
   * to ignore the first click (CI flake mitigation).
   *
   * @returns Locator scoped to the tabpanel for `name` once selection is confirmed.
   */
  async clickTab(name: FundTab): Promise<Locator> {
    await this.page.waitForTimeout(3_000);
    const tab = this.page.getByRole('tab', { name: this.tabAccessibleNamePattern(name) });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
    return await this.resolveTabPanelAfterClick(name);
  }

  /** Asserts that the given tab does not exist for the current product. */
  async assertTabAbsent(name: FundTab): Promise<void> {
    await expect(this.page.getByRole('tab', { name: this.tabAccessibleNamePattern(name) })).toHaveCount(0);
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

  /**
   * Asserts that a table's `<tbody>` has no empty `th`/`td` cell content.
   *
   * This normalizes NBSP to spaces before trimming.
   */
  private async assertTableBodyHasNoEmptyCells(table: Locator): Promise<void> {
    await assertNoEmptyTbodyCells(table, { context: 'Fund page table: no empty cells in <tbody>' });
  }

  /**
   * Outcome tab: asserts that the “Data from …” stamp matches the expected as-of behavior.
   *
   * @param panel — Must be the Outcome tab’s panel (e.g. return value of {@link clickTab}(`'Outcome period details'`)).
   */
  async assertOutcomePeriodDateSignals(panel: Locator): Promise<void> {
    const text = await panel.innerText();

    const dataFrom = text.match(/Data from (\d{1,2}\/\d{1,2}\/\d{4})/i);
    expect(dataFrom, 'Outcome tab: expected copy "Data from M/D/YYYY" for chart data').toBeTruthy();
    assertUsMdyMatchesExpected(
      normalizeUsMdy(dataFrom![1]),
      expectedAsOf.fund.outcomeUi(),
      'Fund page → Outcome period details (Data from …)',
    );
  }

  /**
   * Clicks the "Download chart data (CSV)" link and returns the local temp file path.
   *
   * @param panel — Active Outcome tabpanel scope (same as used for {@link assertOutcomePeriodDateSignals}).
   * The caller is responsible for reading and deleting the temp file if needed.
   */
  async downloadOutcomeChartCsv(panel: Locator): Promise<string> {
    const [download] = await Promise.all([
      this.page.waitForEvent('download'),
      panel
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
    // Around weekends the export can lag by more than one working day, so we accept a small range.
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

  /**
   * Holdings tab: validates as-of dates and that all visible tables contain data.
   *
   * The page has different UI shapes for FoF vs non-FoF tickers, so expectations differ.
   */
  async assertHoldingsTab(ticker: string): Promise<void> {
    const panel = await this.clickTab('Holdings');
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

  /**
   * Performance tab: validates as-of date (when present) and checks visible tables for blank cells.
   *
   * Some tickers are excluded due to known UI differences.
   */
  async assertPerformanceTab(ticker: string): Promise<void> {
    if (PERFORMANCE_SKIP_TICKERS.includes(ticker as (typeof PERFORMANCE_SKIP_TICKERS)[number])) return;

    const panel = await this.clickTab('Performance');
    const text = await panel.innerText();

    const asOf = text.match(/\bAs of\s+(\d{1,2}\/\d{1,2}\/\d{4})\b/i);
    if (asOf?.[1]) {
      assertUsMdyMatchesExpected(
        normalizeUsMdy(asOf[1]),
        expectedAsOf.fund.performanceUi(),
        'Fund page → Performance (UI)',
      );
    }

    await this.assertAllDataTablesFilled(panel, 'Performance tab');
  }

  /**
   * Overview/Documents tabs: asserts the tab renders meaningful text and is not an error page.
   */
  async assertOverviewOrDocumentsTab(tabName: 'Overview' | 'Documents'): Promise<void> {
    const panel = await this.clickTab(tabName);
    await expect(panel).toBeVisible();
    const text = await panel.innerText();
    expect(text.trim().length, `${tabName} tab should show meaningful content`).toBeGreaterThan(120);
    const lower = text.toLowerCase();
    expect(lower.includes('404') && lower.includes('not found')).toBe(false);
  }
}

