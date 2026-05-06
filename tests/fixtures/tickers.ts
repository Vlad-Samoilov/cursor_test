/**
 * Ticker allowlists used by smoke tests.
 *
 * These lists are intentionally explicit (not discovered from the UI) to catch:
 * - missing products (ticker absent from the table)
 * - unexpected products (ticker added without acknowledgement)
 * - duplicates (ticker appears in multiple rows)
 */
export const TICKERS_BUFFER_CAPPED = [
  'QBSV',
  'QBSF',
  'QBQV',
  'QBQF',
  'QBKV',
  'QBKF',
  'QBIV',
  'QBIF',
  'JANT',
  'JANW',
  'FEBT',
  'FEBW',
  'MART',
  'MARW',
  'APRT',
  'APRW',
  'MAYT',
  'MAYW',
  'JUNT',
  'JUNW',
  'JULT',
  'JULW',
  'AUGT',
  'AUGW',
  'SEPT',
  'SEPW',
  'OCTT',
  'OCTW',
  'NVBT',
  'NVBW',
  'DECT',
  'DECW',
  'SIXJ',
  'SIXF',
  'SIXP',
  'SIXO',
  'SIXZ',
  'SIXD',
] as const;

/** "Floor 5" strategy tickers. */
export const TICKERS_FLOOR5 = ['FLJJ', 'FLAO'] as const;

/** "Buffer 100" strategy tickers. */
export const TICKERS_BUFFER100 = ['AIOO'] as const;

/** Fund-of-Funds tickers (FoF UI differs from standard fund pages). */
export const TICKERS_FOF = ['SPBU', 'SPBX', 'SPBW'] as const;

/**
 * Temporary: these are newly launched funds whose Performance tab may be blank/missing until May 1st.
 * We skip Performance-tab assertions for these tickers (both Product Table and Fund page).
 */
export const PERFORMANCE_SKIP_TICKERS = ['QBSV', 'QBQF', 'QBQV', 'QBIF', 'QBIV', 'QBKV', 'QBKF', 'ARLI'] as const;

/** "Buffer Uncapped" strategy tickers. */
export const TICKERS_BUFFER_UNCAPPED = [
  'JANU',
  'JANI',
  'FEBU',
  'MARU',
  'ARLU',
  'ARLI',
  'MAYU',
  'JNEU',
  'JULU',
  'AUGU',
  'SEPU',
  'OCTU',
  'NVBU',
  'DECU',
] as const;

/** All tickers across strategies, sorted for stable snapshots/logs. */
export const ALL_TICKERS: readonly string[] = [
  ...TICKERS_BUFFER_CAPPED,
  ...TICKERS_FLOOR5,
  ...TICKERS_BUFFER100,
  ...TICKERS_FOF,
  ...TICKERS_BUFFER_UNCAPPED,
].sort();

/** Fast membership set for FoF filtering. */
const FOF_SET = new Set<string>(TICKERS_FOF);

/** All tickers excluding FoF, sorted for stable iteration. */
export const NON_FOF_TICKERS: readonly string[] = ALL_TICKERS.filter((t) => !FOF_SET.has(t)).sort();
