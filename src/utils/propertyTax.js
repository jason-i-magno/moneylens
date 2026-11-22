// Property tax appeal: what a home was worth on the assessor's appraisal date, from comparable sales in the
// sales window the assessor has to use, next to the value on the notice. The rules (appraisal date, sales window,
// deadline, how long a value lasts) differ by place, so they're settings on the property (property.tax).
import Papa from 'papaparse';
import { daysBetween } from './dates';

const DAYS_PER_MONTH = 365.25 / 12;
// A comparable whose size or age is this far from the home's is flagged as a weaker comparison
export const SIZE_GAP = 0.25;
export const AGE_GAP = 15;

const round = (n, to = 1) => Math.round(n / to) * to;
const num = (v) => (Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : null);

export const taxOf = (property) => property?.tax || {};

// Whether a date is inside the sales window (an open end counts as inside)
export const inWindow = (date, tax) => Boolean(date) && (!tax.salesFrom || date >= tax.salesFrom) && (!tax.salesTo || date <= tax.salesTo);

// A price moved from its date to the appraisal date by the market's change per month (percent, negative when
// prices fell), the way assessors time-adjust sales
export function timeAdjust(price, date, appraisalDate, trendPerMonth) {
  if (!trendPerMonth || !appraisalDate || !date) return price;
  return price * (1 + trendPerMonth / 100) ** (daysBetween(date, appraisalDate) / DAYS_PER_MONTH);
}

// Each comparable sale: its price adjusted to the appraisal date, per square foot, what that says the home is
// worth (the adjusted price per square foot times the home's size), why it's a weaker comparison, and whether it
// counts (inside the sales window, not left out, with sizes known)
export function analyzeComps(comps = [], tax = {}) {
  const sqft = num(tax.sqft);
  const built = num(tax.yearBuilt);
  return comps.map((c) => {
    const adjusted = timeAdjust(c.price, c.saleDate, tax.appraisalDate, num(tax.trend));
    const perSqft = c.sqft > 0 ? adjusted / c.sqft : null;
    const indicated = perSqft !== null && sqft > 0 ? round(perSqft * sqft, 100) : null;
    const inside = inWindow(c.saleDate, tax);
    const notes = [
      !inside && 'outside the sales window',
      sqft > 0 && c.sqft > 0 && Math.abs(c.sqft - sqft) / sqft > SIZE_GAP && `${c.sqft > sqft ? 'larger' : 'smaller'} by ${Math.round((Math.abs(c.sqft - sqft) / sqft) * 100)}%`,
      built && c.yearBuilt && Math.abs(c.yearBuilt - built) > AGE_GAP && `built ${c.yearBuilt}`,
    ].filter(Boolean);
    return {
      ...c,
      adjusted: round(adjusted),
      perSqft: perSqft === null ? null : Math.round(perSqft * 100) / 100,
      indicated,
      inside,
      notes,
      counted: inside && c.include !== false && indicated !== null,
    };
  });
}

// The value the counted comparables support: the median of what they indicate, with the lowest and highest
export function supportedValue(analyzed) {
  const values = analyzed.filter((c) => c.counted).map((c) => c.indicated).sort((a, b) => a - b);
  if (!values.length) return null;
  const m = values.length >> 1;
  const median = values.length % 2 ? values[m] : (values[m - 1] + values[m]) / 2;
  return { median: round(median, 100), low: values[0], high: values.at(-1), count: values.length };
}

// Other evidence of the home's own value, adjusted to the appraisal date: its purchase (from the property, when
// inside the sales window) and what's been added (appraisals, an earlier sale), newest first
export function homeEvidence(property, tax = taxOf(property)) {
  const list = [...(tax.evidence || [])];
  if (property?.purchasePrice > 0 && inWindow(property.purchaseDate, tax)) {
    list.push({ id: 'purchase', kind: 'purchase', date: property.purchaseDate, value: property.purchasePrice, auto: true });
  }
  return list
    .filter((e) => e.value > 0 && e.date)
    .map((e) => ({ ...e, adjusted: round(timeAdjust(e.value, e.date, tax.appraisalDate, num(tax.trend)), 100), inside: inWindow(e.date, tax) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

// The tax rate on a home's value (as a fraction): the last bill over the value it was based on, else the rate
// entered (percent)
export function effectiveRate(tax) {
  const bill = num(tax.lastTax);
  const value = num(tax.lastTaxValue);
  if (bill > 0 && value > 0) return bill / value;
  const rate = num(tax.rate);
  return rate > 0 ? rate / 100 : null;
}

// What lowering the notice's value to `requested` saves: a year, and over the years the value lasts
export function taxImpact(tax, requested) {
  const notice = num(tax.noticeValue);
  const rate = effectiveRate(tax);
  if (!(notice > 0) || !(requested > 0) || rate === null) return null;
  const reduction = Math.max(0, notice - requested);
  const perYear = round(reduction * rate);
  const years = num(tax.years) > 0 ? num(tax.years) : 1;
  return { reduction, perYear, years, total: perYear * years, rate };
}

// The value to ask for: the one set, else the comparables' median, else the newest appraisal's adjusted value
export function requestedValue(tax, supported, evidence) {
  if (num(tax.requested) > 0) return num(tax.requested);
  if (supported) return supported.median;
  return evidence.find((e) => e.kind === 'appraisal' && e.inside)?.adjusted ?? null;
}

// Days from `today` to the deadline (negative once it's passed), or null without one
export const daysLeft = (tax, today) => (tax.deadline ? daysBetween(today, tax.deadline) : null);

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n) => String(n).padStart(2, '0');

// A sale date as YYYY-MM-DD from the forms listings and assessors use: 2025-03-14, 3/14/2025, March-14-2025,
// Mar 14, 2025. null when it isn't one.
export function parseSaleDate(text) {
  const s = String(text || '').trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (m) return `${m[3].length === 2 ? `20${m[3]}` : m[3]}-${pad(m[1])}-${pad(m[2])}`;
  m = s.match(/^([A-Za-z]{3,9})[-\s.]+(\d{1,2}),?[-\s]+(\d{4})$/);
  const month = m && MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
  if (m && month >= 0) return `${m[3]}-${pad(month + 1)}-${pad(m[2])}`;
  return null;
}

const money = (text) => num(String(text ?? '').replace(/[$,\s]/g, ''));

// Columns a sales export may use (a listing site's sold homes, an assessor's sales list), matched by header
const COLUMNS = {
  address: [/^address$/, /situs/, /property address/, /street address/, /^location$/, /address/],
  saleDate: [/sold date/, /sale date/, /date sold/, /^sold$/, /date of sale/, /^date$/],
  price: [/sale price/, /sold price/, /^price$/, /sales? amount/, /price/],
  sqft: [/square feet/, /sq\.? ?ft/, /living area/, /above grade/, /finished/, /sqft/, /area/],
  beds: [/^beds?$/, /bedrooms?/],
  baths: [/^baths?$/, /bathrooms?/],
  yearBuilt: [/year built/, /yr built/, /built/],
};

// Comparable sales from a CSV: columns found by their headers. Rows without a sale date, price or address are
// skipped (listing exports add a notice row). Returns { comps, skipped, columns: which header each field came from }
export function parseCompsCsv(text) {
  const { data, meta } = Papa.parse(String(text || '').trim(), { header: true, skipEmptyLines: true });
  const headers = (meta.fields || []).map((h) => h.trim());
  const used = new Set();
  const columns = {};
  for (const [field, patterns] of Object.entries(COLUMNS)) {
    for (const re of patterns) {
      // a price per square foot column isn't the size
      const hit = headers.find((h) => !used.has(h) && re.test(h.toLowerCase()) && !(field === 'sqft' && /\$|per /.test(h.toLowerCase())));
      if (hit) {
        columns[field] = hit;
        used.add(hit);
        break;
      }
    }
  }
  const cell = (row, field) => (columns[field] ? String(row[columns[field]] ?? row[` ${columns[field]}`] ?? '').trim() : '');
  const comps = [];
  let skipped = 0;
  for (const row of data) {
    const saleDate = parseSaleDate(cell(row, 'saleDate'));
    const price = money(cell(row, 'price'));
    const address = cell(row, 'address');
    if (!saleDate || !(price > 0) || !address) {
      skipped += 1;
      continue;
    }
    comps.push({ address, saleDate, price, sqft: money(cell(row, 'sqft')), beds: num(cell(row, 'beds')), baths: num(cell(row, 'baths')), yearBuilt: num(cell(row, 'yearBuilt')) });
  }
  return { comps, skipped, columns };
}

const dollars = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const longDate = (d) => new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)))
  .toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

// The facts a protest rests on, in one place: for the plain letter, and for Claude to write from. Evidence about
// the home counts when it's inside the sales window and below the notice's value (it supports lowering it).
export function appealFacts(property, today) {
  const tax = taxOf(property);
  const comps = analyzeComps(tax.comps, tax);
  const supported = supportedValue(comps);
  const evidence = homeEvidence(property, tax);
  const requested = requestedValue(tax, supported, evidence);
  return {
    address: property.address,
    parcel: tax.parcel || null,
    noticeValue: num(tax.noticeValue),
    appraisalDate: tax.appraisalDate || null,
    salesWindow: tax.salesFrom && tax.salesTo ? { from: tax.salesFrom, to: tax.salesTo } : null,
    marketChangePerMonth: num(tax.trend),
    home: { sqft: num(tax.sqft), beds: num(tax.beds), baths: num(tax.baths), yearBuilt: num(tax.yearBuilt) },
    comparables: comps.filter((c) => c.counted).map((c) => ({
      address: c.address, saleDate: c.saleDate, price: c.price, sqft: c.sqft, beds: c.beds, baths: c.baths, yearBuilt: c.yearBuilt,
      adjustedPrice: c.adjusted, perSqft: c.perSqft, indicatesForHome: c.indicated, notes: c.notes,
    })),
    supported,
    evidence: evidence.filter((e) => e.inside && !(num(tax.noticeValue) > 0 && e.adjusted >= num(tax.noticeValue))).map((e) => ({ kind: e.kind, date: e.date, value: e.value, adjusted: e.adjusted, notes: e.notes || '' })),
    requestedValue: requested,
    impact: requested ? taxImpact(tax, requested) : null,
    deadline: tax.deadline || null,
    daysLeft: daysLeft(tax, today),
  };
}

// A plain protest letter from the facts: the value protested, the comparable sales and other evidence, and the
// value asked for. The owner fills in the name and signs.
export function appealLetter(facts) {
  const lines = ['To the Assessor:', ''];
  const parcel = facts.parcel ? ` (parcel ${facts.parcel})` : '';
  const asOf = facts.appraisalDate ? ` as of the appraisal date, ${longDate(facts.appraisalDate)},` : '';
  lines.push(
    `I am protesting the actual value of ${facts.address}${parcel}${facts.noticeValue ? `, shown on my Notice of Valuation as ${dollars(facts.noticeValue)}` : ''}. `
      + `The evidence below shows its market value${asOf} was ${facts.requestedValue ? dollars(facts.requestedValue) : 'lower'}.`,
  );
  if (facts.comparables.length) {
    const window = facts.salesWindow ? ` between ${longDate(facts.salesWindow.from)} and ${longDate(facts.salesWindow.to)}` : '';
    const trend = facts.marketChangePerMonth ? ` Prices are adjusted to the appraisal date at ${facts.marketChangePerMonth}% a month.` : '';
    lines.push('', `Comparable sales${window}, compared by price per square foot of living area (my home: ${facts.home.sqft?.toLocaleString('en-US')} sq ft):${trend}`, '');
    facts.comparables.forEach((c, i) => {
      const adj = c.adjustedPrice !== c.price ? `, ${dollars(c.adjustedPrice)} adjusted` : '';
      lines.push(`${i + 1}. ${c.address}: sold ${longDate(c.saleDate)} for ${dollars(c.price)}${adj}; ${c.sqft.toLocaleString('en-US')} sq ft at ${dollars(c.perSqft)}/sq ft, which indicates ${dollars(c.indicatesForHome)} for my home.`);
    });
    if (facts.supported) {
      lines.push('', `These sales indicate ${dollars(facts.supported.low)} to ${dollars(facts.supported.high)}, with a median of ${dollars(facts.supported.median)}.`);
    }
  }
  for (const e of facts.evidence) {
    const adj = e.adjusted !== e.value ? ` (${dollars(e.adjusted)} adjusted to the appraisal date)` : '';
    if (e.kind === 'appraisal') lines.push('', `An appraisal of the home on ${longDate(e.date)} valued it at ${dollars(e.value)}${adj}.`);
    else if (e.kind === 'purchase') lines.push('', `I bought the home on ${longDate(e.date)} for ${dollars(e.value)}${adj}, an arm's-length sale inside the sales window.`);
    else lines.push('', `The home sold on ${longDate(e.date)} for ${dollars(e.value)}${adj}.`);
  }
  if (facts.requestedValue) lines.push('', `I ask that the actual value be set at ${dollars(facts.requestedValue)}.`);
  lines.push('', 'Sincerely,', '', '[Your name]', '[Phone or email]');
  return lines.join('\n');
}
