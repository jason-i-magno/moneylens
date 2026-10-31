import * as pdfjsLib from 'pdfjs-dist';
import { addDays, addMonths } from './dates';
import { roundCents } from './transactions';
import { loanServicers } from './mortgageCalculations';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

function parseNum(str) {
  return parseFloat((str || '').replace(/[,$]/g, '')) || 0;
}

// MM/DD/YYYY or MM/DD/YY
function parseMmDdYyyy(str) {
  const m = (str || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})/);
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

// "May 3, 2026"
function parseMonthDayYear(str) {
  const m = (str || '').match(/([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/);
  const month = m && MONTHS[m[1].toLowerCase().slice(0, 3)];
  return month ? `${m[3]}-${month}-${m[2].padStart(2, '0')}` : null;
}

// ─── Text extraction ───
async function extractText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    fullText += content.items.map((item) => item.str).join(' ') + '\n';
  }
  return fullText;
}

// ─── Servicer detection ───
function detectServicer(text) {
  // Carrington statements use Valon's layout (and can mention Lakeview, so this check comes first)
  if (/Valon|Carrington/i.test(text) && /Past\s*Payments\s*Breakdown/i.test(text)) return 'valon';
  if (/Lakeview/i.test(text) && /LoanCare/i.test(text)) return 'lakeview';
  if (/Rocket\s*Mortgage/i.test(text)) return 'rocket';
  return 'unknown';
}

// ─── Lakeview parser ───
function parseLakeview(text) {
  const balance = text.match(/Outstanding\s*Principal\s*Balance\s*\$?([\d,]+\.?\d*)/i);
  const statementDate = text.match(/Statement\s*Date\s*(\d{2}\/\d{2}\/\d{4})/);
  const loanNumber = text.match(/Loan\s*Number\s*(\d+)/);
  const rate = text.match(/Interest\s*Rate\s*([\d.]+)%/);

  // Parse regular payment rows from Transaction Activity
  // Format: MM/DD/YYYY MM/YYYY [Pp]ayment ... $total $principal $interest
  const paymentRows = [];
  const paymentRegex = /(\d{2}\/\d{2}\/\d{4})\s+(\d{2})\/(\d{4})\s+.*?(?:[Pp]ayment|ayment).*?\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})/g;
  let match;
  while ((match = paymentRegex.exec(text)) !== null) {
    paymentRows.push({
      date: parseMmDdYyyy(match[1]),
      forMonth: `${match[3]}-${match[2]}`,
      total: parseNum(match[4]),
      principal: parseNum(match[5]),
      interest: parseNum(match[6]),
    });
  }

  // Parse extra principal payment rows
  const extraRows = [];
  const extraRegex = /(\d{2}\/\d{2}\/\d{4})\s+Additional\s*Principal\s*Payment\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})/gi;
  while ((match = extraRegex.exec(text)) !== null) {
    extraRows.push({
      date: parseMmDdYyyy(match[1]),
      amount: parseNum(match[3]),
    });
  }

  if (paymentRows.length === 0) return null;

  // Take the primary payment row (use the last one if multiple regular payments)
  const primary = paymentRows[paymentRows.length - 1];
  const totalExtra = extraRows.reduce((s, r) => s + r.amount, 0);

  return {
    statementDate: statementDate ? parseMmDdYyyy(statementDate[1]) : null,
    loanNumber: loanNumber ? loanNumber[1] : null,
    balanceAfter: balance ? parseNum(balance[1]) : 0,
    interestRate: rate ? parseFloat(rate[1]) : null,
    payment: {
      date: primary.date,
      forMonth: primary.forMonth,
      principal: primary.principal,
      interest: primary.interest,
      extraPrincipal: totalExtra,
      balanceAfter: balance ? parseNum(balance[1]) : 0,
      statementDate: statementDate ? parseMmDdYyyy(statementDate[1]) : null,
      escrow: 0,
    },
  };
}

// ─── Rocket parser ───
// "Payment History" totals the statement period under "Last Paid"; "Loan Activity" lists each payment
// with its date: "Principal Payment Applied" is all principal, "Payment Received" is the regular payment
function parseRocket(text) {
  const balance = text.match(/Principal\s*Balance:\*?\s*\$?([\d,]+\.\d{2})/i);
  const statementDate = text.match(/Statement\s*Date:\s*(\d{2}\/\d{2}\/\d{4})/);
  const loanNumber = text.match(/Loan\s*Number:\s*(\d+)/);
  const rate = text.match(/Interest\s*Rate:\s*([\d.]+)%/i);
  const dueDate = text.match(/Due\s*Date:\s*(\d{2})\/(\d{2})\/(\d{4})/);

  // Extract Last Paid principal and interest from Payment History
  // The text has "Principal: $X" and "Interest: $Y" after "Last Paid"
  const lastPaidSection = text.match(/Last\s*Paid[\s\S]*?Principal:\s*\$([\d,]+\.\d{2})[\s\S]*?Interest:\s*\$([\d,]+\.\d{2})/i);
  const lastPaidEscrow = text.match(/Last\s*Paid[\s\S]*?Escrow[^:$]*:\s*\$([\d,]+\.\d{2})/i);
  const totalPaid = text.match(/Last\s*Paid[\s\S]*?Total\s*Paid:\s*\$([\d,]+\.\d{2})/i);

  if (!lastPaidSection || !balance) return null;

  // "Amount Due" can include escrow, so the loan's own P&I is preferred when splitting
  // principal into scheduled vs. extra (see splitRocketPrincipal, applied after loan matching)
  const amountDue = text.match(/Amount\s*Due:\s*\$?([\d,]+\.\d{2})/);

  // forMonth: the month before the due date
  const forMonth = dueDate ? addMonths(`${dueDate[3]}-${dueDate[1]}`, -1) : null;

  // Each payment's principal: all of a principal payment; what's left of a regular payment after the
  // period's interest, escrow and fees. Used only when the rows add up to the period's Total Paid.
  const principal = parseNum(lastPaidSection[1]);
  const rows = [...text.matchAll(/(\d{2}\/\d{2}\/\d{2,4})\s+(Principal\s+Payment\s+Applied|Payment\s+Received)\s+\$([\d,]+\.\d{2})/gi)]
    .map((m) => ({ date: parseMmDdYyyy(m[1]), extra: /^Principal/i.test(m[2]), amount: parseNum(m[3]) }))
    .sort((a, b) => a.date.localeCompare(b.date));
  let notPrincipal = totalPaid ? roundCents(parseNum(totalPaid[1]) - principal) : 0;
  const activity = rows.map((r) => {
    const share = r.extra ? 0 : Math.min(r.amount, notPrincipal);
    notPrincipal = roundCents(notPrincipal - share);
    return { date: r.date, principal: roundCents(r.amount - share), amount: r.amount };
  });
  const complete = Boolean(totalPaid) && rows.length > 0 && Math.abs(notPrincipal) < 0.005
    && Math.abs(activity.reduce((sum, a) => sum + a.principal, 0) - principal) < 0.005;
  const extra = complete ? roundCents(rows.filter((r) => r.extra).reduce((sum, r) => sum + r.amount, 0)) : 0;
  const regular = rows.filter((r) => !r.extra).at(-1);

  return {
    statementDate: statementDate ? parseMmDdYyyy(statementDate[1]) : null,
    loanNumber: loanNumber ? loanNumber[1] : null,
    balanceAfter: parseNum(balance[1]),
    interestRate: rate ? parseFloat(rate[1]) : null,
    amountDue: amountDue ? parseNum(amountDue[1]) : null,
    payment: {
      // The regular payment's date; without the rows, the first of the forMonth (approximation)
      date: complete && regular ? regular.date : forMonth ? `${forMonth}-01` : null,
      forMonth,
      principal: roundCents(principal - extra), // without the rows, the total principal until split
      interest: parseNum(lastPaidSection[2]),
      extraPrincipal: extra,
      balanceAfter: parseNum(balance[1]),
      statementDate: statementDate ? parseMmDdYyyy(statementDate[1]) : null,
      escrow: lastPaidEscrow ? parseNum(lastPaidEscrow[1]) : 0,
      ...(complete && { activity: activity.filter((a) => a.principal !== 0) }),
    },
  };
}

// ─── Valon / Carrington parser ───
// Statement Activity rows: MM/DD/YY description, then principal, interest, escrow, fees paid, unapplied,
// fees charged and total. An "Additional Principal $X" line marks a payment's extra principal; it can land
// on the next page. "Past Payments Breakdown" totals the period ("Since Last Statement").
const AMOUNT = '(-?\\$[\\d,]+\\.\\d{2})';
const ACTIVITY_ROW = new RegExp(`(\\d{2}\\/\\d{2}\\/\\d{2,4})\\s+[^$]*?${Array(7).fill(AMOUNT).join('\\s+')}`, 'g');

function parseValon(text) {
  const balance = text.match(/Principal\s*Balance\s*(?:\([^)]*\))?\s*\$([\d,]+\.\d{2})/i);
  const statementDate = text.match(/Statement\s*Date\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/);
  const dueDate = text.match(/Payment\s*Due\s*Date\s+([A-Za-z]+\s+\d{1,2},\s*\d{4})/);
  const loanNumber = text.match(/Loan\s*Number\s+(\d+)/);
  const rate = text.match(/Interest\s*Rate\s+([\d.]+)%/i);
  const breakdown = text.match(/Since\s*Last\s*Statement\s*Year\s*to\s*Date\s*Principal\s*(-?\$[\d,]+\.\d{2})\s+\S+\s*Interest\s*(-?\$[\d,]+\.\d{2})\s+\S+\s*Escrow\s*(-?\$[\d,]+\.\d{2})/i);
  const due = dueDate && parseMonthDayYear(dueDate[1]);
  if (!balance || !due) return null;

  const rows = [...text.matchAll(ACTIVITY_ROW)].map((m) => ({
    date: parseMmDdYyyy(m[1]),
    principal: parseNum(m[2]),
    interest: parseNum(m[3]),
    escrow: parseNum(m[4]),
    total: parseNum(m[8]),
  }));
  const extra = [...text.matchAll(/Additional\s+Principal\s+\$([\d,]+\.\d{2})/g)].reduce((s, m) => s + parseNum(m[1]), 0);
  const sum = (key) => roundCents(rows.reduce((s, r) => s + r[key], 0));

  // The breakdown is the period's total; the rows give the dates (unless one of them didn't read)
  const principal = breakdown ? parseNum(breakdown[1]) : sum('principal');
  const interest = breakdown ? parseNum(breakdown[2]) : sum('interest');
  const escrow = breakdown ? parseNum(breakdown[3]) : sum('escrow');
  const rowsComplete = rows.length > 0 && Math.abs(sum('principal') - principal) < 0.005;

  const parsedStatementDate = statementDate ? parseMonthDayYear(statementDate[1]) : null;
  const result = {
    statementDate: parsedStatementDate,
    loanNumber: loanNumber ? loanNumber[1] : null,
    balanceAfter: parseNum(balance[1]),
    interestRate: rate ? parseFloat(rate[1]) : null,
    payment: null,
  };
  if (principal === 0 && interest === 0 && escrow === 0) return result; // no payments this period

  // The regular payment's date (the one that paid interest), else the latest payment's
  const byDate = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const regular = byDate.filter((r) => r.interest > 0).at(-1) || byDate.at(-1);
  return {
    ...result,
    payment: {
      date: regular?.date || parsedStatementDate,
      forMonth: addMonths(due.slice(0, 7), -1), // the installment paid: the month before the next due date
      principal: roundCents(principal - extra),
      interest,
      extraPrincipal: roundCents(extra),
      escrow,
      balanceAfter: parseNum(balance[1]),
      statementDate: parsedStatementDate,
      ...(rowsComplete && { activity: byDate.filter((r) => r.principal !== 0).map((r) => ({ date: r.date, principal: r.principal, amount: r.total })) }),
    },
  };
}

// Rocket reports one principal figure for the regular payments; anything above the scheduled principal is
// extra (added to the principal payments already counted as extra)
export function splitRocketPrincipal(payment, monthlyPI) {
  if (!monthlyPI) return payment;
  const scheduled = roundCents(monthlyPI - payment.interest);
  if (scheduled <= 0 || scheduled > payment.principal) return payment;
  return {
    ...payment,
    principal: scheduled,
    extraPrincipal: roundCents((payment.extraPrincipal || 0) + payment.principal - scheduled),
  };
}

// ─── Main entry point ───
export async function parseMortgagePdfs(files, existingLoans, existingPayments = []) {
  const results = [];
  const seen = new Set(existingPayments.map((p) => `${p.loanId}|${p.forMonth}`));

  for (const file of files) {
    try {
      const text = await extractText(file);
      const servicer = detectServicer(text);

      let parsed = null;
      if (servicer === 'lakeview') parsed = parseLakeview(text);
      else if (servicer === 'rocket') parsed = parseRocket(text);
      else if (servicer === 'valon') parsed = parseValon(text);

      if (!parsed?.payment) {
        // A statement can be readable but list no payments (e.g. the first one after a servicing transfer)
        const error = parsed ? 'No payments on this statement' : servicer === 'unknown' ? 'Unrecognized statement' : 'Could not read the payment';
        results.push({ fileName: file.name, servicer, parsed: false, noPayments: Boolean(parsed), error, payment: null, loanId: null, isDuplicate: false });
        continue;
      }

      // Match to existing loan by loan number, then servicer type: the current servicer's first, then a past
      // one's (a loan keeps its servicers through a servicing transfer)
      const loan = (parsed.loanNumber && existingLoans.find((l) => loanServicers(l).some((s) => s.loanNumber === parsed.loanNumber)))
        || existingLoans.find((l) => l.servicerType === servicer)
        || existingLoans.find((l) => loanServicers(l).some((s) => s.servicerType === servicer));
      const loanId = loan?.id || null;

      const payment = servicer === 'rocket'
        ? splitRocketPrincipal(parsed.payment, loan?.monthlyPI || parsed.amountDue)
        : parsed.payment;

      // Already imported, or the same statement twice in this upload
      const key = `${loanId}|${payment.forMonth}`;
      const isDuplicate = Boolean(loanId) && seen.has(key);
      if (loanId) seen.add(key);

      results.push({
        fileName: file.name,
        servicer,
        parsed: true,
        payment,
        loanId,
        loanNumber: parsed.loanNumber,
        isDuplicate,
      });
    } catch {
      results.push({ fileName: file.name, servicer: 'unknown', parsed: false, error: 'Could not read the PDF', payment: null, loanId: null, isDuplicate: false });
    }
  }

  return results;
}

// ─── Bank Statement Parsers ───

function detectBankType(text) {
  if (/U\.?S\.?\s*Bank/i.test(text) && /Uni-Statement/i.test(text)) return 'usbank';
  return 'unknown';
}

function parseUSBankStatement(text) {
  // Try multiple patterns — PDF text extraction varies in spacing
  const endingBalance = text.match(/Ending\s+Balance\s+on\s+(\w+)\s+(\d{1,2}),?\s+(\d{4})\s*\$?\s*([\d,]+\.\d{2})/i);
  const beginningBalance = text.match(/Beginning\s+Balance\s+on\s+(\w+)\s+(\d{1,2})\s*\$?\s*([\d,]+\.\d{2})/i);
  const accountNumber = text.match(/Account\s*Number[:\s]*[\d\s-]*(\d{4})/i);
  const statementPeriod = text.match(/Statement\s*Period:\s*(\w+\s+\d{1,2},?\s+\d{4})\s*through\s*(\w+\s+\d{1,2},?\s+\d{4})/i);
  // Also try the account number from "Account Number 1-234-5678-9012" format
  const accountNumberAlt = text.match(/(\d{4})\s*$/m) || text.match(/\d+-\d+-\d+-(\d{4})/);

  if (!endingBalance) return null;

  const monthStr = MONTHS[endingBalance[1].toLowerCase().slice(0, 3)] || '01';
  const endDate = `${endingBalance[3]}-${monthStr}-${endingBalance[2].padStart(2, '0')}`;

  // Snapshots are end-of-day balances. The beginning balance is the balance before the first
  // day's activity, i.e. the end-of-day balance of the day before the period starts.
  let beginDate = null;
  if (beginningBalance) {
    const bMonth = MONTHS[beginningBalance[1].toLowerCase().slice(0, 3)] || '01';
    // Beginning balance year comes from statement period
    const bYear = statementPeriod ? statementPeriod[1].match(/\d{4}/)?.[0] : endingBalance[3];
    beginDate = addDays(`${bYear}-${bMonth}-${beginningBalance[2].padStart(2, '0')}`, -1);
  }

  // Detect account type from text
  let accountType = 'checking';
  if (/CHECKING/i.test(text)) accountType = 'checking';
  else if (/SAVINGS/i.test(text)) accountType = 'savings';

  return {
    bank: 'usbank',
    accountType,
    accountSuffix: accountNumber ? accountNumber[1] : (accountNumberAlt ? accountNumberAlt[1] : null),
    endDate,
    endBalance: parseNum(endingBalance[4]),
    beginDate,
    beginBalance: beginningBalance ? parseNum(beginningBalance[3]) : null,
  };
}

export async function parseBankStatementPdfs(files) {
  const results = [];

  for (const file of files) {
    try {
      const text = await extractText(file);
      const bankType = detectBankType(text);

      let parsed = null;
      if (bankType === 'usbank') parsed = parseUSBankStatement(text);

      if (!parsed) {
        results.push({ fileName: file.name, bank: bankType, parsed: false, snapshot: null, error: bankType === 'unknown' ? 'Unrecognized bank statement format' : 'Could not extract balance' });
        continue;
      }

      const accountName = `US Bank ${parsed.accountType.charAt(0).toUpperCase() + parsed.accountType.slice(1)}${parsed.accountSuffix ? ` ${parsed.accountSuffix}` : ''}`;

      results.push({
        fileName: file.name,
        bank: parsed.bank,
        parsed: true,
        accountName,
        snapshot: {
          date: parsed.endDate,
          balance: parsed.endBalance,
        },
        beginSnapshot: parsed.beginDate && parsed.beginBalance !== null ? {
          date: parsed.beginDate,
          balance: parsed.beginBalance,
        } : null,
      });
    } catch (err) {
      results.push({ fileName: file.name, bank: 'unknown', parsed: false, snapshot: null, error: err.message || 'Unknown error' });
    }
  }

  return results;
}
