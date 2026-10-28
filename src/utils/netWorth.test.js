import { describe, it, expect } from 'vitest';
import { buildBalanceTimeline, buildNetWorthHistory, balanceEffect, followedTransfers, loanBalancePoints, transfersInTransit } from './netWorth';

const tx = (date, amount, type, importedFrom = 'bank') => ({ date, amount, type, importedFrom });

describe('balanceEffect', () => {
  it('credits grow assets, debits grow liabilities', () => {
    expect(balanceEffect(tx('2026-01-01', 100, 'credit'), 'asset')).toBe(100);
    expect(balanceEffect(tx('2026-01-01', 100, 'debit'), 'asset')).toBe(-100);
    expect(balanceEffect(tx('2026-01-01', 100, 'debit'), 'liability')).toBe(100);
    expect(balanceEffect(tx('2026-01-01', 100, 'credit'), 'liability')).toBe(-100);
  });
});

describe('buildBalanceTimeline', () => {
  const checking = { id: 'a1', type: 'asset', linkedBankProfile: 'bank' };
  const card = { id: 'c1', type: 'liability', linkedBankProfile: 'card' };

  it('returns nothing without a snapshot', () => {
    expect(buildBalanceTimeline(checking, [], [tx('2026-01-05', 10, 'debit')])).toEqual([]);
  });

  it('projects a checking account forward and backward from snapshots', () => {
    const snapshots = [{ accountId: 'a1', date: '2026-01-10', balance: 1000 }];
    const txs = [
      tx('2026-01-05', 200, 'debit'),
      tx('2026-01-10', 50, 'debit'), // already reflected in the end-of-day snapshot
      tx('2026-01-12', 500, 'credit'),
      tx('2026-01-15', 100, 'debit'),
      tx('2026-01-12', 999, 'credit', 'other_bank'), // different account — ignored
    ];
    expect(buildBalanceTimeline(checking, snapshots, txs)).toEqual([
      { date: '2026-01-04', balance: 1250 }, // opening balance, before the first activity
      { date: '2026-01-05', balance: 1050 }, // end of Jan 5: 1000 + 50 (undo Jan 10)
      { date: '2026-01-10', balance: 1000 },
      { date: '2026-01-12', balance: 1500 },
      { date: '2026-01-15', balance: 1400 },
    ]);
  });

  it('moves a credit card balance up with charges and down with payments', () => {
    const snapshots = [{ accountId: 'c1', date: '2026-03-31', balance: 1500 }];
    const txs = [
      tx('2026-04-02', 100, 'debit', 'card'),
      tx('2026-04-05', 1500, 'credit', 'card'),
    ];
    expect(buildBalanceTimeline(card, snapshots, txs)).toEqual([
      { date: '2026-03-31', balance: 1500 },
      { date: '2026-04-02', balance: 1600 },
      { date: '2026-04-05', balance: 100 },
    ]);
  });

  it('fills gaps between snapshots and lets each snapshot reset the running balance', () => {
    const snapshots = [
      { accountId: 'a1', date: '2026-01-31', balance: 1000 },
      { accountId: 'a1', date: '2026-02-28', balance: 2000 },
    ];
    const txs = [tx('2026-02-10', 300, 'credit'), tx('2026-03-03', 100, 'debit')];
    expect(buildBalanceTimeline(checking, snapshots, txs)).toEqual([
      { date: '2026-01-31', balance: 1000 },
      { date: '2026-02-10', balance: 1300 },
      { date: '2026-02-28', balance: 2000 },
      { date: '2026-03-03', balance: 1900 },
    ]);
  });

  it('uses only snapshots for accounts without a linked bank profile', () => {
    const savings = { id: 's1', type: 'asset' };
    const snapshots = [{ accountId: 's1', date: '2026-01-31', balance: 5000 }];
    expect(buildBalanceTimeline(savings, snapshots, [tx('2026-02-01', 1, 'debit')])).toEqual([
      { date: '2026-01-31', balance: 5000 },
    ]);
  });
});

describe('buildNetWorthHistory', () => {
  const checking = { id: 'acct_1', type: 'asset' };
  const card = { id: 'acct_2', type: 'liability' };
  const timelines = {
    acct_1: [
      { date: '2024-06-03', balance: 20000 },
      { date: '2024-06-13', balance: 125000 }, // closing money gathered
      { date: '2024-06-14', balance: 5000 }, // cash to close wired out
      { date: '2024-08-03', balance: 6000 },
    ],
    acct_2: [{ date: '2024-06-10', balance: 1000 }],
  };
  const mortgages = {
    properties: [{ id: 'prop_1', purchaseDate: '2024-06-14', purchasePrice: 520000, estimatedValue: 500000 }],
    loans: [{ id: 'loan_1', closingDate: '2024-06-14', startDate: '2024-07-01', loanAmount: 400000, status: 'paid_off', payoffDate: '2024-09-15' }],
    payments: [
      { loanId: 'loan_1', date: '2024-08-02', forMonth: '2024-08', balanceAfter: 399000 },
      { loanId: 'loan_1', forMonth: '2024-09', balanceAfter: 398000 }, // no payment date: the 1st of the month
    ],
  };
  const history = buildNetWorthHistory([checking, card], timelines, mortgages);
  const at = (date) => history.find((r) => r.date === date);

  it('adds the house and its mortgage on the closing day, not the start of the month', () => {
    expect(at('2024-06-10')).toEqual({ date: '2024-06-10', assets: 20000, liabilities: 1000, netWorth: 19000 });
    expect(at('2024-06-13').netWorth).toBe(124000);
    expect(at('2024-06-14')).toEqual({ date: '2024-06-14', assets: 505000, liabilities: 401000, netWorth: 104000 });
    expect(history.map((r) => r.date)).not.toContain('2024-06');
  });

  it('follows mortgage payments on their dates and a payoff', () => {
    expect(at('2024-08-02').liabilities).toBe(400000);
    expect(at('2024-08-02').netWorth).toBe(500000 + 5000 - 1000 - 399000);
    expect(at('2024-09-01').netWorth).toBe(500000 + 6000 - 1000 - 398000);
    expect(at('2024-09-15').liabilities).toBe(1000);
  });

  it('swaps the loans of a refinance on one day, never owing both', () => {
    const accounts = [{ id: 'acct_1', type: 'asset' }];
    const days = ['2024-11-01', '2024-11-04', '2024-11-06', '2024-11-08', '2024-11-12'].map((date) => ({ date, balance: 10000 }));
    const old = { id: 'loan_old', closingDate: '2024-01-10', loanAmount: 300000, status: 'paid_off', payoffDate: '2024-11-08' };
    const refi = { id: 'loan_new', closingDate: '2024-11-04', startDate: '2024-12-01', loanAmount: 290000, status: 'active', refinancesLoanId: 'loan_old' };
    const debt = (loans) => Object.fromEntries(buildNetWorthHistory(accounts, { acct_1: days }, { properties: [], loans, payments: [] })
      .filter((r) => r.date >= '2024-11-01').map((r) => [r.date, r.liabilities]));
    // Signed on the 4th, funded and the old loan paid off on the 8th
    expect(debt([old, refi])).toEqual({ '2024-11-01': 300000, '2024-11-04': 300000, '2024-11-06': 300000, '2024-11-08': 290000, '2024-11-12': 290000 });
    // Without a payoff date the old loan ends when the new one closes
    expect(debt([{ ...old, payoffDate: null }, refi])).toEqual({ '2024-11-01': 300000, '2024-11-04': 290000, '2024-11-06': 290000, '2024-11-08': 290000, '2024-11-12': 290000 });
  });

  it('counts a property without a purchase date from the start', () => {
    const rows = buildNetWorthHistory([checking], timelines, { properties: [{ estimatedValue: 300000 }], loans: [], payments: [] });
    expect(rows[0]).toEqual({ date: '2024-06-03', assets: 320000, liabilities: 0, netWorth: 320000 });
  });
});

describe('accounts that follow their transfers', () => {
  const move = (date, type, amount, name, importedFrom = 'checking') => ({ date, type, amount, name, importedFrom });
  const transactions = [
    move('2024-02-05', 'credit', 30000, 'MOBILE BANKING TRANSFER DEPOSIT 1111'), // savings → checking
    move('2024-02-20', 'debit', 5000, 'MOBILE BANKING TRANSFER WITHDRAWAL 1111'), // checking → savings
    move('2024-02-21', 'debit', 4000, 'ACME LOANS PAYMENT'),
    move('2024-03-10', 'debit', 1000, 'ACME LOANS PAYMENT'),
    move('2024-02-22', 'debit', 50, 'GROCER 21111'), // only matches at the start of a word
  ];
  const balances = (account, snapshots) => buildBalanceTimeline(account, snapshots, transactions).map((p) => [p.date, p.balance]);

  it('rebuilds an asset from moves recorded in the other accounts', () => {
    const savings = { id: 'acct_s', type: 'asset', transferKeywords: ['1111'] };
    // 10,000 at the end; 5,000 came in on Feb 20 (5,000 before); 30,000 went to checking on Feb 5 (35,000 before)
    expect(balances(savings, [{ accountId: 'acct_s', date: '2024-03-31', balance: 10000 }])).toEqual([
      ['2024-02-04', 35000], ['2024-02-05', 5000], ['2024-02-20', 10000], ['2024-03-31', 10000],
    ]);
  });

  it('pays down a followed liability', () => {
    const loan = { id: 'acct_l', type: 'liability', transferKeywords: ['acme loans'] };
    expect(balances(loan, [{ accountId: 'acct_l', date: '2024-03-31', balance: 0 }])).toEqual([
      ['2024-02-20', 5000], ['2024-02-21', 1000], ['2024-03-10', 0], ['2024-03-31', 0],
    ]);
  });

  it('makes a move between your own accounts cancel out in net worth', () => {
    const checking = { id: 'acct_c', type: 'asset', linkedBankProfile: 'checking' };
    const savings = { id: 'acct_s', type: 'asset', transferKeywords: ['1111'] };
    const snapshots = [{ accountId: 'acct_c', date: '2024-02-01', balance: 100 }, { accountId: 'acct_s', date: '2024-03-31', balance: 10000 }];
    const timelines = Object.fromEntries([checking, savings].map((a) => [a.id, buildBalanceTimeline(a, snapshots, transactions)]));
    const worth = Object.fromEntries(buildNetWorthHistory([checking, savings], timelines, { properties: [], loans: [], payments: [] })
      .map((r) => [r.date, r.netWorth]));
    expect(worth['2024-02-05']).toBe(worth['2024-02-04']); // the first move, from savings, changes nothing
    expect(worth['2024-02-20']).toBe(worth['2024-02-05']); // nor does the move back
    expect(worth['2024-02-22'] - worth['2024-02-20']).toBe(-4050); // real spending still shows
  });

  it('follows transfers linked to it one by one', () => {
    const linked = [
      { ...move('2024-02-06', 'credit', 700, 'ELECTRONIC DEPOSIT PAYAPP'), category: 'transfers', transferAccountId: 'acct_p' },
      { ...move('2024-02-07', 'credit', 300, 'ELECTRONIC DEPOSIT PAYAPP'), category: 'transfers' }, // not linked
      { ...move('2024-02-08', 'credit', 200, 'ELECTRONIC DEPOSIT PAYAPP'), category: 'other_income', transferAccountId: 'acct_p' }, // no longer a transfer
      { ...move('2024-02-09', 'credit', 100, 'ELECTRONIC DEPOSIT PAYAPP'), category: 'transfers', transferAccountId: 'acct_x' },
    ];
    expect(followedTransfers({ id: 'acct_p' }, linked).map((t) => t.date)).toEqual(['2024-02-06']);
    const other = { id: 'acct_p', type: 'asset' };
    expect(buildBalanceTimeline(other, [{ accountId: 'acct_p', date: '2024-03-01', balance: 0 }], linked).map((p) => [p.date, p.balance]))
      .toEqual([['2024-02-05', 700], ['2024-02-06', 0], ['2024-03-01', 0]]);
    // A loan's payment keywords (no account id) never pick up linked or unlinked transfers
    expect(followedTransfers({ transferKeywords: ['acme loans'] }, linked)).toEqual([]);
  });

  it('ignores the account\'s own linked transactions', () => {
    expect(followedTransfers({ linkedBankProfile: 'checking', transferKeywords: ['1111'] }, transactions)).toEqual([]);
    expect(followedTransfers({ transferKeywords: ['1111'] }, transactions).map((t) => t.date)).toEqual(['2024-02-05', '2024-02-20']);
  });
});

describe('a mortgage loan that follows its payments', () => {
  // 1.2% a year: a month's interest is 0.1% of the balance (120 on 120,000)
  const loan = { id: 'loan_1', closingDate: '2024-01-10', loanAmount: 130000, interestRate: 1.2, monthlyPI: 1000, paymentKeywords: ['acme servicing'] };
  const statement = { loanId: 'loan_1', date: '2024-05-01', forMonth: '2024-05', principal: 900, extraPrincipal: 0, interest: 100, escrow: 0, balanceAfter: 120000 };
  const pay = (date, amount, type = 'debit', name = 'ACME SERVICING PMT') => ({ date, amount, type, name, importedFrom: 'checking' });
  const points = (txs, payments = [statement], l = loan) => loanBalancePoints(l, payments, txs).map((p) => [p.date, p.balance, !!p.estimated]);

  it('lowers the balance after the latest statement: interest out of the scheduled payment, extra all principal', () => {
    expect(points([pay('2024-05-20', 500), pay('2024-06-01', 1000)])).toEqual([
      ['2024-01-10', 130000, false],
      ['2024-05-01', 120000, false],
      ['2024-05-20', 119500, true], // extra: all principal
      ['2024-06-01', 118619.5, true], // 1000 − 119.50 interest on 119,500
    ]);
  });

  it('counts a payment covering more than the schedule as the scheduled one plus extra', () => {
    expect(points([pay('2024-06-01', 3000)]).at(-1)).toEqual(['2024-06-01', 117120, true]);
  });

  it('ignores payments up to the statement, refunds, and non-matching names', () => {
    expect(points([pay('2024-04-20', 1000), pay('2024-05-01', 1000), pay('2024-05-25', 1000, 'credit'), pay('2024-05-26', 1000, 'debit', 'OTHER BANK')]))
      .toEqual([['2024-01-10', 130000, false], ['2024-05-01', 120000, false]]);
  });

  it("doesn't count the statement's own payment twice when the bank posts it a few days later", () => {
    expect(points([pay('2024-05-04', 1000), pay('2024-05-20', 500)]).slice(2)).toEqual([['2024-05-20', 119500, true]]);
    // Long after the statement, the same amount is a new payment
    expect(points([pay('2024-06-01', 1000)]).slice(2)).toEqual([['2024-06-01', 119120, true]]);
  });

  it('estimates from the loan amount when there is no statement yet', () => {
    expect(points([pay('2024-02-01', 1000)], [])).toEqual([['2024-01-10', 130000, false], ['2024-02-01', 129130, true]]);
  });

  it('follows nothing without keywords', () => {
    expect(points([pay('2024-06-01', 1000)], [statement], { ...loan, paymentKeywords: undefined })).toHaveLength(2);
  });

  it('feeds the net worth history and stops at a payoff', () => {
    const paidOff = { ...loan, status: 'paid_off', payoffDate: '2024-06-15' };
    const debt = (l) => Object.fromEntries(buildNetWorthHistory([], {}, { properties: [], loans: [l], payments: [statement] }, [pay('2024-06-01', 1000), pay('2024-06-20', 1000)])
      .map((r) => [r.date, r.liabilities]));
    expect(debt(loan)).toEqual({ '2024-01-10': 130000, '2024-05-01': 120000, '2024-06-01': 119120, '2024-06-20': 118239.12 });
    expect(debt(paidOff)).toEqual({ '2024-01-10': 130000, '2024-05-01': 120000, '2024-06-01': 119120, '2024-06-15': 0 });
  });
});

describe('transfers in transit', () => {
  const checking = { id: 'acct_c', type: 'asset', linkedBankProfile: 'checking' };
  const card = { id: 'acct_k', type: 'liability', linkedBankProfile: 'card' };
  const t = (date, type, amount, importedFrom, category = 'transfers', name = 'TRANSFER') => ({ date, type, amount, importedFrom, category, name });
  const holds = (txs, accounts = [checking, card]) => transfersInTransit(accounts, txs).map((h) => [h.accountId, h.from, h.to, h.delta]);

  it('holds back the side that posts first until the other side posts', () => {
    // The card shows the payment on the 6th, the bank takes the money on the 9th
    expect(holds([t('2024-03-06', 'credit', 800, 'card'), t('2024-03-09', 'debit', 800, 'checking')]))
      .toEqual([['acct_k', '2024-03-06', '2024-03-09', 800]]);
    expect(holds([t('2024-03-06', 'debit', 800, 'checking'), t('2024-03-08', 'credit', 800, 'card')]))
      .toEqual([['acct_c', '2024-03-06', '2024-03-08', 800]]);
  });

  it('pairs only transfers of the same amount, in two linked accounts, at most 5 days apart', () => {
    expect(holds([t('2024-03-06', 'credit', 800, 'card'), t('2024-03-09', 'debit', 801, 'checking')])).toEqual([]);
    expect(holds([t('2024-03-06', 'credit', 800, 'card'), t('2024-03-12', 'debit', 800, 'checking')])).toEqual([]);
    expect(holds([t('2024-03-06', 'credit', 800, 'card', 'refunds'), t('2024-03-09', 'debit', 800, 'checking')])).toEqual([]);
    expect(holds([t('2024-03-06', 'credit', 800, 'checking'), t('2024-03-09', 'debit', 800, 'checking')])).toEqual([]);
    expect(holds([t('2024-03-06', 'credit', 800, 'card'), t('2024-03-09', 'debit', 800, 'brokerage')])).toEqual([]);
  });

  it('pairs closest first, each move once, and same-day pairs need nothing', () => {
    expect(holds([
      t('2024-03-06', 'credit', 500, 'card'),
      t('2024-03-06', 'debit', 500, 'checking'), // same day as the first credit
      t('2024-03-08', 'credit', 500, 'card'),
      t('2024-03-10', 'debit', 500, 'checking'),
    ])).toEqual([['acct_k', '2024-03-08', '2024-03-10', 500]]);
  });

  it('leaves out moves a followed account accounts for', () => {
    const brokerage = { id: 'acct_b', type: 'asset', transferKeywords: ['acme invest'] };
    const txs = [t('2024-03-06', 'credit', 800, 'card'), t('2024-03-09', 'debit', 800, 'checking', 'transfers', 'ACME INVEST')];
    expect(holds(txs, [checking, card, brokerage])).toEqual([]);
  });

  it('keeps net worth flat while a card payment is in transit', () => {
    const txs = [t('2024-03-06', 'credit', 800, 'card'), t('2024-03-09', 'debit', 800, 'checking'), t('2024-03-10', 'debit', 50, 'checking', 'groceries')];
    const snapshots = [{ accountId: 'acct_c', date: '2024-03-01', balance: 5000 }, { accountId: 'acct_k', date: '2024-03-01', balance: 800 }];
    const timelines = Object.fromEntries([checking, card].map((a) => [a.id, buildBalanceTimeline(a, snapshots, txs)]));
    const worth = (transactions) => Object.fromEntries(buildNetWorthHistory([checking, card], timelines, { properties: [], loans: [], payments: [] }, transactions)
      .map((r) => [r.date, r.netWorth]));
    expect(worth(txs)).toEqual({ '2024-03-01': 4200, '2024-03-06': 4200, '2024-03-09': 4200, '2024-03-10': 4150 });
    expect(worth([])['2024-03-06']).toBe(5000); // without the pairing, the payment counts twice for three days
  });
});

describe('property value in the history', () => {
  const accounts = [];
  const value = (prop) => Object.fromEntries(buildNetWorthHistory(accounts, {}, { properties: [prop], loans: [], payments: [] }).map((r) => [r.date, r.assets]));

  it('counts the purchase price until a later estimate', () => {
    expect(value({ purchaseDate: '2024-04-01', purchasePrice: 300000, estimatedValue: 280000, estimatedValueDate: '2024-10-01' }))
      .toEqual({ '2024-04-01': 300000, '2024-10-01': 280000 });
  });

  it('uses the estimate from the purchase when it has no date', () => {
    expect(value({ purchaseDate: '2024-04-01', purchasePrice: 300000, estimatedValue: 280000 })).toEqual({ '2024-04-01': 280000 });
  });
});
