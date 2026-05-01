import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';

function requiredEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function githubRunUrl() {
  const repo = process.env.GITHUB_REPOSITORY;
  const runId = process.env.GITHUB_RUN_ID;
  if (!repo || !runId) return null;
  return `https://github.com/${repo}/actions/runs/${runId}`;
}

/** Stable page that lists downloadable ZIP artifacts (scroll to Artifacts). */
function githubArtifactsPageUrl() {
  const explicit = process.env.ARTIFACTS_PAGE_URL?.trim();
  if (explicit) return explicit;
  const run = githubRunUrl();
  return run ? `${run}#artifacts` : null;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function readOptionalText(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
}

function parsePlaywrightSummary(raw) {
  const stripAnsi = (s) =>
    // Robust ANSI stripper (covers SGR and other CSI sequences)
    // eslint-disable-next-line no-control-regex
    String(s)
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\u001B\][^\u0007]*\u0007/g, '');

  const lines = raw.split(/\r?\n/).map(stripAnsi);

  let passed = null;
  let failed = null;
  let skipped = null;
  let flaky = null;
  let duration = null;

  for (const l of lines) {
    const mPassed = l.match(/\b(\d+)\s+passed\b/i);
    const mFailed = l.match(/\b(\d+)\s+failed\b/i);
    const mSkipped = l.match(/\b(\d+)\s+skipped\b/i);
    const mFlaky = l.match(/\b(\d+)\s+flaky\b/i);
    const mDur = l.match(/\(([\d.]+[sm]|[\d.]+m)\)\s*$/i);
    if (mPassed) passed = Number(mPassed[1]);
    if (mFailed) failed = Number(mFailed[1]);
    if (mSkipped) skipped = Number(mSkipped[1]);
    if (mFlaky) flaky = Number(mFlaky[1]);
    if (mDur) duration = mDur[1];
  }

  const failures = lines
    .map((l) => {
      const m = l.match(/^\s*[xX✘×]\s+\d+\s+\[[^\]]+]\s+›\s+(.+?)\s*$/);
      if (!m?.[1]) return null;
      return m[1].replace(/\s+\(\d+(?:\.\d+)?[sm]\)\s*$/i, '').trim();
    })
    .filter(Boolean);

  const seen = new Set();
  const uniqueFailures = [];
  for (const f of failures) {
    if (seen.has(f)) continue;
    seen.add(f);
    uniqueFailures.push(f);
  }

  return { passed, failed, skipped, flaky, duration, failures: uniqueFailures };
}

/** Strip `[project] ›` prefix Playwright prints in list output. */
function stripReporterProjectPrefix(line) {
  return String(line ?? '')
    .replace(/^\s*\[[^\]]+]\s*›\s*/i, '')
    .trim();
}

/** Playwright appends a dim rule after titles in the summary epilogue. */
function stripTrailingSummaryRule(line) {
  return String(line ?? '')
    .replace(/\s*[\u2500\u2501\u2502\u2503\u254b─\-_=]{8,}\s*$/u, '')
    .trim();
}

/**
 * Titles listed after `N flaky` in the list reporter epilogue (same run order as failure blocks).
 */
function extractFlakyTestTitles(raw) {
  const stripAnsi = (s) =>
    // eslint-disable-next-line no-control-regex
    String(s)
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\u001B\][^\u0007]*\u0007/g, '');
  const lines = raw.split(/\r?\n/).map(stripAnsi);
  const idx = lines.findIndex((l) => /\b\d+\s+flaky\b/i.test(l.trim()));
  if (idx === -1) return [];

  const titles = [];
  for (let j = idx + 1; j < lines.length; j++) {
    const trimmed = lines[j]?.trim() ?? '';
    if (!trimmed) continue;
    if (
      /^\d+\s+passed\b/i.test(trimmed) ||
      /^\d+\s+failed\b/i.test(trimmed) ||
      /^\d+\s+skipped\b/i.test(trimmed) ||
      /^\d+\s+interrupted\b/i.test(trimmed) ||
      /^\d+\s+did not run\b/i.test(trimmed)
    )
      break;
    if (/^slow test file:/i.test(trimmed)) break;
    if (/^consider running tests from slow files/i.test(trimmed)) break;
    if (/^[\u2500─\-=\s]+$/u.test(trimmed)) continue;

    const line = lines[j] ?? '';
    if (!line.includes('›')) continue;

    titles.push(stripTrailingSummaryRule(line));
  }
  return titles;
}

function normalizeTitleLoose(s) {
  return String(s)
    .replace(/\\/g, '/')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Whether a parsed failure block belongs to a flaky test (passed after retry). */
function detailMatchesFlakyTitle(detailName, flakySummaryLine) {
  const d = normalizeTitleLoose(stripReporterProjectPrefix(detailName));
  const f = normalizeTitleLoose(stripReporterProjectPrefix(flakySummaryLine));
  if (!d || !f) return false;
  if (d === f) return true;
  if (d.startsWith(f) || f.startsWith(d)) return true;
  const head = (x) => x.split(' › ').slice(0, 4).join(' › ');
  return head(d) === head(f) || d.startsWith(head(f)) || f.startsWith(head(d));
}

/**
 * @param {ReturnType<typeof extractFailedTestDetails>} allDetails
 * @param {string[]} flakyTitles
 * @param {{ jobPassed: boolean; flakyCount: number }} ctx
 */
function partitionFailureDetails(allDetails, flakyTitles, ctx) {
  /** @type {typeof allDetails} */
  const empty = [];
  if (!allDetails.length) return { hardFailed: empty, flakyFailed: empty };

  if (flakyTitles.length > 0) {
    /** @type {typeof allDetails} */
    const flakyFailed = [];
    /** @type {typeof allDetails} */
    const hardFailed = [];
    for (const d of allDetails) {
      const isFlaky = flakyTitles.some((ft) => detailMatchesFlakyTitle(d.name, ft));
      if (isFlaky) flakyFailed.push(d);
      else hardFailed.push(d);
    }
    return { hardFailed, flakyFailed };
  }

  if (ctx.jobPassed && ctx.flakyCount > 0) {
    return { hardFailed: empty, flakyFailed: allDetails };
  }

  return { hardFailed: allDetails, flakyFailed: empty };
}

function stripQuotes(s) {
  const t = String(s ?? '').trim();
  const m = t.match(/^"(.*)"$/);
  if (m) return m[1].trim();
  return t.replace(/^['"]+|['"]+$/g, '').trim();
}

function isCsvRelatedFailure(name, error) {
  const blob = `${name ?? ''} ${error ?? ''}`.toLowerCase();
  if (blob.includes('shown on csv:')) return true;
  if (/\bcsv\b/.test(blob)) return true;
  if (blob.includes('.csv')) return true;
  if (blob.includes('chart csv')) return true;
  return false;
}

function extractFailedTestDetails(raw) {
  const stripAnsi = (s) =>
    // eslint-disable-next-line no-control-regex
    String(s)
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\u001B\][^\u0007]*\u0007/g, '');
  const lines = raw.split(/\r?\n/).map(stripAnsi);

  /** @type {Array<{ index: number, name: string, error?: string, reason?: string, shownSite?: string, shownCsv?: string, expected?: string, csvFieldApplicable: boolean }>} */
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]?.match(/^\s*(\d+)\)\s+\[[^\]]+]\s+›\s+(.+)\s*$/);
    if (!header) continue;

    const idx = Number(header[1]);
    const name = header[2].trim();

    let error;
    let reason;
    let shownSite;
    let shownCsv;
    let legacyShownOrCsv;
    let expected;
    let expectedOneOf;
    let received;

    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (/^\s*\d+\)\s+\[[^\]]+]\s+›\s+/.test(l)) break;

      const trimmed = l.trim();
      if (!trimmed) continue;

      if (!error) {
        if (/^Error:\s*/i.test(trimmed)) error = trimmed.replace(/^Error:\s*/i, '').trim();
        else if (/^(TimeoutError|Error)\b/.test(trimmed)) error = trimmed;
      }

      if (!reason && /^Reason:\s*/i.test(trimmed)) reason = trimmed.replace(/^Reason:\s*/i, '').trim();
      if (!shownSite && /^Shown on site:\s*/i.test(trimmed)) shownSite = trimmed.replace(/^Shown on site:\s*/i, '').trim();
      if (!shownCsv && /^Shown on CSV:\s*/i.test(trimmed)) shownCsv = trimmed.replace(/^Shown on CSV:\s*/i, '').trim();
      if (!legacyShownOrCsv && /^Shown on site or CSV:\s*/i.test(trimmed))
        legacyShownOrCsv = trimmed.replace(/^Shown on site or CSV:\s*/i, '').trim();
      if (!expected && /^Expected:\s*/i.test(trimmed)) expected = trimmed.replace(/^Expected:\s*/i, '').trim();
      if (!expectedOneOf && /^Expected one of:\s*/i.test(trimmed))
        expectedOneOf = trimmed.replace(/^Expected one of:\s*/i, '').trim();
      if (!received && /^Received:\s*/i.test(trimmed)) received = trimmed.replace(/^Received:\s*/i, '').trim();
    }

    if (!shownSite && legacyShownOrCsv && !shownCsv) shownSite = legacyShownOrCsv;

    const recv = received ? stripQuotes(received) : '';
    const exp = expected ? stripQuotes(expected) : '';
    const expOne = expectedOneOf ? stripQuotes(expectedOneOf) : '';
    const csvish = isCsvRelatedFailure(name, error);

    if (recv && !shownSite && !shownCsv) {
      if (csvish && exp && String(error ?? '').toLowerCase().includes('tobe')) {
        shownCsv = recv;
        shownSite = exp;
      } else if (csvish) {
        shownCsv = recv;
      } else {
        shownSite = recv;
      }
    }

    const expectedOut = exp || expOne || undefined;

    out.push({
      index: idx,
      name,
      error,
      reason,
      shownSite,
      shownCsv,
      expected: expectedOut,
      csvFieldApplicable: csvish,
    });
  }

  return out;
}

function formatShownSiteLine(t) {
  if (!t.csvFieldApplicable) {
    return t.shownSite ? `    Shown on site: ${t.shownSite}` : `    Shown on site: (not found)`;
  }
  if (t.shownSite) return `    Shown on site: ${t.shownSite}`;
  const err = String(t.error ?? '').toLowerCase();
  if (t.shownCsv || err.includes('shown on csv')) return `    Shown on site: — (not asserted for this failure)`;
  return `    Shown on site: (not found)`;
}

function formatShownCsvLine(t) {
  if (!t.csvFieldApplicable) return `    Shown on CSV: — (not asserted in this test)`;
  if (t.shownCsv) return `    Shown on CSV: ${t.shownCsv}`;
  return `    Shown on CSV: (not found)`;
}

function shownSiteEmailValue(t) {
  return formatShownSiteLine(t)
    .trim()
    .replace(/^Shown on site:\s*/i, '')
    .trim();
}

function shownCsvEmailValue(t) {
  return formatShownCsvLine(t)
    .trim()
    .replace(/^Shown on CSV:\s*/i, '')
    .trim();
}

const MAX_INLINE_SCREENSHOT_BYTES = Number(process.env.MAX_INLINE_SCREENSHOT_BYTES ?? `${4 * 1024 * 1024}`);

/**
 * @param {Array<{ index: number, name: string, error?: string, reason?: string, shownSite?: string, shownCsv?: string, expected?: string, csvFieldApplicable: boolean }>} details
 * @param {Map<string, string>} screenshotMap
 * @param {Array<{ filename: string; path: string; cid: string; contentDisposition: string }>} attachments
 * @param {{ brand: string; brandLight: string; accent: string; mode: 'failed' | 'flaky' }}} style
 */
function renderIssueCardsHtml(details, screenshotMap, attachments, style) {
  const { brand, brandLight, accent, mode } = style;
  const isFlaky = mode === 'flaky';
  const border = isFlaky ? '#e9b949' : '#c5d4e8';
  const chipBg = isFlaky ? '#fffbeb' : brandLight;
  const chipText = isFlaky ? '#92400e' : accent;

  return details
    .map((t, i) => {
      const { headline, sub } = friendlyTestHeadline(t.name);
      const key = normalizeTestKey(t.name);
      const shotPath = screenshotMap.get(key);
      let imgHtml = '';
      if (shotPath && fs.existsSync(shotPath)) {
        let size = 0;
        try {
          size = fs.statSync(shotPath).size;
        } catch {
          size = MAX_INLINE_SCREENSHOT_BYTES + 1;
        }
        if (size <= MAX_INLINE_SCREENSHOT_BYTES) {
          const cid = `pw-${mode}-${t.index}-${i}-${crypto.randomBytes(4).toString('hex')}`;
          attachments.push({
            filename: path.basename(shotPath),
            path: shotPath,
            cid,
            contentDisposition: 'inline',
          });
          imgHtml = `
                <div style="margin-top:14px;padding:10px;background:${brandLight};border-radius:8px;border:1px solid #c5d4e8;">
                  <div style="font-size:12px;color:${brand};font-weight:600;margin-bottom:8px;">Failure screenshot (full page)</div>
                  <img src="cid:${cid}" alt="Failure screenshot" width="560" style="max-width:100%;height:auto;border-radius:6px;display:block;border:1px solid #bcd;" />
                </div>`;
        } else {
          imgHtml = `<p style="font-size:12px;color:#555;margin-top:10px;">Screenshot on disk is large (${Math.round(size / 1024)} KB); open the <b>playwright-report</b> artifact ZIP for the full image.</p>`;
        }
      } else {
        imgHtml = `<p style="font-size:12px;color:#666;margin-top:10px;">No failure screenshot was found for this test on the runner. Traces and videos are still in the workflow artifact ZIP.</p>`;
      }

      const issueLabel = isFlaky ? `Flaky ${i + 1}` : `Issue ${t.index}`;
      const chip = isFlaky
        ? `<div style="display:inline-block;margin-top:4px;font-size:11px;font-weight:700;color:${chipText};background:${chipBg};border:1px solid ${border};padding:4px 10px;border-radius:999px;">Failed on an earlier attempt, then passed</div>`
        : '';

      return `
            <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:0 0 18px 0;border-collapse:separate;">
              <tr>
                <td style="background:#fff;border:1px solid ${border};border-radius:12px;padding:18px 20px;box-shadow:0 2px 8px rgba(0,40,80,0.06);">
                  <div style="font-size:11px;color:${chipText};font-weight:700;letter-spacing:0.06em;text-transform:uppercase;">${escapeHtml(issueLabel)}</div>
                  ${chip}
                  <div style="font-size:18px;font-weight:700;color:${brand};margin:6px 0 4px;line-height:1.25;">${escapeHtml(headline)}</div>
                  ${sub ? `<div style="font-size:13px;color:#4a5a6a;margin-bottom:10px;">${escapeHtml(sub)}</div>` : ''}
                  <div style="font-size:11px;color:#6a7a8a;font-family:Consolas,Monaco,monospace;word-break:break-all;margin-bottom:14px;padding:8px 10px;background:${brandLight};border-radius:6px;">${escapeHtml(t.name)}</div>
                  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;color:#223;">
                    <tr><td style="padding:4px 0;width:120px;color:#5a6a7a;vertical-align:top;"><b>What went wrong</b></td><td style="padding:4px 0;">${escapeHtml(t.error ?? '(not found)')}</td></tr>
                    <tr><td style="padding:4px 0;color:#5a6a7a;vertical-align:top;"><b>Reason</b></td><td style="padding:4px 0;">${escapeHtml(t.reason ?? '(not found)')}</td></tr>
                    <tr><td style="padding:4px 0;color:#5a6a7a;vertical-align:top;"><b>Shown on site</b></td><td style="padding:4px 0;">${escapeHtml(shownSiteEmailValue(t))}</td></tr>
                    <tr><td style="padding:4px 0;color:#5a6a7a;vertical-align:top;"><b>Shown on CSV</b></td><td style="padding:4px 0;">${escapeHtml(shownCsvEmailValue(t))}</td></tr>
                    <tr><td style="padding:4px 0;color:#5a6a7a;vertical-align:top;"><b>Expected</b></td><td style="padding:4px 0;">${escapeHtml(t.expected ?? '(not found)')}</td></tr>
                  </table>
                  ${imgHtml}
                </td>
              </tr>
            </table>`;
    })
    .join('');
}

/** Match Playwright list title to error-context.md (same normalization as screenshot map). */
function normalizeTestKey(name) {
  return String(name)
    .replace(/\\/g, '/')
    .replace(/\u00a0/g, ' ')
    .replace(/\s*›\s*/g, ' › ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function testKeyFromErrorContextMd(md) {
  const loc = md.match(/^-\s*Location:\s*(.+)$/im)?.[1]?.trim();
  const nameLine = md.match(/^-\s*Name:\s*(.+)$/im)?.[1]?.trim();
  if (!loc || !nameLine) return null;
  const parts = nameLine.split(/\s*>>\s*/).map((p) => p.trim()).filter(Boolean);
  const title = parts.length > 1 ? parts.slice(1).join(' › ') : nameLine;
  return normalizeTestKey(`${loc} › ${title}`);
}

/**
 * Map normalized test key -> absolute path to failure full-page PNG (if present).
 */
function collectFailureScreenshotsByTestKey(testResultsRoot) {
  /** @type {Map<string, string>} */
  const map = new Map();
  if (!testResultsRoot || !fs.existsSync(testResultsRoot)) return map;

  const entries = fs.readdirSync(testResultsRoot, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const resultDir = path.join(testResultsRoot, ent.name);
    const ctxPath = path.join(resultDir, 'error-context.md');
    if (!fs.existsSync(ctxPath)) continue;
    const md = readOptionalText(ctxPath);
    if (!md) continue;
    const key = testKeyFromErrorContextMd(md);
    if (!key) continue;

    const attDir = path.join(resultDir, 'attachments');
    if (!fs.existsSync(attDir)) continue;
    let png;
    try {
      png = fs
        .readdirSync(attDir)
        .find((f) => f.toLowerCase().includes('failure-fullpage') && f.endsWith('.png'));
    } catch {
      continue;
    }
    if (!png) continue;
    const abs = path.join(attDir, png);
    if (!map.has(key)) map.set(key, abs);
  }
  return map;
}

function friendlyTestHeadline(fullName) {
  const parts = String(fullName)
    .split(/\s*›\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return { headline: fullName, sub: '' };
  const headline = parts[parts.length - 1];
  const sub = parts.slice(0, -1).join(' › ');
  return { headline, sub };
}

function statusWord(testStatus) {
  const s = String(testStatus ?? '').toLowerCase();
  if (s === 'passed') return 'Passed';
  if (s === 'failed') return 'Failed';
  return testStatus ? testStatus.charAt(0).toUpperCase() + testStatus.slice(1).toLowerCase() : 'Unknown';
}

function formatRunTime() {
  const t = process.env.RUN_DISPLAY_TIME?.trim();
  if (t) return t;
  return new Date().toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');
}

const smtpHost = process.env.SMTP_HOST ?? 'smtp.office365.com';
const smtpPort = Number(process.env.SMTP_PORT ?? '587');
const smtpUser = requiredEnv('SMTP_USER');
const smtpPass = requiredEnv('SMTP_PASS');
const mailTo = requiredEnv('MAIL_TO');
const mailFrom = process.env.MAIL_FROM ?? smtpUser;

const testStatus = process.env.TEST_STATUS ?? 'unknown';
const flakyCountFromEnv = Number(process.env.FLAKY_COUNT ?? '0') || 0;
const runUrl = githubRunUrl();
const artifactsPageUrl = githubArtifactsPageUrl();

const summary =
  readOptionalText(path.join(process.cwd(), 'playwright-summary.txt')) ??
  readOptionalText(path.join(process.cwd(), 'playwright-report', 'summary.txt')) ??
  readOptionalText(path.join(process.cwd(), 'test-results', 'summary.txt')) ??
  null;

const subjectPrefix = process.env.SUBJECT_PREFIX ?? '[Allianz smoke daily tests]';
const statusLabel = statusWord(testStatus);
const subject = `${subjectPrefix} ${statusLabel}`.trim();

const parsed = summary ? parsePlaywrightSummary(summary) : null;
const allFailureDetails = summary ? extractFailedTestDetails(summary) : [];
const flakyTitles = summary ? extractFlakyTestTitles(summary) : [];

const flakyCount = Math.max(flakyCountFromEnv, parsed?.flaky ?? 0);
const runTimeDisplay = formatRunTime();

const testResultsRoot = path.join(process.cwd(), 'test-results');
const screenshotMap = collectFailureScreenshotsByTestKey(testResultsRoot);

const jobPassed = testStatus === 'passed';
const { hardFailed: hardFailedDetails, flakyFailed: flakyFailedDetails } = partitionFailureDetails(
  allFailureDetails,
  flakyTitles,
  { jobPassed, flakyCount },
);

/** Display strings for stats (Outlook-friendly; avoid "—" for failed when run passed but summary omits "0 failed"). */
const passedDisplay = parsed?.passed != null ? String(parsed.passed) : '—';
const failedDisplay =
  parsed?.failed != null ? String(parsed.failed) : jobPassed && parsed?.passed != null ? '0' : '—';
const flakyDisplay = String(flakyCount);
const durationLine = parsed?.duration ? `Playwright reported duration: ${parsed.duration}` : 'Duration: —';

const brand = '#003781';
const brandLight = '#e8eef5';
const accent = '#0072ce';

function textLinesForDetails(details, labelPrefix) {
  return details.flatMap((t) => {
    const { headline, sub } = friendlyTestHeadline(t.name);
    return [
      `${labelPrefix}${headline}`,
      sub ? `  Suite: ${sub}` : null,
      `  Full id: ${t.name}`,
      t.error ? `  What went wrong: ${t.error}` : '  What went wrong: (not found)',
      t.reason ? `  Reason: ${t.reason}` : '  Reason: (not found)',
      formatShownSiteLine(t).trim(),
      formatShownCsvLine(t).trim(),
      t.expected ? `  Expected: ${t.expected}` : '  Expected: (not found)',
      screenshotMap.get(normalizeTestKey(t.name))
        ? `  Screenshot: attached in HTML version of this email.`
        : '  Screenshot: (not found on runner — open the HTML report artifact if needed)',
      '',
    ].filter(Boolean);
  });
}

const bodyLines = [
  `${subjectPrefix} ${statusLabel}`,
  '',
  'Results',
  `  Passed — ${passedDisplay}`,
  `  Failed — ${failedDisplay}`,
  `  Retried / flaky — ${flakyDisplay}`,
  `  Time of run — ${runTimeDisplay}`,
  '',
  runUrl ? `GitHub run (full log): ${runUrl}` : null,
  artifactsPageUrl ? `Download report & failure files (Artifacts on this page): ${artifactsPageUrl}` : null,
  '',
  flakyFailedDetails.length ? 'Flaky tests (failed attempt, then passed)' : null,
  ...(flakyFailedDetails.length ? textLinesForDetails(flakyFailedDetails, '— [flaky] ') : []),
  flakyCount > 0 && !flakyFailedDetails.length
    ? 'Flaky: count reported but per-test details were not found in playwright-summary.txt (open the GitHub run log).'
    : null,
  '',
  !jobPassed && hardFailedDetails.length ? 'Tests details (failed)' : null,
  ...(!jobPassed && hardFailedDetails.length ? textLinesForDetails(hardFailedDetails, '— ') : []),
  '',
  'Tip: open the HTML version of this email to see formatted cards and failure screenshots.',
].filter((x) => x !== null);

/** @type {Array<{ filename: string; path: string; cid: string; contentDisposition: string }>} */
const attachments = [];

const flakyHtmlBlocks = flakyFailedDetails.length
  ? renderIssueCardsHtml(flakyFailedDetails, screenshotMap, attachments, { brand, brandLight, accent, mode: 'flaky' })
  : '';

const failedHtmlBlocks =
  !jobPassed && hardFailedDetails.length
    ? renderIssueCardsHtml(hardFailedDetails, screenshotMap, attachments, { brand, brandLight, accent, mode: 'failed' })
    : '';

const flakyNoticeHtml =
  flakyCount > 0 && !flakyFailedDetails.length
    ? `<p style="margin:0 0 14px;font-size:13px;color:#92400e;background:#fffbeb;border:1px solid #fcd34d;border-radius:8px;padding:12px 14px;"><b>Flaky tests reported (${escapeHtml(
        String(flakyCount),
      )})</b> — the log did not include a parseable flaky list or failure blocks. Open the GitHub run for full output.</p>`
    : '';

const detailsSectionHtml = (() => {
  const parts = [];
  if (flakyNoticeHtml) parts.push(flakyNoticeHtml);
  if (flakyHtmlBlocks) {
    parts.push(`<div style="font-size:17px;font-weight:800;color:${brand};margin:16px 0 10px;letter-spacing:-0.02em;">Flaky tests</div>
      <p style="margin:0 0 14px;font-size:13px;color:#556;">These checks failed on at least one attempt, then <b>passed</b> on a retry. Details below are from the failing attempt.</p>
      ${flakyHtmlBlocks}`);
  }
  if (failedHtmlBlocks) {
    parts.push(`<div style="font-size:17px;font-weight:800;color:${brand};margin:24px 0 10px;letter-spacing:-0.02em;">Tests details</div>
      <p style="margin:0 0 14px;font-size:13px;color:#556;">Each card is one failing check. Screenshots are captured when the browser session is still open.</p>
      ${failedHtmlBlocks}`);
  }
  if (parts.length) {
    let inner = parts.join('');
    if (jobPassed && (flakyHtmlBlocks || flakyNoticeHtml)) {
      inner += `<p style="margin-top:16px;font-size:14px;color:#14532d;line-height:1.45;"><b>Overall job result: passed</b> — including tests that only passed after a retry.</p>`;
    }
    return `<tr>
            <td style="background:#fff;padding:8px 22px 22px;border-left:1px solid #d8e2ec;border-right:1px solid #d8e2ec;border-radius:0 0 14px 14px;">
              ${inner}
            </td>
          </tr>`;
  }
  if (jobPassed) {
    return `<tr>
            <td style="background:#fff;padding:8px 22px 22px;border-left:1px solid #d8e2ec;border-right:1px solid #d8e2ec;border-radius:0 0 14px 14px;">
              <p style="margin:0;font-size:15px;color:#1e5a40;line-height:1.5;"><b>All checks passed.</b> There are no failing scenarios to review in this run.</p>
            </td>
          </tr>`;
  }
  return `<tr>
            <td style="background:#fff;padding:8px 22px 22px;border-left:1px solid #d8e2ec;border-right:1px solid #d8e2ec;border-radius:0 0 14px 14px;">
              <div style="font-size:17px;font-weight:800;color:${brand};margin:0 0 8px;">Tests details</div>
              <p style="margin:0;font-size:14px;color:#334;">The run did not succeed, but individual failure lines could not be parsed for this email. Open the <b>GitHub run</b> link above for the full log and the <b>Artifacts</b> download.</p>
            </td>
          </tr>`;
})();

const statsTable = `
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin:16px 0;border-collapse:separate;">
    <tr>
      <td style="width:50%;padding:6px;">
        <div style="background:#ecf9f0;border-radius:10px;padding:14px 16px;border:1px solid #b8e0c8;">
          <div style="font-size:12px;color:#1e6b3a;font-weight:600;">Passed</div>
          <div style="font-size:28px;font-weight:800;color:#14532d;">${escapeHtml(passedDisplay)}</div>
        </div>
      </td>
      <td style="width:50%;padding:6px;">
        <div style="background:#fdeeee;border-radius:10px;padding:14px 16px;border:1px solid #f5c2c2;">
          <div style="font-size:12px;color:#9b1c1c;font-weight:600;">Failed</div>
          <div style="font-size:28px;font-weight:800;color:#7f1d1d;">${escapeHtml(failedDisplay)}</div>
        </div>
      </td>
    </tr>
    <tr>
      <td style="padding:6px;">
        <div style="background:#fff8e6;border-radius:10px;padding:14px 16px;border:1px solid #f5e0a8;">
          <div style="font-size:12px;color:#8a6d1b;font-weight:600;">Retried / flaky</div>
          <div style="font-size:28px;font-weight:800;color:#6b560f;">${escapeHtml(flakyDisplay)}</div>
        </div>
      </td>
      <td style="padding:6px;">
        <div style="background:#eef5ff;border-radius:10px;padding:14px 16px;border:1px solid #c5d4e8;">
          <div style="font-size:12px;color:${brand};font-weight:600;">Time of run</div>
          <div style="font-size:15px;font-weight:700;color:#0f2744;line-height:1.35;">${escapeHtml(runTimeDisplay)}</div>
          <div style="font-size:12px;color:#4a5a6a;margin-top:6px;">${escapeHtml(durationLine)}</div>
        </div>
      </td>
    </tr>
  </table>
`;

/** Solid fills only: Outlook/Word HTML often strips CSS gradients, which left white text on a pale background. */
const heroBgColor = jobPassed ? '#0d5c44' : '#8b1538';

const html = `
<!DOCTYPE html>
<html><body style="margin:0;padding:0;background-color:#f0f4f8;">
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" bgcolor="#f0f4f8" style="background-color:#f0f4f8;padding:20px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="max-width:600px;width:100%;border-collapse:separate;">
          <tr>
            <td bgcolor="${heroBgColor}" style="border-radius:14px 14px 0 0;background-color:${heroBgColor};padding:22px 24px;">
              <div style="font-size:13px;color:#ecfdf5;letter-spacing:0.04em;mso-line-height-rule:exactly;line-height:1.35;">${escapeHtml(subjectPrefix)}</div>
              <div style="font-size:30px;font-weight:800;color:#ffffff;margin-top:6px;line-height:1.15;mso-line-height-rule:exactly;">${escapeHtml(statusLabel)}</div>
              <div style="font-size:14px;color:#d1fae5;margin-top:10px;line-height:1.4;mso-line-height-rule:exactly;">Automated end-to-end checks against the public site.</div>
            </td>
          </tr>
          <tr>
            <td style="background:#fff;padding:20px 22px 8px;border-left:1px solid #d8e2ec;border-right:1px solid #d8e2ec;">
              <div style="font-size:15px;font-weight:700;color:${brand};margin-bottom:4px;">Results</div>
              ${statsTable}
              ${
                runUrl
                  ? `<div style="margin:8px 0 6px;">
                  <a href="${escapeHtml(runUrl)}" style="display:inline-block;background:${brand};color:#fff;text-decoration:none;font-weight:700;font-size:14px;padding:12px 20px;border-radius:999px;">Open GitHub run</a>
                </div>`
                  : ''
              }
            </td>
          </tr>
          <tr>
            <td style="background:#fff;padding:0 22px 18px;border-left:1px solid #d8e2ec;border-right:1px solid #d8e2ec;">
              <div style="font-size:15px;font-weight:700;color:${brand};margin:12px 0 8px;">Artifacts &amp; downloads</div>
              <p style="margin:0 0 10px;font-size:14px;color:#334;line-height:1.5;">
                The workflow uploads one ZIP named <b>playwright-report</b>. It contains the browsable HTML report and the <b>test-results</b> folder (screenshots, traces, videos).
              </p>
              ${
                artifactsPageUrl
                  ? `<div style="margin:12px 0;padding:14px 16px;background:${brandLight};border-radius:10px;border:1px solid #b8cadc;">
                  <div style="font-size:12px;font-weight:700;color:${brand};margin-bottom:6px;">Direct link (scroll to &quot;Artifacts&quot;)</div>
                  <a href="${escapeHtml(artifactsPageUrl)}" style="word-break:break-all;font-size:13px;color:${accent};font-weight:600;">${escapeHtml(artifactsPageUrl)}</a>
                </div>`
                  : runUrl
                    ? `<p style="font-size:13px;"><a href="${escapeHtml(runUrl)}">${escapeHtml(runUrl)}</a></p>`
                    : ''
              }
            </td>
          </tr>
          ${detailsSectionHtml}
          <tr>
            <td style="padding:14px 8px;font-size:11px;color:#8899aa;text-align:center;line-height:1.4;">
              This message was sent automatically from CI. GitHub artifact links point to the run page; use the <b>Artifacts</b> section to download the ZIP.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body></html>
`;

const transporter = nodemailer.createTransport({
  host: smtpHost,
  port: smtpPort,
  secure: false,
  auth: { user: smtpUser, pass: smtpPass },
  requireTLS: true,
});

await transporter.sendMail({
  from: mailFrom,
  to: mailTo,
  subject,
  text: bodyLines.join('\n'),
  html,
  attachments: attachments.length ? attachments : undefined,
});

console.log(`Sent email to ${mailTo} via ${smtpHost}:${smtpPort}`);
