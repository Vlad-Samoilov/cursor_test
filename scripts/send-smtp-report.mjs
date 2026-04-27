import fs from 'node:fs';
import path from 'node:path';
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

  // Examples near the end:
  // "  10 passed (47.5s)"
  // "  7 passed (38.1s)"
  // "  3 failed"
  // "  8 passed (2.7m)"
  let passed = null;
  let failed = null;
  let skipped = null;
  let duration = null;

  for (const l of lines) {
    const mPassed = l.match(/\b(\d+)\s+passed\b/i);
    const mFailed = l.match(/\b(\d+)\s+failed\b/i);
    const mSkipped = l.match(/\b(\d+)\s+skipped\b/i);
    const mDur = l.match(/\(([\d.]+[sm]|[\d.]+m)\)\s*$/i);
    if (mPassed) passed = Number(mPassed[1]);
    if (mFailed) failed = Number(mFailed[1]);
    if (mSkipped) skipped = Number(mSkipped[1]);
    if (mDur) duration = mDur[1];
  }

  // Collect failed test titles from the list reporter:
  // "  x   2 [chromium] › tests\\fund-page.spec.ts:10:9 › Fund page @smoke › Floor5: fund page checks (31.9s)"
  // Some outputs use symbols like "✘" or "×" instead of "x".
  const failures = lines
    .map((l) => {
      const m = l.match(/^\s*[xX✘×]\s+\d+\s+\[[^\]]+]\s+›\s+(.+?)\s*$/);
      if (!m?.[1]) return null;
      // Remove trailing duration like " (31.9s)" or " (2.4m)" if present.
      return m[1].replace(/\s+\(\d+(?:\.\d+)?[sm]\)\s*$/i, '').trim();
    })
    .filter(Boolean);

  // Deduplicate while preserving order.
  const seen = new Set();
  const uniqueFailures = [];
  for (const f of failures) {
    if (seen.has(f)) continue;
    seen.add(f);
    uniqueFailures.push(f);
  }

  return { passed, failed, skipped, duration, failures: uniqueFailures };
}

function extractFailedTestDetails(raw) {
  const stripAnsi = (s) =>
    // eslint-disable-next-line no-control-regex
    String(s)
      .replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\u001B\][^\u0007]*\u0007/g, '');
  const lines = raw.split(/\r?\n/).map(stripAnsi);

  /** @type {Array<{ index: number, name: string, error?: string, reason?: string, shown?: string, expected?: string }>} */
  const out = [];

  // Playwright failure sections typically look like:
  // "  1) [chromium] › tests\\file.spec.ts:10:9 › Suite › Test name"
  // followed by some lines including e.g.
  // "Error: ...", "Reason: ...", "Shown on site or CSV: ...", "Expected: ..."
  for (let i = 0; i < lines.length; i++) {
    const header = lines[i]?.match(/^\s*(\d+)\)\s+\[[^\]]+]\s+›\s+(.+)\s*$/);
    if (!header) continue;

    const idx = Number(header[1]);
    const name = header[2].trim();

    let error;
    let reason;
    let shown;
    let expected;

    // Scan until next "N) [browser]" header or the end.
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j] ?? '';
      if (/^\s*\d+\)\s+\[[^\]]+]\s+›\s+/.test(l)) break;

      const trimmed = l.trim();
      if (!trimmed) continue;

      // Prefer the first "Error:" line; otherwise pick TimeoutError / locator.* timeout line.
      if (!error) {
        if (/^Error:\s*/i.test(trimmed)) error = trimmed.replace(/^Error:\s*/i, '').trim();
        else if (/^(TimeoutError|Error)\b/.test(trimmed)) error = trimmed;
      }

      if (!reason && /^Reason:\s*/i.test(trimmed)) reason = trimmed.replace(/^Reason:\s*/i, '').trim();
      if (!shown && /^Shown on site or CSV:\s*/i.test(trimmed))
        shown = trimmed.replace(/^Shown on site or CSV:\s*/i, '').trim();
      if (!expected && /^Expected:\s*/i.test(trimmed)) expected = trimmed.replace(/^Expected:\s*/i, '').trim();

      // Some errors format "Shown on site: ..." (UI only)
      if (!shown && /^Shown on site:\s*/i.test(trimmed)) shown = trimmed.replace(/^Shown on site:\s*/i, '').trim();
    }

    out.push({ index: idx, name, error, reason, shown, expected });
  }

  return out;
}

const smtpHost = process.env.SMTP_HOST ?? 'smtp.office365.com';
const smtpPort = Number(process.env.SMTP_PORT ?? '587');
const smtpUser = requiredEnv('SMTP_USER');
const smtpPass = requiredEnv('SMTP_PASS');
const mailTo = requiredEnv('MAIL_TO');
const mailFrom = process.env.MAIL_FROM ?? smtpUser;

const testStatus = process.env.TEST_STATUS ?? 'unknown';
const runUrl = githubRunUrl();

const summary =
  readOptionalText(path.join(process.cwd(), 'playwright-summary.txt')) ??
  readOptionalText(path.join(process.cwd(), 'playwright-report', 'summary.txt')) ??
  readOptionalText(path.join(process.cwd(), 'test-results', 'summary.txt')) ??
  null;

const subjectPrefix = process.env.SUBJECT_PREFIX ?? '[Daily E2E]';
const subject = `${subjectPrefix} ${testStatus.toUpperCase()} - ${process.env.GITHUB_REPOSITORY ?? ''}`.trim();

const parsed = summary ? parsePlaywrightSummary(summary) : null;
const failedDetails = summary ? extractFailedTestDetails(summary) : [];

const headlineParts = [
  parsed?.passed != null ? `${parsed.passed} passed` : null,
  parsed?.failed != null ? `${parsed.failed} failed` : null,
  parsed?.skipped != null ? `${parsed.skipped} skipped` : null,
  parsed?.duration ? `in ${parsed.duration}` : null,
].filter(Boolean);

const bodyLines = [
  `Status: ${testStatus.toUpperCase()}`,
  headlineParts.length ? `Results: ${headlineParts.join(', ')}` : null,
  runUrl ? `GitHub run: ${runUrl}` : null,
  '',
  'Artifacts:',
  '- Playwright HTML report is uploaded as workflow artifact: "playwright-report"',
  '- Trace/video/screenshots are under artifact folder: "test-results"',
  '',
  failedDetails.length ? 'Raw output:' : null,
  ...(failedDetails.length
    ? failedDetails.flatMap((t) => [
        `${t.index}) ${t.name}`,
        t.error ? `  Error: ${t.error}` : '  Error: (not found)',
        t.reason ? `    Reason: ${t.reason}` : '    Reason: (not found)',
        t.shown ? `    Shown on site or CSV: ${t.shown}` : '    Shown on site or CSV: (not found)',
        t.expected ? `    Expected: ${t.expected}` : '    Expected: (not found)',
        '',
      ])
    : []),
].filter((x) => x !== null);

const html = `
  <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, 'Apple Color Emoji','Segoe UI Emoji'; line-height: 1.4;">
    <h2 style="margin: 0 0 8px 0;">${escapeHtml(subjectPrefix)} ${escapeHtml(testStatus.toUpperCase())}</h2>
    ${headlineParts.length ? `<div><b>Results:</b> ${escapeHtml(headlineParts.join(', '))}</div>` : ''}
    ${runUrl ? `<div><b>GitHub run:</b> <a href="${escapeHtml(runUrl)}">${escapeHtml(runUrl)}</a></div>` : ''}
    <h3 style="margin: 16px 0 8px 0;">Artifacts</h3>
    <ul>
      <li>Playwright HTML report artifact: <code>playwright-report</code></li>
      <li>Traces/videos/screenshots artifact folder: <code>test-results</code></li>
    </ul>
    ${
      failedDetails.length
        ? `<h3 style="margin: 16px 0 8px 0;">Raw output</h3>
           ${failedDetails
             .map(
               (t) => `
             <div style="margin: 10px 0 14px 0;">
               <div><b>${escapeHtml(String(t.index))})</b> <code>${escapeHtml(t.name)}</code></div>
               <div style="margin-left: 12px;"><b>Error:</b> ${escapeHtml(t.error ?? '(not found)')}</div>
               <div style="margin-left: 12px;"><b>Reason:</b> ${escapeHtml(t.reason ?? '(not found)')}</div>
               <div style="margin-left: 12px;"><b>Shown on site or CSV:</b> ${escapeHtml(t.shown ?? '(not found)')}</div>
               <div style="margin-left: 12px;"><b>Expected:</b> ${escapeHtml(t.expected ?? '(not found)')}</div>
             </div>`,
             )
             .join('')}`
        : ''
    }
  </div>
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
});

console.log(`Sent email to ${mailTo} via ${smtpHost}:${smtpPort}`);

