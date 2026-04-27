import fs from 'node:fs';

/** RFC-style CSV row split honoring double quotes. */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && c === ',') {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out;
}

export type ParsedCharacteristicsCsv = {
  asOfDate: string;
  tickers: string[];
};

function tickerFromTickerStartColumn(value: string): string {
  const v = value.trim();
  if (!v) return '';
  return v.includes('_') ? v.split('_')[0]!.trim() : v.slice(0, 4).trim();
}

export function parseCharacteristicsCsvDownload(filePath: string): ParsedCharacteristicsCsv {
  let raw = fs.readFileSync(filePath, 'utf-8');
  raw = raw.replace(/^\uFEFF/, '');
  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length <= 1) throw new Error('Characteristics CSV missing data rows');

  const header = splitCsvLine(lines[0]).map((h) => h.trim().replace(/^"|"$/g, ''));
  const asOfIdx = header.indexOf('As of date');
  const tickerStartIdx = header.indexOf('Ticker_Start Date');
  if (asOfIdx < 0) throw new Error('CSV missing "As of date" column');
  if (tickerStartIdx < 0) throw new Error('CSV missing "Ticker_Start Date" column');

  const tickers: string[] = [];
  let asOfDate = '';
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCsvLine(lines[i]).map((c) => c.trim().replace(/^"|"$/g, ''));
    if (cols.length <= Math.max(asOfIdx, tickerStartIdx)) continue;
    const combined = cols[tickerStartIdx];
    const ticker = tickerFromTickerStartColumn(combined);
    if (ticker) tickers.push(ticker);
    const rowAsOf = cols[asOfIdx];
    if (!asOfDate && rowAsOf) asOfDate = rowAsOf;
  }

  if (!asOfDate.match(/\d{1,2}\/\d{1,2}\/\d{4}/)) throw new Error(`Unexpected As of date in CSV: ${asOfDate}`);
  return { asOfDate, tickers };
}
