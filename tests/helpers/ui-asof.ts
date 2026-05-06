import type { Locator } from '@playwright/test';

/**
 * Reads the first visible "Data as of M/D/YYYY" label within the provided scope and returns the date.
 *
 * The DOM can contain multiple stamps (including hidden duplicates), so this intentionally:
 * - iterates all matching nodes
 * - filters by visibility
 * - extracts the first US date token found
 *
 * @throws if no visible "Data as of" label can be found in the scope.
 */
export async function readVisibleDataAsOfUsMdy(scope: Locator): Promise<string> {
  const candidates = scope.getByText(/Data as of\s+\d{1,2}\/\d{1,2}\/\d{4}/i);
  const n = await candidates.count();
  for (let i = 0; i < n; i++) {
    const c = candidates.nth(i);
    if (!(await c.isVisible().catch(() => false))) continue;
    const raw =
      ((await c.evaluate((el) => el.parentElement?.innerText ?? el.textContent ?? '')) ?? '')
        .trim()
        .replace(/\s+/g, ' ');
    const m = raw.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
    if (!m) continue;
    const month = Number(m[1]);
    const day = Number(m[2]);
    const year = Number(m[3]);
    return `${month}/${day}/${year}`;
  }

  throw new Error('could not find a visible "Data as of MM/DD/YYYY" label');
}

