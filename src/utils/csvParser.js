import Papa from 'papaparse';

const DATE_FORMATS = [
  { label: 'MM/DD/YYYY', regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, parse: (m) => `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` },
  { label: 'YYYY-MM-DD', regex: /^(\d{4})-(\d{2})-(\d{2})$/, parse: (m) => `${m[1]}-${m[2]}-${m[3]}` },
  { label: 'MM-DD-YYYY', regex: /^(\d{1,2})-(\d{1,2})-(\d{4})$/, parse: (m) => `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` },
  { label: 'DD/MM/YYYY', regex: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/, parse: (m) => `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` },
];

export function parseCSVFile(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => resolve(results),
      error: (err) => reject(err),
    });
  });
}

// samples: values from the mapped date column
export function detectDateFormat(samples) {
  const values = samples.map((s) => (s || '').trim()).filter(Boolean);
  if (values.length === 0) return 'MM/DD/YYYY';

  const slashed = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;
  if (values.every((v) => slashed.test(v))) {
    // MM/DD and DD/MM share a shape; a first number over 12 can only be a day
    const firstOver12 = values.some((v) => Number(v.match(slashed)[1]) > 12);
    return firstOver12 ? 'DD/MM/YYYY' : 'MM/DD/YYYY';
  }

  for (const fmt of DATE_FORMATS) {
    if (values.every((v) => fmt.regex.test(v))) {
      return fmt.label;
    }
  }
  return 'MM/DD/YYYY';
}

export function parseDate(dateStr, format) {
  const fmt = DATE_FORMATS.find((f) => f.label === format) || DATE_FORMATS[0];
  const match = dateStr.trim().match(fmt.regex);
  if (!match) return null;
  return fmt.parse(match);
}

export function parseAmount(row, config) {
  const { amountColumn, amountFormat, debitColumn, creditColumn } = config;

  if (amountFormat === 'two_columns') {
    const debit = parseFloat((row[debitColumn] || '').replace(/[,$]/g, '')) || 0;
    const credit = parseFloat((row[creditColumn] || '').replace(/[,$]/g, '')) || 0;
    return { amount: debit || credit, isDebit: debit > 0 };
  }

  const raw = parseFloat((row[amountColumn] || '').replace(/[,$]/g, '')) || 0;

  if (amountFormat === 'negative_is_debit') {
    return { amount: Math.abs(raw), isDebit: raw < 0 };
  }
  // positive_is_debit
  return { amount: Math.abs(raw), isDebit: raw > 0 };
}

// "$1,234.50" → 1234.5, "(25)" → -25; null when it isn't a number
function parseMoney(text) {
  const s = (text || '').replace(/[$,\s]/g, '');
  const negative = /^\(.*\)$/.test(s);
  const n = Number(negative ? s.slice(1, -1) : s);
  return s && Number.isFinite(n) ? (negative ? -n : n) : null;
}

const looksLikeDate = (text) => DATE_FORMATS.some((f) => f.regex.test((text || '').trim()));

// One account's balance history, e.g. a retirement site's export: a date column and a balance column
// (headed Date and Balance/Value/Amount/Total, else the first two columns; the header row is optional).
// Amounts may have $, commas, or parentheses for negatives. Rows whose date or balance can't be read are
// returned in `skipped` (with their row number); a date listed twice keeps its last row.
export function parseBalanceHistory(text) {
  const rows = Papa.parse((text || '').trim(), { skipEmptyLines: true }).data.map((r) => r.map((c) => String(c).trim()));
  if (!rows.length) return { balances: [], skipped: [] };

  const hasHeader = !rows[0].some(looksLikeDate);
  let dateCol = 0;
  let balanceCol = 1;
  if (hasHeader) {
    const found = (re, not) => rows[0].findIndex((h, i) => i !== not && re.test(h));
    dateCol = Math.max(found(/date|as of/i), 0);
    balanceCol = found(/balance|value|amount|total/i, dateCol);
    if (balanceCol < 0) balanceCol = dateCol === 0 ? 1 : 0;
  }

  const body = rows.slice(hasHeader ? 1 : 0);
  const format = detectDateFormat(body.map((r) => r[dateCol]).filter(looksLikeDate));
  const byDate = new Map();
  const skipped = [];
  body.forEach((r, i) => {
    const date = parseDate(r[dateCol] || '', format);
    const balance = parseMoney(r[balanceCol]);
    if (date && balance !== null) byDate.set(date, { date, balance });
    else skipped.push({ row: i + (hasHeader ? 2 : 1), text: r.join(', ') });
  });
  const balances = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  return { balances, skipped };
}

export function transformRows(rows, config) {
  const { dateColumn, descriptionColumn, categoryColumn, dateFormat } = config;

  return rows.map((row, i) => {
    const parsedDate = parseDate(row[dateColumn] || '', dateFormat);
    const { amount, isDebit } = parseAmount(row, config);
    const description = (row[descriptionColumn] || '').trim();
    const category = categoryColumn ? (row[categoryColumn] || '').trim().toLowerCase() : '';

    return {
      index: i,
      date: parsedDate,
      description,
      amount,
      isDebit,
      category,
      valid: parsedDate !== null && amount > 0 && description.length > 0,
      skip: false,
    };
  });
}
