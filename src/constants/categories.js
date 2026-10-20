export const CATEGORIES = [
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

export const CATEGORY_MAP = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c])
);

export const formatCurrency = (amount) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount);
