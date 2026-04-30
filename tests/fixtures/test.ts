import { test as base, expect, type Page, type TestInfo } from '@playwright/test';

export { expect };

export const test = base.extend({});

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

test.afterEach(async ({ page }, testInfo) => {
  await attachFailureFullPageScreenshot(page, testInfo);
});

