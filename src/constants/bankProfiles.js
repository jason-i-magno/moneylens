const FILENAME_PATTERNS = [
  { profileId: 'usbank_checking', patterns: [/us\s*bank/i, /usbank/i, /checking\s*-\s*\d/i] },
  { profileId: 'amex_credit', patterns: [/amex/i, /american\s*express/i, /amex.*activity/i] },
  { profileId: 'discover_credit', patterns: [/discover/i] },
];

export function detectProfileFromFilename(fileName) {
  for (const { profileId, patterns } of FILENAME_PATTERNS) {
    if (patterns.some((p) => p.test(fileName))) {
      return profileId;
    }
  }
  return '';
}

// Maps bank profile IDs to net worth account metadata
export const PROFILE_ACCOUNT_MAP = {
  usbank_checking: { name: 'US Bank Checking', type: 'asset', category: 'bank' },
  amex_credit: { name: 'American Express', type: 'liability', category: 'debt' },
  discover_credit: { name: 'Discover', type: 'liability', category: 'debt' },
};

export const BUILTIN_BANK_PROFILES = {
  usbank_checking: {
    name: 'US Bank Checking',
    builtin: true,
    dateColumn: 'Date',
    descriptionColumn: 'Name',
    amountColumn: 'Amount',
    amountFormat: 'negative_is_debit',
    dateFormat: 'YYYY-MM-DD',
    categoryColumn: null,
    debitColumn: null,
    creditColumn: null,
    skipHeaderRows: 0,
  },
  amex_credit: {
    name: 'American Express',
    builtin: true,
    dateColumn: 'Date',
    descriptionColumn: 'Description',
    amountColumn: 'Amount',
    amountFormat: 'positive_is_debit',
    dateFormat: 'MM/DD/YYYY',
    categoryColumn: null,
    debitColumn: null,
    creditColumn: null,
    skipHeaderRows: 0,
  },
  discover_credit: {
    name: 'Discover',
    builtin: true,
    dateColumn: 'Trans. Date',
    descriptionColumn: 'Description',
    amountColumn: 'Amount',
    amountFormat: 'positive_is_debit',
    dateFormat: 'MM/DD/YYYY',
    categoryColumn: null,
    debitColumn: null,
    creditColumn: null,
    skipHeaderRows: 0,
  },
};
