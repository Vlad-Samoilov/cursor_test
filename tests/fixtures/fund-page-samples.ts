import crypto from 'node:crypto';
import {
  TICKERS_BUFFER100,
  TICKERS_BUFFER_CAPPED,
  TICKERS_BUFFER_UNCAPPED,
  TICKERS_FLOOR5,
  TICKERS_FOF,
} from './tickers';

/** Strategy row for fund-page tests — ticker is picked at random from `pool` when each test runs. */
export type FundPageStrategyDefinition = {
  /** Human-readable strategy name used in test titles/logs. */
  strategy: string;
  /** Ticker pool used for random sampling. */
  pool: readonly string[];
  /** Whether the fund page is expected to expose the Outcome period details tab. */
  hasOutcomePeriodTab: boolean;
};

/** Uniform random pick — new choice every time the test body runs (including retries). */
export function pickRandomTicker(pool: readonly string[]): string {
  if (pool.length === 0) throw new Error('Ticker pool must not be empty');
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const idx = buf[0]! % pool.length;
  return pool[idx]!;
}

/**
 * FoF has no Outcome period details tab; all other strategies do.
 */
export const FUND_PAGE_STRATEGIES: readonly FundPageStrategyDefinition[] = [
  { strategy: 'BufferCapped', pool: TICKERS_BUFFER_CAPPED, hasOutcomePeriodTab: true },
  { strategy: 'Floor5', pool: TICKERS_FLOOR5, hasOutcomePeriodTab: true },
  { strategy: 'Buffer100', pool: TICKERS_BUFFER100, hasOutcomePeriodTab: true },
  { strategy: 'FoF', pool: TICKERS_FOF, hasOutcomePeriodTab: false },
  { strategy: 'BufferUncapped', pool: TICKERS_BUFFER_UNCAPPED, hasOutcomePeriodTab: true },
];
