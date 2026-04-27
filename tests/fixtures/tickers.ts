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

export const TICKERS_FLOOR5 = ['FLJJ', 'FLAO'] as const;

export const TICKERS_BUFFER100 = ['AIOO'] as const;

export const TICKERS_FOF = ['SPBU', 'SPBX', 'SPBW'] as const;

/**
 * Temporary: these are newly launched funds whose Performance tab may be blank/missing until May 1st.
 * We skip Performance-tab assertions for these tickers (both Product Table and Fund page).
 */
export const PERFORMANCE_SKIP_TICKERS = ['QBSV', 'QBQF', 'QBQV', 'QBIF', 'QBIV', 'QBKV', 'QBKF', 'ARLI'] as const;

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

export const ALL_TICKERS: readonly string[] = [
  ...TICKERS_BUFFER_CAPPED,
  ...TICKERS_FLOOR5,
  ...TICKERS_BUFFER100,
  ...TICKERS_FOF,
  ...TICKERS_BUFFER_UNCAPPED,
].sort();

const FOF_SET = new Set<string>(TICKERS_FOF);

export const NON_FOF_TICKERS: readonly string[] = ALL_TICKERS.filter((t) => !FOF_SET.has(t)).sort();
