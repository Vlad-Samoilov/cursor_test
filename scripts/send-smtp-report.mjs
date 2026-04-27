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
    // eslint-disable-next-line no-control-regex
    String(s).replace(/\u001B\[[0-9;]*[A-Za-z]/g, '').replace(/\u001B\][^\u0007]*\u0007/g, '');

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
  const failures = lines
    .map((l) => {
      const m = l.match(/^\s*x\s+\d+\s+\[[^\]]+]\s+›\s+(.+?)\s*$/);
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
  parsed?.failures?.length ? 'Failed tests:' : null,
  ...(parsed?.failures?.length ? parsed.failures.slice(0, 20).map((t) => `- ${t}`) : []),
  parsed?.failures?.length && parsed.failures.length > 20 ? `- ... and ${parsed.failures.length - 20} more` : null,
  parsed?.failures?.length ? '' : null,
  'Artifacts:',
  '- Playwright HTML report is uploaded as workflow artifact: "playwright-report"',
  '- Trace/video/screenshots are under artifact folder: "test-results"',
  '',
  summary ? 'Raw output (tail):' : null,
  summary ? summary.split(/\r?\n/).slice(-120).join('\n') : null,
].filter((x) => x !== null);

const html = `
  <div style="font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, 'Apple Color Emoji','Segoe UI Emoji'; line-height: 1.4;">
    <h2 style="margin: 0 0 8px 0;">${escapeHtml(subjectPrefix)} ${escapeHtml(testStatus.toUpperCase())}</h2>
    ${headlineParts.length ? `<div><b>Results:</b> ${escapeHtml(headlineParts.join(', '))}</div>` : ''}
    ${runUrl ? `<div><b>GitHub run:</b> <a href="${escapeHtml(runUrl)}">${escapeHtml(runUrl)}</a></div>` : ''}
    ${
      parsed?.failures?.length
        ? `<h3 style="margin: 16px 0 8px 0;">Failed tests</h3>
           <ul>${parsed.failures
             .slice(0, 20)
             .map((t) => `<li><code>${escapeHtml(t)}</code></li>`)
             .join('')}
           ${
             parsed.failures.length > 20
               ? `<li><i>... and ${parsed.failures.length - 20} more</i></li>`
               : ''
           }
           </ul>`
        : `<div style="margin-top: 16px;"><b>No failed tests.</b></div>`
    }
    <h3 style="margin: 16px 0 8px 0;">Artifacts</h3>
    <ul>
      <li>Playwright HTML report artifact: <code>playwright-report</code></li>
      <li>Traces/videos/screenshots artifact folder: <code>test-results</code></li>
    </ul>
    ${
      summary
        ? `<h3 style="margin: 16px 0 8px 0;">Raw output (tail)</h3>
           <pre style="white-space: pre-wrap; background: #f6f8fa; padding: 12px; border-radius: 8px; border: 1px solid #d0d7de;">${escapeHtml(
             summary.split(/\r?\n/).slice(-120).join('\n'),
           )}</pre>`
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

