import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { readVisibleDataAsOfUsMdy } from '../helpers/ui-asof';
import { assertNoEmptyTbodyCells } from '../helpers/table-asserts';
import { normalizeUsMdy } from '../helpers/dates';

/**
 * Tabs available on the "Product Table" page.
 *
 * Note: the strings match the tab accessible names used by Playwright selectors.
 */
export type ProductTableTab = 'Overview & Fees' | 'Characteristics' | 'Performance' | 'Documents';

/**
 * Page Object for the "Product Table" page.
 *
 * Responsibilities:
 * - navigate to the page and wait for the main table to become interactable
 * - switch tabs and extract as-of dates
 * - validate table content (e.g. empty cells)
 * - interact with the filter sidebar (checkbox-driven)
 */
export class ProductTablePage {
  /** Root table element for the active tab. */
  readonly mainTable: Locator;
  /** Visible tabpanel that contains the active table. */
  readonly activeTabpanel: Locator;
  /** Best-effort cookie/banner dismiss link (can intermittently appear). */
  readonly cookieDismiss: Locator;
  /** Button that clears all active filters (only visible when filters are applied). */
  readonly clearFiltersButton: Locator;
  /** Accordion toggle for expanding/collapsing the filter sidebar. */
  readonly filtersAccordionToggle: Locator;

  /**
   * Creates a page object bound to the provided Playwright `Page`.
   *
   * Locators are intentionally broad and resolved at runtime to tolerate minor layout changes.
   */
  constructor(readonly page: Page) {
    this.activeTabpanel = page.getByRole('tabpanel').filter({ visible: true }).first();
    // Scope the table lookup to the active tabpanel to avoid accidentally selecting unrelated tables.
    this.mainTable = this.activeTabpanel.getByRole('table').first();
    this.cookieDismiss = page.getByRole('link', { name: /dismiss/i }).first();
    this.clearFiltersButton = page.getByRole('button', { name: /Clear filters/i }).first();
    this.filtersAccordionToggle = page.getByText(/Filter:\s*/i).first();
  }

  /**
   * Waits until the table appears to have refreshed after an interaction.
   *
   * We avoid relying on "visibility" alone, since the table can remain visible while data updates.
   * A refresh is considered to have happened when either:
   * - row count changes, or
   * - the first N ticker symbols change
   */
  private async waitForTableRefresh(after: { beforeRowCount: number; beforeTickerSig: string }): Promise<void> {
    await expect
      .poll(async () => {
        const rowCount = await this.mainTable.locator('tbody tr').count().catch(() => 0);
        const tickerSig = (await this.readFirstNTickers(10).catch(() => [])).join(',');
        return rowCount !== after.beforeRowCount || tickerSig !== after.beforeTickerSig;
      }, { timeout: 60_000 })
      .toBe(true);
  }

  /**
   * Dismisses the cookie banner if it is visible.
   *
   * The banner can intercept clicks, so most interactions call this defensively.
   */
  private async dismissCookieBannerIfPresent(): Promise<void> {
    // This site sometimes shows a cookie notice that can intercept clicks.
    if (await this.cookieDismiss.isVisible().catch(() => false)) {
      await this.cookieDismiss.click({ timeout: 5_000 }).catch(() => {});
    }
  }

  /**
   * Navigates to `/product-table` and waits until the table is visible.
   *
   * Includes small resilience measures for occasional aborted navigation or lazy rendering.
   */
  async goto(): Promise<void> {
    try {
      await this.page.goto('/product-table', { waitUntil: 'domcontentloaded' });
    } catch {
      // Occasionally the initial navigation can be aborted by fast redirects; retry once.
      await this.page.goto('/product-table', { waitUntil: 'domcontentloaded' });
    }
    await this.dismissCookieBannerIfPresent();
    try {
      await this.mainTable.waitFor({ state: 'visible', timeout: 60_000 });
    } catch {
      // The table is sometimes lazy-rendered / slow to appear; a scroll nudge helps.
      await this.page.evaluate(() => window.scrollTo(0, Math.floor(document.body.scrollHeight / 2))).catch(() => {});
      await this.dismissCookieBannerIfPresent();
      await this.mainTable.waitFor({ state: 'visible', timeout: 60_000 });
    }
  }

  /**
   * Opens the specified tab and waits for the table to re-render.
   *
   * Callers typically use this before reading "as of" stamps or validating cells.
   *
   * Before a **tab change** (actual click), waits **3s** so the product table shell is stable and the first click
   * is less likely to be dropped (CI / Elementor timing).
   */
  async openTab(name: ProductTableTab): Promise<void> {
    const tab = this.page.getByRole('tab', { name });
    const alreadySelected = await tab.getAttribute('aria-selected').catch(() => null);
    if (String(alreadySelected).toLowerCase() === 'true') {
      await this.mainTable.waitFor({ state: 'visible', timeout: 60_000 });
      await this.dismissCookieBannerIfPresent();
      return;
    }

    await this.page.waitForTimeout(3_000);
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });
    const panelId = await tab.getAttribute('aria-controls').catch(() => null);
    if (panelId) {
      await this.page.locator(`#${panelId}`).waitFor({ state: 'visible', timeout: 60_000 });
    }
    await this.mainTable.waitFor({ state: 'visible', timeout: 60_000 });
    await this.dismissCookieBannerIfPresent();
  }

  /**
   * Opens the product table and navigates to a specific ETF fund page by ticker.
   *
   * This assumes the overview tab contains a link matching the ticker symbol.
   */
  async openFundPageFromOverviewFees(ticker: string): Promise<void> {
    await this.goto();
    await this.openTab('Overview & Fees');
    // Prefer the ticker link within the table itself to avoid matching unrelated nav/marketing links.
    await this.mainTable.getByRole('link', { name: new RegExp(`^${escapeRegExp(ticker)}$`, 'i') }).first().click();
    await this.page.waitForURL(new RegExp(`/etfs/${ticker.toLowerCase()}`, 'i'), { timeout: 60_000 });
  }

  /** Ticker symbols from the sticky first column (`th[scope="row"]`). */
  async collectTickerSymbols(): Promise<string[]> {
    await this.dismissCookieBannerIfPresent();
    return await this.mainTable.evaluate((tbl) => {
      const normalize = (s: string) => s.replace(/\u00a0/g, ' ').trim();
      const out: string[] = [];
      const rows = Array.from(tbl.querySelectorAll('tbody tr'));
      for (const row of rows) {
        const th = row.querySelector('th[scope="row"]');
        const text = normalize(th?.textContent ?? '');
        const symbol = (text.split(/\s+/)[0] ?? '').trim();
        out.push(symbol);
      }
      return out;
    });
  }

  /**
   * Asserts that the current table has no visually-empty cells in its `<tbody>`.
   *
   * Some products can legitimately omit values in known rows; those can be excluded via `skipRowTickers`.
   */
  async assertNoEmptyCells(opts?: { skipRowTickers?: readonly string[] }): Promise<void> {
    const skip = new Set((opts?.skipRowTickers ?? []).map((t) => t.toUpperCase()));
    await assertNoEmptyTbodyCells(this.mainTable, {
      context: 'Product Table: no empty cells in <tbody>',
      rowKeyCss: 'th[scope="row"]',
      rowKeyExtractor: 'first_token',
      skipRowKeys: skip,
    });
  }

  /**
   * Picks the first visible "Data as of … M/D/YYYY …" label (tabs may leave non-visible duplicates in the DOM).
   *
   * This delegates to a shared helper so Fund Page and Product Table stay consistent.
   */
  async readVisibleAsOfUsDate(): Promise<string> {
    return await readVisibleDataAsOfUsMdy(this.page.locator('body'));
  }

  /** Overview/Characteristics sometimes split text nodes; fall back to `innerText()` (generally excludes hidden subtrees). */
  async readPrimaryAsOfUsDate(): Promise<string> {
    try {
      return await this.readVisibleAsOfUsDate();
    } catch {
      const viewportText = await this.page.locator('body').innerText();
      const m = viewportText.match(/Data as of\s+(\d{1,2}\/\d{1,2}\/\d{4})/);
      expect(m, 'could not find Data as of M/D/YYYY in visible body text').toBeTruthy();
      return normalizeUsMdy(m![1]);
    }
  }

  /**
   * Clicks "Download table data (CSV)" and returns the temp path Playwright saved.
   *
   * This returns a local temp file path, not the original URL.
   */
  async downloadTableCsv(): Promise<string> {
    await this.dismissCookieBannerIfPresent();
    const link = this.page.getByRole('link', { name: /Download table data \(CSV\)/i });
    await link.scrollIntoViewIfNeeded().catch(() => {});
    const [download] = await Promise.all([
      this.page.waitForEvent('download'),
      link.click(),
    ]);
    const path = await download.path();
    expect(path, 'The browser should save the CSV to a temp file. If this fails, check the download link.').toBeTruthy();
    return path!;
  }

  /**
   * Clears all applied filters if the UI indicates any are active.
   *
   * When no filters are active the "Clear filters" button may not be visible.
   */
  async clearFilters(): Promise<void> {
    await this.dismissCookieBannerIfPresent();
    if (await this.clearFiltersButton.isVisible().catch(() => false)) {
      await this.clearFiltersButton.click();
      await this.mainTable.waitFor({ state: 'visible', timeout: 60_000 });
      // "Clear filters" can restore the same visible order/count depending on dataset.
      // The test suite asserts the restored baseline explicitly, so we only need to wait for stability.
      await this.dismissCookieBannerIfPresent();
    }
  }

  /**
   * Ensures the filter sidebar is expanded and at least one checkbox is visible.
   *
   * Some pages render the filter controls lazily; this method waits for them.
   */
  async expandFiltersIfCollapsed(): Promise<void> {
    await this.dismissCookieBannerIfPresent();
    // The filters live inside an accordion; if it's collapsed, checkboxes won't be in the tree.
    const anyCheckbox = this.page.getByRole('checkbox').first();
    if (!(await anyCheckbox.isVisible().catch(() => false))) {
      if (await this.filtersAccordionToggle.isVisible().catch(() => false)) {
        await this.filtersAccordionToggle.click().catch(() => {});
      }
    }
    // Wait for at least one checkbox to appear (the sidebar loads async).
    await this.page
      .getByRole('checkbox')
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 });
  }

  /**
   * Product Table filters are rendered as checkboxes. This clicks the checkbox with a matching accessible name.
   * (We intentionally avoid `getByText` because it can match unrelated nav/marketing links.)
   */
  async applyFilterCheckboxByName(label: string | RegExp): Promise<void> {
    await this.dismissCookieBannerIfPresent();
    await this.expandFiltersIfCollapsed();
    const cb = this.page.getByRole('checkbox', { name: label }).first();
    await cb.scrollIntoViewIfNeeded().catch(() => {});
    await cb.click({ timeout: 15_000 });
    await expect(cb).toBeChecked({ timeout: 15_000 });
    await this.mainTable.waitFor({ state: 'visible', timeout: 60_000 });
  }

  /** Returns visible filter checkbox labels (accessible names). */
  async listVisibleFilterCheckboxNames(): Promise<string[]> {
    // This site's filter checkbox accessible names are inconsistent under load.
    // Prefer a static allowlist in tests instead of relying on discovery here.
    await this.dismissCookieBannerIfPresent();
    await this.expandFiltersIfCollapsed();

    const checks = this.page.getByRole('checkbox');
    const n = await checks.count();
    const labels: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = checks.nth(i);
      if (!(await c.isVisible().catch(() => false))) continue;
      const aria = ((await c.getAttribute('aria-label').catch(() => null)) ?? '').trim().replace(/\s+/g, ' ');
      if (aria) labels.push(aria);
    }
    return Array.from(new Set(labels)).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Returns whether a filter checkbox with the given label exists.
   *
   * This assumes the filter sidebar is already expanded once in the test, to avoid flakiness.
   */
  async filterCheckboxExists(name: string): Promise<boolean> {
    await this.dismissCookieBannerIfPresent();
    // Assumes `expandFiltersIfCollapsed()` was called by the test once.
    return await this.page.getByRole('checkbox', { name: new RegExp(`^${escapeRegExp(name)}$`, 'i') }).count().then((c) => c > 0).catch(() => false);
  }

  /** Clicks a sortable column header button (e.g. "Ticker", "NAV"). */
  async sortByColumn(columnName: string | RegExp): Promise<void> {
    await this.dismissCookieBannerIfPresent();
    const headerBtn = this.mainTable.getByRole('button', { name: columnName }).first();
    const beforeRowCount = await this.mainTable.locator('tbody tr').count().catch(() => 0);
    const beforeTickerSig = (await this.readFirstNTickers(10).catch(() => [])).join(',');
    await headerBtn.scrollIntoViewIfNeeded().catch(() => {});
    await headerBtn.click();
    await this.mainTable.waitFor({ state: 'visible', timeout: 60_000 });
    await this.waitForTableRefresh({ beforeRowCount, beforeTickerSig });
  }

  /**
   * Returns the visible column header button texts for the current table.
   *
   * Useful for smoke assertions when a tab changes available sortable columns.
   */
  async listSortableColumnNames(): Promise<string[]> {
    await this.dismissCookieBannerIfPresent();
    const btns = this.mainTable.getByRole('button');
    const n = await btns.count();
    const out: string[] = [];
    for (let i = 0; i < n; i++) {
      const b = btns.nth(i);
      if (!(await b.isVisible().catch(() => false))) continue;
      const t = ((await b.innerText().catch(() => '')) ?? '').trim().replace(/\s+/g, ' ');
      if (!t) continue;
      out.push(t);
    }
    return Array.from(new Set(out));
  }

  /**
   * Convenience helper for reading the first N ticker symbols currently shown.
   *
   * This does not change pagination/infinite scroll; it only reads what's already rendered.
   */
  async readFirstNTickers(n: number): Promise<string[]> {
    const tickers = await this.collectTickerSymbols();
    return tickers.slice(0, n);
  }
}

/** Escapes a string so it can be safely embedded into a RegExp pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

