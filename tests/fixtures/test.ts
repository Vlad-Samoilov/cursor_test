import { test as base, expect, type Page, type TestInfo } from '@playwright/test';

export { expect };

/**
 * Project-wide Playwright `test` instance with shared fixtures/hooks.
 *
 * Add cross-cutting behavior here (attachments, tracing tweaks, etc.) so individual specs stay focused.
 */
export const test = base.extend({});

/**
 * Attaches a full-page screenshot on failures.
 *
 * Playwright's default screenshot behavior is disabled in config; we attach a single full-page
 * image because it’s usually the most useful artifact for diagnosing "below the fold" issues.
 */
async function attachFailureFullPageScreenshot(page: Page, testInfo: TestInfo): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;

  // If a test fails because the issue is below the fold, a viewport screenshot isn't enough.
  const path = testInfo.outputPath('failure-fullpage.png');
  await page.screenshot({ path, fullPage: true });

  await testInfo.attach('failure-fullpage', {
    path,
    contentType: 'image/png',
  });
}

/**
 * After every test, attach diagnostic artifacts if the test failed.
 */
test.afterEach(async ({ page }, testInfo) => {
  await attachFailureFullPageScreenshot(page, testInfo);
});

