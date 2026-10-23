// Plaid's personal_finance_category (detailed) → our category. Used only when no keyword matches,
// so the keyword rules (including the user's own) always win.
// Deposits, withdrawals and generic "account transfers" are left unmapped: they can be income,
// spending or a move between the user's accounts, and marking them transfers would hide them.
const DETAILED = {
  TRANSFER_IN_SAVINGS: 'transfers',
  TRANSFER_OUT_SAVINGS: 'transfers',
  TRANSFER_IN_INVESTMENT_AND_RETIREMENT_FUNDS: 'transfers',
  TRANSFER_OUT_INVESTMENT_AND_RETIREMENT_FUNDS: 'transfers',
  TRANSFER_IN_CASH_ADVANCES_AND_LOANS: 'transfers',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'transfers',
  LOAN_PAYMENTS_MORTGAGE_PAYMENT: 'housing',
  LOAN_PAYMENTS_CAR_PAYMENT: 'transport',
  RENT_AND_UTILITIES_RENT: 'housing',
  HOME_IMPROVEMENT_REPAIR_AND_MAINTENANCE: 'housing',
  FOOD_AND_DRINK_GROCERIES: 'groceries',
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: 'groceries',
  ENTERTAINMENT_CASINOS_AND_GAMBLING: 'betting',
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'health',
  MEDICAL_VETERINARY_SERVICES: 'other',
  GENERAL_SERVICES_INSURANCE: 'insurance',
  GENERAL_SERVICES_AUTOMOTIVE: 'transport',
  TRAVEL_RENTAL_CARS: 'transport',
};

const PRIMARY = {
  FOOD_AND_DRINK: 'dining',
  ENTERTAINMENT: 'entertainment',
  GENERAL_MERCHANDISE: 'shopping',
  HOME_IMPROVEMENT: 'shopping',
  MEDICAL: 'health',
  TRANSPORTATION: 'transport',
  RENT_AND_UTILITIES: 'utilities',
};

export function mapPlaidCategory(detailed) {
  if (!detailed) return null;
  if (DETAILED[detailed]) return DETAILED[detailed];
  const primary = Object.keys(PRIMARY).find((p) => detailed.startsWith(`${p}_`));
  return primary ? PRIMARY[primary] : null;
}
