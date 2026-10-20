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
