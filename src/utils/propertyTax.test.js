import { describe, it, expect } from 'vitest';
import {
  analyzeComps, appealFacts, appealLetter, daysLeft, effectiveRate, homeEvidence, inWindow, parseCompsCsv, parseSaleDate, requestedValue,
  supportedValue, taxImpact, timeAdjust,
} from './propertyTax';

const TAX = { appraisalDate: '2026-06-30', salesFrom: '2024-07-01', salesTo: '2026-06-30', sqft: 2000, yearBuilt: 2000 };
const comp = (address, saleDate, price, sqft, extra = {}) => ({ id: address, address, saleDate, price, sqft, ...extra });

describe('sales window and time adjustment', () => {
  it('knows the window and moves prices to the appraisal date by the monthly change', () => {
    expect(inWindow('2025-01-15', TAX)).toBe(true);
    expect(inWindow('2024-06-30', TAX)).toBe(false);
    expect(inWindow('2026-07-01', TAX)).toBe(false);
    expect(inWindow('2020-01-01', {})).toBe(true);
    expect(timeAdjust(500000, '2025-06-30', '2026-06-30', 0)).toBe(500000);
    // a year of −0.5% a month
    expect(Math.round(timeAdjust(500000, '2025-06-30', '2026-06-30', -0.5))).toBe(Math.round(500000 * 0.995 ** (365 / (365.25 / 12))));
  });
});

describe('comparable sales', () => {
  const comps = [
    comp('101 Example Ct', '2025-09-10', 540000, 2000),
    comp('202 Sample Way', '2026-02-01', 600000, 2400), // 20% larger: not flagged
    comp('303 Demo Ln', '2025-04-20', 480000, 1400, { yearBuilt: 1970 }), // 30% smaller, much older
    comp('404 Test Pl', '2024-03-01', 450000, 1800), // outside the window
    comp('505 Mock St', '2025-11-11', 700000, 2100, { include: false }), // left out by the owner
  ];

  it('works out what each sale says the home is worth, flags weaker ones, and counts only usable ones', () => {
    const a = analyzeComps(comps, TAX);
    expect(a.map((c) => [c.address, c.perSqft, c.indicated, c.counted, c.notes])).toEqual([
      ['101 Example Ct', 270, 540000, true, []],
      ['202 Sample Way', 250, 500000, true, []],
      ['303 Demo Ln', 342.86, 685700, true, ['smaller by 30%', 'built 1970']],
      ['404 Test Pl', 250, 500000, false, ['outside the sales window']],
      ['505 Mock St', 333.33, 666700, false, []],
    ]);
    expect(supportedValue(a)).toEqual({ median: 540000, low: 500000, high: 685700, count: 3 });
    expect(supportedValue(analyzeComps(comps.slice(0, 2), TAX))).toEqual({ median: 520000, low: 500000, high: 540000, count: 2 });
    expect(supportedValue([])).toBeNull();
    // without the home's size nothing can be indicated
    expect(analyzeComps(comps, { ...TAX, sqft: '' })[0]).toMatchObject({ indicated: null, counted: false });
  });
});

describe('the home itself', () => {
  const property = { address: '1 Example Rd', purchasePrice: 600000, purchaseDate: '2025-03-21' };

  it('counts its purchase inside the window and added appraisals, newest first', () => {
    const tax = { ...TAX, evidence: [{ id: 'e1', kind: 'appraisal', date: '2025-12-09', value: 560000 }, { id: 'e2', kind: 'appraisal', date: '2023-01-01', value: 500000 }] };
    expect(homeEvidence(property, tax).map((e) => [e.kind, e.date, e.adjusted, e.inside])).toEqual([
      ['appraisal', '2025-12-09', 560000, true],
      ['purchase', '2025-03-21', 600000, true],
      ['appraisal', '2023-01-01', 500000, false],
    ]);
    expect(homeEvidence({ ...property, purchaseDate: '2023-05-01' }, TAX)).toEqual([]);
  });

  it('asks for the set value, else the comparables, else the newest appraisal inside the window', () => {
    const evidence = homeEvidence(property, { ...TAX, evidence: [{ id: 'e1', kind: 'appraisal', date: '2025-12-09', value: 560000 }] });
    expect(requestedValue({ requested: 550000 }, { median: 540000 }, evidence)).toBe(550000);
    expect(requestedValue({}, { median: 540000 }, evidence)).toBe(540000);
    expect(requestedValue({}, null, evidence)).toBe(560000);
    expect(requestedValue({}, null, [])).toBeNull();
  });
});

describe('tax impact and deadline', () => {
  it('uses the last bill over its value as the rate, and multiplies by the years a value lasts', () => {
    expect(effectiveRate({ lastTax: 3000, lastTaxValue: 600000 })).toBe(0.005);
    expect(effectiveRate({ rate: 0.6 })).toBe(0.006);
    expect(effectiveRate({})).toBeNull();
    expect(taxImpact({ noticeValue: 620000, lastTax: 3000, lastTaxValue: 600000, years: 2 }, 540000)).toEqual({ reduction: 80000, perYear: 400, years: 2, total: 800, rate: 0.005 });
    expect(taxImpact({ noticeValue: 500000, rate: 0.5 }, 540000)).toMatchObject({ reduction: 0, perYear: 0, years: 1 });
    expect(taxImpact({ noticeValue: 620000 }, 540000)).toBeNull();
    expect(daysLeft({ deadline: '2027-06-01' }, '2027-05-02')).toBe(30);
    expect(daysLeft({}, '2027-05-02')).toBeNull();
  });
});

describe('reading sales exports', () => {
  it('reads sale dates in the usual forms', () => {
    expect(parseSaleDate('2025-03-14')).toBe('2025-03-14');
    expect(parseSaleDate('3/14/2025')).toBe('2025-03-14');
    expect(parseSaleDate('3/4/25')).toBe('2025-03-04');
    expect(parseSaleDate('March-14-2025')).toBe('2025-03-14');
    expect(parseSaleDate('Mar 14, 2025')).toBe('2025-03-14');
    expect(parseSaleDate('soon')).toBeNull();
  });

  it("finds a listing site's columns and skips its notice row", () => {
    const csv = [
      'SALE TYPE,SOLD DATE,PROPERTY TYPE,ADDRESS,CITY,PRICE,BEDS,BATHS,LOCATION,SQUARE FEET,LOT SIZE,YEAR BUILT,$/SQUARE FEET',
      '"In accordance with local MLS rules, some MLS listings are not included in the download",,,,,,,,,,,,',
      'PAST SALE,March-14-2025,Single Family Residential,101 Example Ct,Exampleville,"540,000",4,2.5,Demo Park,2000,6000,1999,270',
      'PAST SALE,January-2-2026,Single Family Residential,202 Sample Way,Exampleville,600000,4,3,Demo Park,2400,7000,2004,250',
    ].join('\n');
    const { comps, skipped, columns } = parseCompsCsv(csv);
    expect(columns).toMatchObject({ address: 'ADDRESS', saleDate: 'SOLD DATE', price: 'PRICE', sqft: 'SQUARE FEET', beds: 'BEDS', baths: 'BATHS', yearBuilt: 'YEAR BUILT' });
    expect(skipped).toBe(1);
    expect(comps).toEqual([
      { address: '101 Example Ct', saleDate: '2025-03-14', price: 540000, sqft: 2000, beds: 4, baths: 2.5, yearBuilt: 1999 },
      { address: '202 Sample Way', saleDate: '2026-01-02', price: 600000, sqft: 2400, beds: 4, baths: 3, yearBuilt: 2004 },
    ]);
  });

  it("finds an assessor-style sales list's columns", () => {
    const csv = 'Parcel,Situs Address,Sale Date,Sale Price,Above Grade Sq Ft,Year Built\nR1,303 Demo Ln,04/20/2025,"$480,000",1400,1970';
    expect(parseCompsCsv(csv).comps).toEqual([{ address: '303 Demo Ln', saleDate: '2025-04-20', price: 480000, sqft: 1400, beds: null, baths: null, yearBuilt: 1970 }]);
  });
});

describe('the protest', () => {
  const property = {
    address: '1 Example Rd',
    purchasePrice: 600000,
    purchaseDate: '2025-03-21',
    tax: {
      ...TAX,
      parcel: 'R0000001',
      noticeValue: 620000,
      lastTax: 3000,
      lastTaxValue: 600000,
      years: 2,
      deadline: '2027-06-01',
      comps: [comp('101 Example Ct', '2025-09-10', 540000, 2000), comp('202 Sample Way', '2026-02-01', 600000, 2400)],
      evidence: [{ id: 'e1', kind: 'appraisal', date: '2025-12-09', value: 560000 }],
    },
  };

  it('gathers the facts: counted comparables, evidence, the value asked for, the savings and days left', () => {
    const facts = appealFacts(property, '2027-05-02');
    expect(facts).toMatchObject({
      address: '1 Example Rd', parcel: 'R0000001', noticeValue: 620000, requestedValue: 520000,
      supported: { median: 520000, count: 2 }, impact: { reduction: 100000, perYear: 500, total: 1000 }, daysLeft: 30,
    });
    expect(facts.comparables.map((c) => c.address)).toEqual(['101 Example Ct', '202 Sample Way']);
    expect(facts.evidence.map((e) => e.kind)).toEqual(['appraisal', 'purchase']);
    // evidence at or above the notice's value doesn't support lowering it
    const lower = appealFacts({ ...property, tax: { ...property.tax, noticeValue: 590000 } }, '2027-05-02');
    expect(lower.evidence.map((e) => e.kind)).toEqual(['appraisal']);
  });

  it('writes a plain letter from them', () => {
    const letter = appealLetter(appealFacts(property, '2027-05-02'));
    expect(letter).toContain('I am protesting the actual value of 1 Example Rd (parcel R0000001), shown on my Notice of Valuation as $620,000.');
    expect(letter).toContain('as of the appraisal date, June 30, 2026, was $520,000.');
    expect(letter).toContain('1. 101 Example Ct: sold September 10, 2025 for $540,000; 2,000 sq ft at $270/sq ft, which indicates $540,000 for my home.');
    expect(letter).toContain('These sales indicate $500,000 to $540,000, with a median of $520,000.');
    expect(letter).toContain('An appraisal of the home on December 9, 2025 valued it at $560,000.');
    expect(letter).toContain("I bought the home on March 21, 2025 for $600,000, an arm's-length sale inside the sales window.");
    expect(letter).toContain('I ask that the actual value be set at $520,000.');
  });
});
