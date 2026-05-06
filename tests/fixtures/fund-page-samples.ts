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

/**
 * Uniform random pick using a provided RNG.
 *
 * This is used by the Fund Page smoke suite to pick a representative ticker from a strategy pool.
 * Prefer deterministic RNGs in CI so failures are reproducible by seed.
 */
export function pickRandomTicker(pool: readonly string[], rng: () => number): string {
  if (pool.length === 0) throw new Error('Ticker pool must not be empty');
  const idx = Math.floor(rng() * pool.length);
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
