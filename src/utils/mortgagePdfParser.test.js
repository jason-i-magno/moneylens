import { describe, it, expect, vi } from 'vitest';

// Each fake PDF's text is its file "name", returned as a single page of text
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: ({ data }) => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({ getTextContent: async () => ({ items: [{ str: new TextDecoder().decode(data) }] }) }),
    }),
  }),
}));

const { parseMortgagePdfs, parseBankStatementPdfs, splitRocketPrincipal } = await import('./mortgagePdfParser');

const fakeFile = (name, text) => ({ name, arrayBuffer: async () => new TextEncoder().encode(text).buffer });

const rocketStatement = (dueDate) => [
  'Rocket Mortgage Statement Date: 04/05/2026 Loan Number: 1234567890',
  `Interest Rate: 6.5% Due Date: ${dueDate} Amount Due: $4,900.00`,
  'Principal Balance: $500,000.00 Last Paid Principal: $1,500.00 Interest: $2,700.00',
].join(' ');

const rocketLoan = { id: 'loan_r', loanNumber: '1234567890', servicerType: 'rocket', monthlyPI: 3500 };

describe('splitRocketPrincipal', () => {
  it("splits principal using the loan's P&I", () => {
    expect(splitRocketPrincipal({ principal: 1500, interest: 2700, extraPrincipal: 0 }, 3500))
      .toMatchObject({ principal: 800, extraPrincipal: 700 });
  });

  it('leaves the payment alone when the P&I would exceed what was paid', () => {
    expect(splitRocketPrincipal({ principal: 1000, interest: 2700, extraPrincipal: 0 }, 4900))
      .toMatchObject({ principal: 1000, extraPrincipal: 0 });
  });
});

describe('parseMortgagePdfs', () => {
  it("uses the matched loan's P&I instead of Amount Due (which can include escrow)", async () => {
    const [result] = await parseMortgagePdfs([fakeFile('apr.pdf', rocketStatement('05/01/2026'))], [rocketLoan]);
    expect(result.loanId).toBe('loan_r');
    expect(result.payment).toMatchObject({ forMonth: '2026-04', principal: 800, extraPrincipal: 700, balanceAfter: 500000 });
  });

  it('computes forMonth across a year boundary', async () => {
    const [result] = await parseMortgagePdfs([fakeFile('dec.pdf', rocketStatement('01/01/2027'))], [rocketLoan]);
    expect(result.payment.forMonth).toBe('2026-12');
  });

  it('flags statements already imported or repeated in the same upload', async () => {
    const files = [
      fakeFile('apr.pdf', rocketStatement('05/01/2026')),
      fakeFile('may.pdf', rocketStatement('06/01/2026')),
      fakeFile('may-again.pdf', rocketStatement('06/01/2026')),
    ];
    const existing = [{ loanId: 'loan_r', forMonth: '2026-04' }];
    const results = await parseMortgagePdfs(files, [rocketLoan], existing);
    expect(results.map((r) => r.isDuplicate)).toEqual([true, false, true]);
  });
});

describe('parseBankStatementPdfs', () => {
  it('dates the beginning balance as end-of-day before the period starts', async () => {
    const text = 'U.S. Bank Uni-Statement Account Number 1-234-5678-9012 CHECKING '
      + 'Statement Period: Mar 1, 2026 through Mar 31, 2026 '
      + 'Beginning Balance on Mar 1 $1,000.00 Ending Balance on Mar 31, 2026 $1,250.00';
    const [result] = await parseBankStatementPdfs([fakeFile('march.pdf', text)]);
    expect(result.beginSnapshot).toEqual({ date: '2026-02-28', balance: 1000 });
    expect(result.snapshot).toEqual({ date: '2026-03-31', balance: 1250 });
  });
});
