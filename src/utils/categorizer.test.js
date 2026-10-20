import { describe, it, expect } from 'vitest';
import {
  categorizeTransaction, categorizeBatch, isSubscription, getEffectiveKeywords, diffKeywords,
} from './categorizer';
import { DEFAULT_CATEGORY_KEYWORDS } from '../constants/defaultKeywords';

describe('categorizeTransaction', () => {
  it.each([
    // Longest keyword wins over a shorter one in an earlier category
    ['UBER EATS SAN FRANCISCO', 'dining'],
    ['UBER *EATS PENDING', 'dining'],
    ['UBER *TRIP', 'transport'],
    ['INTERNET PAYMENT - THANK YOU', 'transfers'],
    ['COMCAST INTERNET', 'utilities'],
    ['ENTERPRISE RENT-A-CAR', 'transport'],
    ['GEICO AUTO', 'insurance'],
    ['CITY ELECTRIC AUTOPAY', 'utilities'],
    // Keywords must start at a word boundary
    ['CURRENT FINANCIAL', 'other'],
    ['PARENTPAY', 'other'],
    ['LAS VEGAS HOTEL', 'other'],
    ['SMALL CUP COFFEE', 'dining'],
    ['SHELL GAS #123', 'transport'],
    ['RENT PAYMENT', 'housing'],
    // Ties go to the category listed first
    ['YOUTUBE PREMIUM', 'entertainment'],
    // Existing rules keep working
    ['AMEX EPAYMENT ACH PMT', 'transfers'],
    ['MOBILE PAYMENT - THANK YOU', 'transfers'],
    ['WHOLE FOODS #1234', 'groceries'],
    ['STATE LOTTERY', 'betting'],
    ['AT&T *PAYMENT', 'utilities'],
  ])('%s → %s', (description, expected) => {
    expect(categorizeTransaction(description)).toBe(expected);
  });

  it('ignores keyword categories that no longer exist', () => {
    expect(categorizeTransaction('GROCERY STORE', { food: ['grocery'] })).toBe('other');
  });
});

describe('isSubscription', () => {
  it('matches subscription keywords at word starts', () => {
    expect(isSubscription('NETFLIX.COM')).toBe(true);
    expect(isSubscription('DISNEY+ STREAMING')).toBe(true);
    expect(isSubscription('AMZN SUBSCRIPTI')).toBe(true);
    expect(isSubscription('WHOLE FOODS')).toBe(false);
  });
});

describe('categorizeBatch', () => {
  it('keeps a bank category only when it maps to one of ours', () => {
    const [known, byName, unknown] = categorizeBatch([
      { description: 'WHOLE FOODS', category: 'shopping' },
      { description: 'WHOLE FOODS', category: 'Dining Out' },
      { description: 'WHOLE FOODS', category: 'Food & Drink' },
    ]);
    expect(known.category).toBe('shopping');
    expect(byName.category).toBe('dining');
    expect(unknown.category).toBe('groceries');
  });
});

describe('keyword overrides', () => {
  it('effective keywords = defaults − removed + added', () => {
    const effective = getEffectiveKeywords({ groceries: ['corner market'] }, { transport: ['gas'] });
    expect(effective.groceries).toContain('corner market');
    expect(effective.groceries).toContain('whole foods');
    expect(effective.transport).not.toContain('gas');
    expect(effective.transport).toContain('fuel');
  });

  it('diffKeywords round-trips through getEffectiveKeywords', () => {
    const edited = getEffectiveKeywords();
    edited.groceries = [...edited.groceries, 'corner market'];
    edited.transport = edited.transport.filter((k) => k !== 'gas');
    const { added, removed } = diffKeywords(edited);
    expect(added).toEqual({ groceries: ['corner market'] });
    expect(removed).toEqual({ transport: ['gas'] });
    expect(getEffectiveKeywords(added, removed)).toEqual(edited);
  });

  it('unchanged defaults produce no overrides', () => {
    expect(diffKeywords(getEffectiveKeywords())).toEqual({ added: {}, removed: {} });
    expect(getEffectiveKeywords()).toEqual(
      expect.objectContaining({ transfers: DEFAULT_CATEGORY_KEYWORDS.transfers })
    );
  });
});
