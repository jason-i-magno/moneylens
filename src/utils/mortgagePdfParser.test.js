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

// With the Payment History totals and the Loan Activity rows
const rocketWithActivity = [
  'Rocket Mortgage Statement Date: 04/05/2026 Loan Number: 1234567890 Interest Rate: 6.5% Due Date: 05/01/2026 Amount Due: $3,500.00',
  'Principal Balance:* $500,000.00 Payment History (03/06/2026 - 04/05/2026) Last Paid Principal: $1,800.00 Interest: $2,700.00',
  'Escrow (Tax & Insurance): $0.00 Fees: $0.00 Total Paid: $4,500.00 Paid Year To Date Principal: $3,000.00 Total Paid Year To Date: $9,000.00',
  'Loan Activity From 03/06/2026 To 04/05/2026 § Date Description Charges Escrow Unapplied Payments',
  '03/10/26 Principal Payment Applied $500.00 03/28/26 Payment Received $3,500.00 04/02/26 Principal Payment Applied $500.00',
].join(' ');

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
    expect(result.payment).toMatchObject({ date: '2026-04-01' }); // no activity rows: the first of the month
    expect(result.payment.activity).toBeUndefined();
  });

  it("reads Rocket's dated payments: principal payments are extra, the regular one pays the interest", async () => {
    const [result] = await parseMortgagePdfs([fakeFile('apr.pdf', rocketWithActivity)], [rocketLoan]);
    expect(result.payment).toMatchObject({
      date: '2026-03-28', // the regular payment
      forMonth: '2026-04',
      principal: 800,
      interest: 2700,
      extraPrincipal: 1000,
      statementDate: '2026-04-05',
      activity: [{ date: '2026-03-10', principal: 500, amount: 500 }, { date: '2026-03-28', principal: 800, amount: 3500 }, { date: '2026-04-02', principal: 500, amount: 500 }],
    });
  });

  it("matches a loan through a past servicer's loan number, before another loan's servicer type", async () => {
    const other = { id: 'loan_other', loanNumber: '5555555555', servicerType: 'rocket' };
    const transferred = { id: 'loan_t', loanNumber: '9876543210', servicerType: 'valon', pastServicers: [{ servicer: 'Rocket', servicerType: 'rocket', loanNumber: '1234567890', until: '2026-06-01' }] };
    const [result] = await parseMortgagePdfs([fakeFile('apr.pdf', rocketStatement('05/01/2026'))], [other, transferred]);
    expect(result.loanId).toBe('loan_t');
    const [byType] = await parseMortgagePdfs([fakeFile('apr.pdf', rocketStatement('05/01/2026'))], [{ ...transferred, pastServicers: [{ servicerType: 'rocket', until: '2026-06-01' }] }]);
    expect(byType.loanId).toBe('loan_t');
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

// Valon's layout (Carrington's statements use it too), as the PDF text comes out: columns padded with
// spaces, and an "Additional Principal" line that can land on the next page
const ROW = (date, principal, interest, escrow, total) => `${date}   Payment (ACH via online) $${principal}   $${interest}   $${escrow}   $0.00   $0.00   $0.00   $${total}`;
const valonStatement = ({ brand = 'Visit www.valon.com for the most up-to-date information.', rows, breakdown = ['1,200.00', '1,000.00', '100.00'] } = {}) => [
  'Statement Date   May 3, 2024  Borrower   Pat Doe  Loan Number   9876543210  Payment Due Date   June 1, 2024  Amount Due   $1,800.00',
  `Mortgage Billing Statement  ${brand}  Explanation of Amount Due  Principal   $705.00 Interest   $995.00`,
  'Account Information  Principal Balance (Interest- Bearing) $198,000.00 Interest Rate   6% Escrow Balance   $400.00',
  `Past Payments Breakdown Allocated to   Since Last Statement   Year to Date  Principal   $${breakdown[0]}   $5,000.00 Interest   $${breakdown[1]}   $4,000.00 Escrow   $${breakdown[2]}   $400.00 Fees   $0.00   $0.00`,
  'Statement Activity for April 4, 2024 - May 3, 2024 Effective Date Description   Principal   Interest   Escrow   Fees Paid   Unapplied   Fees Charged Total',
  rows ?? `${ROW('04/27/24', '700.00', '1,000.00', '100.00', '1,800.00')} ${ROW('04/10/24', '500.00', '0.00', '0.00', '500.00')}`,
  '\nEffective Date Description   Principal   Interest   Escrow   Fees Paid   Unapplied   Fees Charged Total',
  rows === undefined ? 'Additional Principal   $500.00   -   -   -   -   -   -' : '',
  'Payment Options  Additional Principal Additional Escrow  Total Amount  $ ________ $ ________',
].join(' ');

describe('Valon / Carrington statements', () => {
  const loan = { id: 'loan_v', loanNumber: '9876543210', servicerType: 'valon', monthlyPI: 1700 };

  it("reads the regular payment, the extra principal and each payment's date", async () => {
    const [result] = await parseMortgagePdfs([fakeFile('may.pdf', valonStatement())], [loan]);
    expect(result).toMatchObject({ servicer: 'valon', parsed: true, loanId: 'loan_v' });
    expect(result.payment).toEqual({
      date: '2024-04-27', // the regular payment
      forMonth: '2024-05', // the installment paid: the month before the next due date
      principal: 700,
      interest: 1000,
      extraPrincipal: 500,
      escrow: 100,
      balanceAfter: 198000,
      statementDate: '2024-05-03',
      activity: [{ date: '2024-04-10', principal: 500, amount: 500 }, { date: '2024-04-27', principal: 700, amount: 1800 }],
    });
  });

  it("reads Carrington's statements, even when they mention Lakeview and LoanCare", async () => {
    const brand = 'Visit myloan.servicedbycarrington.com/lakeview. Your loan was previously serviced by LoanCare.';
    // Extra principal paid after the regular payment: the payment's date stays the regular one's
    const rows = `${ROW('04/29/24', '500.00', '0.00', '0.00', '500.00')} Additional Principal   $500.00 ${ROW('04/27/24', '700.00', '1,000.00', '100.00', '1,800.00')}`;
    const [result] = await parseMortgagePdfs([fakeFile('may.pdf', valonStatement({ brand, rows }))], [loan]);
    expect(result).toMatchObject({ servicer: 'valon', parsed: true, payment: { date: '2024-04-27', principal: 700, extraPrincipal: 500 } });
  });

  it('says when a statement lists no payments', async () => {
    const text = valonStatement({ rows: 'There were no activities between April 4, 2024 and May 3, 2024.', breakdown: ['0.00', '0.00', '0.00'] });
    const [result] = await parseMortgagePdfs([fakeFile('first.pdf', text)], [loan]);
    expect(result).toMatchObject({ servicer: 'valon', parsed: false, noPayments: true, error: 'No payments on this statement' });
  });

  it("takes the totals from the breakdown and leaves out the dates when a row didn't read", async () => {
    const rows = `${ROW('04/27/24', '700.00', '1,000.00', '100.00', '1,800.00')} Additional Principal   $500.00`;
    const [result] = await parseMortgagePdfs([fakeFile('may.pdf', valonStatement({ rows }))], [loan]);
    expect(result.payment).toMatchObject({ principal: 700, extraPrincipal: 500, interest: 1000 });
    expect(result.payment.activity).toBeUndefined();
  });

  it('reports the loan number when no loan matches, and names unrecognized PDFs', async () => {
    const results = await parseMortgagePdfs([fakeFile('may.pdf', valonStatement()), fakeFile('other.pdf', 'Some other bank')], []);
    expect(results[0]).toMatchObject({ parsed: true, loanId: null, loanNumber: '9876543210' });
    expect(results[1]).toMatchObject({ parsed: false, error: 'Unrecognized statement' });
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
