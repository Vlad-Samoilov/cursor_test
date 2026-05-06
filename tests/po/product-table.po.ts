import type { Locator, Page } from '@playwright/test';
import { expect } from '@playwright/test';

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
    this.mainTable = page.getByRole('table').first();
    this.cookieDismiss = page.getByRole('link', { name: /dismiss/i }).first();
    this.clearFiltersButton = page.getByRole('button', { name: /Clear filters/i }).first();
    this.filtersAccordionToggle = page.getByText(/Filter:\s*/i).first();
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
   */
  async openTab(name: ProductTableTab): Promise<void> {
    await this.page.getByRole('tab', { name }).click();
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
    await this.page.getByRole('link', { name: ticker }).first().click();
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

    const empties = await this.mainTable.evaluate(
      (tbl, skipArr) => {
        const normalize = (s: string) => s.replace(/\u00a0/g, ' ').trim();
        const out: Array<{ row: number; col: number; ticker: string; raw: string }> = [];
        const skipSet = new Set((skipArr ?? []).map((t) => String(t).toUpperCase()));

        const rows = Array.from(tbl.querySelectorAll('tbody tr'));
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          const th = row.querySelector('th[scope="row"]');
          const rowTicker = normalize((th?.textContent ?? '').split(/\s+/)[0] ?? '') || '(unknown)';
          if (skipSet.has(rowTicker.toUpperCase())) continue;

          const cells = Array.from(row.querySelectorAll('th, td'));
          for (let j = 0; j < cells.length; j++) {
            const raw = cells[j]?.textContent ?? '';
            if (normalize(raw).length === 0) {
              out.push({ row: i + 1, col: j + 1, ticker: rowTicker, raw });
            }
          }
        }

        return { rowCount: rows.length, empties: out };
      },
      Array.from(skip),
    );

    expect(empties.rowCount, 'product table should have at least one body row').toBeGreaterThan(0);
    expect(
      empties.empties.length,
      empties.empties.length === 0
        ? ''
        : [
            `Empty cell(s) in product table.`,
            `• Tab: whichever is active (Overview / Characteristics / Performance / Documents).`,
            `• First empty: row ${empties.empties[0]!.row} (${empties.empties[0]!.ticker}), column ${empties.empties[0]!.col}.`,
            `• Raw cell text: ${JSON.stringify(empties.empties[0]!.raw)}`,
            `Fix: cells should display a value, placeholder (e.g. dash), or link text — not a blank.`,
            empties.empties.length > 1 ? `• Total empty cells found: ${empties.empties.length}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
    ).toBe(0);
  }

  /**
   * Reads the visible "Data as of …" line for the active tab (only one tab shows a primary as-of label at a time).
   * Returns the first M/D/YYYY segment.
   */
  private normalizeUsMdy(m: RegExpMatchArray): string {
    const month = Number(m[1]);
    const day = Number(m[2]);
    const year = Number(m[3]);
    return `${month}/${day}/${year}`;
  }

  /** Picks the first visible "Data as of … M/D/YYYY …" label (tabs may leave non-visible duplicates in the DOM). */
  async readVisibleAsOfUsDate(): Promise<string> {
    const candidates = this.page.getByText(/Data as of\s+\d{1,2}\/\d{1,2}\/\d{4}/);
    const n = await candidates.count();
    for (let i = 0; i < n; i++) {
      const c = candidates.nth(i);
      if (!(await c.isVisible())) continue;
      const raw =
        ((await c.evaluate((el) => el.parentElement?.innerText ?? el.textContent ?? '')) ?? '')
          .trim()
          .replace(/\s+/g, ' ');
      const m = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
      if (m) return this.normalizeUsMdy(m);
    }

    throw new Error('could not find a visible "Data as of MM/DD/YYYY" label');
  }

  /** Overview/Characteristics sometimes split text nodes; fall back to `innerText()` (generally excludes hidden subtrees). */
  async readPrimaryAsOfUsDate(): Promise<string> {
    try {
      return await this.readVisibleAsOfUsDate();
    } catch {
      const viewportText = await this.page.locator('body').innerText();
      const m = viewportText.match(/Data as of\s+(\d{1,2}\/\d{1,2}\/\d{4})/);
      expect(m, 'could not find Data as of M/D/YYYY in visible body text').toBeTruthy();
      const inner = m![1].match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
      expect(inner, `could not parse US date from: ${m![1]}`).toBeTruthy();
      return this.normalizeUsMdy(inner!);
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
    await headerBtn.scrollIntoViewIfNeeded().catch(() => {});
    await headerBtn.click();
    await this.mainTable.waitFor({ state: 'visible', timeout: 60_000 });
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

