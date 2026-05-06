import { test, expect } from './fixtures/test';
import { FUND_PAGE_STRATEGIES, pickRandomTicker } from './fixtures/fund-page-samples';
import { FundPage } from './po/fund-page.po';
import { ProductTablePage } from './po/product-table.po';

/**
 * Smoke tests for ETF "Fund" pages.
 *
 * Each strategy test picks a random ticker from a pool and validates:
 * - sidebar sections contain non-empty values
 * - date stamps follow expected ET business rules
 * - tables do not contain blank cells
 * - CSV export contains at least one expected date row (where applicable)
 */
test.describe('Fund page @smoke', () => {
  test.describe.configure({ timeout: 180_000 });

  for (const def of FUND_PAGE_STRATEGIES) {
    /**
     * Strategy-driven fund page checks.
     *
     * The ticker is sampled randomly on each test run (including retries), so failures
     * can be intermittent across products within the same strategy pool.
     */
    test(`${def.strategy}: fund page checks`, async ({ page }) => {
      const t = pickRandomTicker(def.pool);
      const hasOutcome = def.hasOutcomePeriodTab;
      const pt = new ProductTablePage(page);
      const fund = new FundPage(page);

      await test.step(`Ticker for this run: ${t} (random from ${def.pool.length} ${def.strategy} symbol(s))`, async () => {});

      await test.step('Open fund from Product Table (Overview & Fees → Ticker link)', async () => {
        await pt.openFundPageFromOverviewFees(t);
        await expect(page).toHaveURL(new RegExp(`/etfs/${t.toLowerCase()}`, 'i'));
      });

      await test.step('1. ETF Details — section present, all value fields filled', async () => {
        await fund.assertSidebarValuesFilled('ETF Details');
      });

      await test.step('2. ETF Market Data — values + two “As of” dates = previous U.S. working day', async () => {
        await fund.assertSidebarValuesFilled('ETF Market Data');
        await fund.assertTwoAsOfDatesArePreviousWorkingDay();
      });

      if (hasOutcome) {
        await test.step("3. Outcome period details — chart + table dates; no empty data cells", async () => {
          await fund.clickTab('Outcome period details');
          await fund.assertOutcomePeriodDateSignals();
          await fund.assertAllDataTablesFilled(
            fund.visibleTabpanel,
            'Outcome period details (tables under chart)',
          );
        });

        await test.step('4. Outcome period — download chart CSV; ≥1 row for previous U.S. working day', async () => {
          const p = await fund.downloadOutcomeChartCsv();
          fund.assertOutcomeChartCsvHasRowForPreviousWorkingDay(p);
        });
      } else {
        await test.step('3–4. Outcome period details / chart CSV — not applicable (FoF has no tab)', async () => {
          await fund.assertTabAbsent('Outcome period details');
        });
      }

      await test.step('5. Holdings — “As of” previous U.S. working day; holdings tables filled', async () => {
        await fund.assertHoldingsTab(t);
      });

      await test.step('6. Performance — prior month-end as-of in view; tables filled', async () => {
        await fund.assertPerformanceTab(t);
      });

      await test.step('7. Overview — visible content; no obvious error page', async () => {
        await fund.assertOverviewOrDocumentsTab('Overview');
      });

      await test.step('8. Documents — visible content; no obvious error page', async () => {
        await fund.assertOverviewOrDocumentsTab('Documents');
      });
    });
  }
});
