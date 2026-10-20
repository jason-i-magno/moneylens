const MONTHLY_MULTIPLIERS = {
  weekly: 52 / 12,
  monthly: 1,
  quarterly: 1 / 3,
  yearly: 1 / 12,
};

export function getMonthlyAmount(amount, frequency) {
  return amount * (MONTHLY_MULTIPLIERS[frequency] || 1);
}
