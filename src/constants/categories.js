// Money out. `transfers` (neither income nor spending) is listed here so the Spending page can filter by it.
export const SPENDING_CATEGORIES = [
  { id: 'housing', name: 'Housing', icon: '\u{1F3E0}', color: '#E8927C' },
  { id: 'transport', name: 'Transport', icon: '\u{1F697}', color: '#7CB5E8' },
  { id: 'groceries', name: 'Groceries', icon: '\u{1F6D2}', color: '#E8C97C' },
  { id: 'dining', name: 'Dining Out', icon: '\u{1F37D}\u{FE0F}', color: '#E8A64C' },
  { id: 'utilities', name: 'Utilities', icon: '\u{26A1}', color: '#7CE8A3' },
  { id: 'entertainment', name: 'Entertainment', icon: '\u{1F3AC}', color: '#C97CE8' },
  { id: 'health', name: 'Health', icon: '\u{1F48A}', color: '#E87C9A' },
  { id: 'shopping', name: 'Shopping', icon: '\u{1F6CD}\u{FE0F}', color: '#7CE8D6' },
  { id: 'insurance', name: 'Insurance', icon: '\u{1F6E1}\u{FE0F}', color: '#A3E87C' },
  { id: 'subscriptions', name: 'Subscriptions', icon: '\u{1F504}', color: '#E87CE8' },
  { id: 'betting', name: 'Gambling', icon: '\u{1F3B2}', color: '#E8D44C' },
  { id: 'transfers', name: 'Transfers', icon: '\u{1F501}', color: '#6B7280' },
  { id: 'other', name: 'Other', icon: '\u{1F4E6}', color: '#9CA3AF' },
];

// Money in. Colors are checked against each other in this order on the dark card surface.
export const INCOME_CATEGORIES = [
  { id: 'salary', name: 'Salary', icon: '\u{1F4BC}', color: '#5FD99B' },
  { id: 'interest', name: 'Interest', icon: '\u{1F3E6}', color: '#6FB8F0' },
  { id: 'refunds', name: 'Refunds', icon: '\u{21A9}\u{FE0F}', color: '#F0C05A' },
  { id: 'benefits', name: 'Benefits', icon: '\u{1F6DF}', color: '#A99CF5' },
  { id: 'gifts', name: 'Gifts', icon: '\u{1F381}', color: '#F58C8C' },
  { id: 'other_income', name: 'Other Income', icon: '\u{1F4B0}', color: '#9CA3AF' },
];

export const CATEGORIES = [...SPENDING_CATEGORIES, ...INCOME_CATEGORIES];

export const CATEGORY_MAP = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c])
);

export const isIncomeCategory = (id) => INCOME_CATEGORIES.some((c) => c.id === id);

// The choices for one transaction: money in gets the income categories and Transfers, money out the rest
export const categoriesFor = (isCredit) => (isCredit ? [...INCOME_CATEGORIES, CATEGORY_MAP.transfers] : SPENDING_CATEGORIES);

export const formatCurrency = (amount) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
