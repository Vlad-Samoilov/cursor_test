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

function readOptionalText(p) {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return null;
  }
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
  readOptionalText(path.join(process.cwd(), 'playwright-report', 'summary.txt')) ??
  readOptionalText(path.join(process.cwd(), 'test-results', 'summary.txt')) ??
  null;

const subjectPrefix = process.env.SUBJECT_PREFIX ?? '[Daily E2E]';
const subject = `${subjectPrefix} ${testStatus.toUpperCase()} - ${process.env.GITHUB_REPOSITORY ?? ''}`.trim();

const bodyLines = [
  `Status: ${testStatus}`,
  runUrl ? `Run: ${runUrl}` : null,
  '',
  summary ? '--- Summary ---' : null,
  summary,
].filter((x) => x !== null);

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
});

console.log(`Sent email to ${mailTo} via ${smtpHost}:${smtpPort}`);

