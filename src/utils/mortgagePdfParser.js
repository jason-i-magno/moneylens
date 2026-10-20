import * as pdfjsLib from 'pdfjs-dist';
import { addDays, addMonths } from './dates';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

function parseNum(str) {
  return parseFloat((str || '').replace(/[,$]/g, '')) || 0;
}

function parseMmDdYyyy(str) {
  const m = (str || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
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
function parseRocket(text) {
  const balance = text.match(/Principal\s*Balance:\*?\s*\$?([\d,]+\.\d{2})/i);
  const statementDate = text.match(/Statement\s*Date:\s*(\d{2}\/\d{2}\/\d{4})/);
  const loanNumber = text.match(/Loan\s*Number:\s*(\d+)/);
  const rate = text.match(/Interest\s*Rate:\s*([\d.]+)%/i);
  const dueDate = text.match(/Due\s*Date:\s*(\d{2})\/(\d{2})\/(\d{4})/);

  // Extract Last Paid principal and interest from Payment History
  // The text has "Principal: $X" and "Interest: $Y" after "Last Paid"
  const lastPaidSection = text.match(/Last\s*Paid[\s\S]*?Principal:\s*\$([\d,]+\.\d{2})[\s\S]*?Interest:\s*\$([\d,]+\.\d{2})/i);

  if (!lastPaidSection || !balance) return null;

  // "Amount Due" can include escrow, so the loan's own P&I is preferred when splitting
  // principal into scheduled vs. extra (see splitRocketPrincipal, applied after loan matching)
  const amountDue = text.match(/Amount\s*Due:\s*\$?([\d,]+\.\d{2})/);

  // forMonth: the month before the due date
  const forMonth = dueDate ? addMonths(`${dueDate[3]}-${dueDate[1]}`, -1) : null;

  // Payment date: first of the forMonth (approximation)
  const payDate = forMonth ? `${forMonth}-01` : null;

  return {
    statementDate: statementDate ? parseMmDdYyyy(statementDate[1]) : null,
    loanNumber: loanNumber ? loanNumber[1] : null,
    balanceAfter: parseNum(balance[1]),
    interestRate: rate ? parseFloat(rate[1]) : null,
    amountDue: amountDue ? parseNum(amountDue[1]) : null,
    payment: {
      date: payDate,
      forMonth,
      principal: parseNum(lastPaidSection[1]), // total principal until split
      interest: parseNum(lastPaidSection[2]),
      extraPrincipal: 0,
      balanceAfter: parseNum(balance[1]),
      statementDate: statementDate ? parseMmDdYyyy(statementDate[1]) : null,
      escrow: 0,
    },
  };
}

// Rocket reports one principal figure; anything above the scheduled principal is extra
export function splitRocketPrincipal(payment, monthlyPI) {
  if (!monthlyPI) return payment;
  const scheduled = Math.round((monthlyPI - payment.interest) * 100) / 100;
  if (scheduled <= 0 || scheduled > payment.principal) return payment;
  return {
    ...payment,
    principal: scheduled,
    extraPrincipal: Math.round((payment.principal - scheduled) * 100) / 100,
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

      if (!parsed) {
        results.push({ fileName: file.name, servicer, parsed: false, payment: null, loanId: null, isDuplicate: false });
        continue;
      }

      // Match to existing loan by loan number or servicer type
      let loanId = null;
      if (parsed.loanNumber) {
        const match = existingLoans.find((l) => l.loanNumber === parsed.loanNumber);
        if (match) loanId = match.id;
      }
      if (!loanId) {
        const match = existingLoans.find((l) => l.servicerType === servicer);
        if (match) loanId = match.id;
      }

      const loan = existingLoans.find((l) => l.id === loanId);
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
        isDuplicate,
      });
    } catch {
      results.push({ fileName: file.name, servicer: 'unknown', parsed: false, payment: null, loanId: null, isDuplicate: false });
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

  const MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
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
