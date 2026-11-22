import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import SummaryCard from '../components/SummaryCard';
import FileDropZone from '../components/FileDropZone';
import ConfirmButton from '../components/ConfirmButton';
import EmptyState from '../components/EmptyState';
import { formatCurrency } from '../constants/categories';
import { todayISO } from '../utils/dates';
import { makeId } from '../utils/ids';
import {
  analyzeComps, appealFacts, appealLetter, daysLeft, effectiveRate, homeEvidence, inWindow, parseCompsCsv, requestedValue, supportedValue, taxImpact, taxOf,
} from '../utils/propertyTax';
import { appealRequest } from '../utils/appealClient';

const shortDate = (date) => new Date(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
  .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const whole = (n) => formatCurrency(n).replace(/\.00$/, '');

// One setting: kept as typed, saved when it loses focus. Remounts (key) when the saved value changes elsewhere.
function Field({ label, value, type = 'number', step, placeholder, onSave, wide }) {
  const [text, setText] = useState(value ?? '');
  const commit = () => {
    const next = text === '' ? undefined : type === 'number' ? Number(text) : text;
    if (next !== value && !(type === 'number' && Number.isNaN(next))) onSave(next);
  };
  return (
    <div className={`form-group ${wide ? 'wide' : ''}`}>
      <label>{label}</label>
      <input type={type} step={step} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} />
    </div>
  );
}

const BLANK_COMP = { address: '', saleDate: '', price: '', sqft: '', beds: '', baths: '', yearBuilt: '' };
const BLANK_EVIDENCE = { kind: 'appraisal', date: '', value: '', notes: '' };
const numberOrNull = (v) => (v === '' || v === null || v === undefined ? null : Number(v));

export default function PropertyTax({ data, updatePropertyTax }) {
  const properties = data.mortgages?.properties || [];
  const [params, setParams] = useSearchParams();
  const property = properties.find((p) => p.id === params.get('property')) || properties[0];
  const today = todayISO();
  const [compForm, setCompForm] = useState(BLANK_COMP);
  const [evidenceForm, setEvidenceForm] = useState(BLANK_EVIDENCE);
  const [importNote, setImportNote] = useState(null);
  const [server, setServer] = useState({ state: 'checking' });
  const [writing, setWriting] = useState({ state: 'idle' });
  const [copied, setCopied] = useState('');
  const letterRef = useRef(null);
  const reasonRef = useRef(null);

  useEffect(() => {
    appealRequest('status').then(
      (status) => setServer({ state: 'ready', ...status }),
      (err) => setServer({ state: 'unavailable', message: err.message })
    );
  }, []);

  const tax = taxOf(property);
  const comps = useMemo(() => analyzeComps(tax.comps, tax), [tax]);
  const supported = supportedValue(comps);
  const evidence = useMemo(() => homeEvidence(property, tax), [property, tax]);

  if (!property) {
    return (
      <div className="page property-tax">
        <h2>Property Tax</h2>
        <EmptyState icon="🏠" message="Add your home on the Mortgage page first, then come back for its property tax." action={<Link className="btn-primary" to="/mortgage">Go to Mortgage</Link>} />
      </div>
    );
  }

  const save = (changes) => updatePropertyTax(property.id, changes);
  const field = (key, label, extra = {}) => (
    <Field key={`${property.id}:${key}:${tax[key] ?? ''}`} label={label} value={tax[key]} onSave={(v) => save({ [key]: v })} {...extra} />
  );
  const requested = requestedValue(tax, supported, evidence);
  const impact = requested ? taxImpact(tax, requested) : null;
  const rate = effectiveRate(tax);
  const left = daysLeft(tax, today);
  const counted = comps.filter((c) => c.counted).length;

  const addComp = () => {
    const c = Object.fromEntries(Object.entries(compForm).map(([k, v]) => [k, k === 'address' || k === 'saleDate' ? v.trim() : numberOrNull(v)]));
    save({ comps: [...(tax.comps || []), { ...c, id: makeId('comp') }] });
    setCompForm(BLANK_COMP);
  };

  const importComps = async (files) => {
    const text = await files[0].text();
    const { comps: found, skipped, columns } = parseCompsCsv(text);
    const missing = ['address', 'saleDate', 'price', 'sqft'].filter((k) => !columns[k]);
    if (!found.length) {
      setImportNote({ error: true, text: `No sales found in ${files[0].name}.${missing.length ? ` Couldn't find these columns: ${missing.join(', ')}.` : ''}` });
      return;
    }
    const known = new Set((tax.comps || []).map((c) => `${c.address.toLowerCase()}|${c.saleDate}`));
    const fresh = found.filter((c) => !known.has(`${c.address.toLowerCase()}|${c.saleDate}`));
    const base = makeId('comp');
    // Sales outside the window come in switched off; they're kept only to show what was left out
    const added = fresh.map((c, i) => ({ ...c, id: `${base}_${i}`, include: inWindow(c.saleDate, tax) }));
    save({ comps: [...(tax.comps || []), ...added] });
    setImportNote({
      text: `Added ${added.length} sale${added.length === 1 ? '' : 's'} from ${files[0].name}`
        + `${found.length - fresh.length ? `, ${found.length - fresh.length} already here` : ''}${skipped ? `, ${skipped} row${skipped === 1 ? '' : 's'} skipped` : ''}.`
        + `${missing.includes('sqft') ? ' No size column was found, so add each sale’s square feet.' : ''} Untick the ones that aren’t like your home.`,
    });
  };

  const toggleComp = (id) => save({ comps: tax.comps.map((c) => (c.id === id ? { ...c, include: c.include === false } : c)) });
  const removeComp = (id) => save({ comps: tax.comps.filter((c) => c.id !== id) });

  const addEvidence = () => {
    save({ evidence: [...(tax.evidence || []), { id: makeId('evid'), kind: evidenceForm.kind, date: evidenceForm.date, value: Number(evidenceForm.value), notes: evidenceForm.notes.trim() }] });
    setEvidenceForm(BLANK_EVIDENCE);
  };
  const removeEvidence = (id) => save({ evidence: (tax.evidence || []).filter((e) => e.id !== id) });

  const plainLetter = () => save({ letter: appealLetter(appealFacts(property, today)), reason: undefined, letterBy: undefined, letterAt: today });
  const claudeLetter = async () => {
    setWriting({ state: 'writing' });
    try {
      const { letter, reason, model } = await appealRequest('write', { facts: appealFacts(property, today) });
      save({ letter, reason, letterBy: model, letterAt: today });
      setWriting({ state: 'idle' });
    } catch (err) {
      setWriting({ state: 'error', message: err.message });
    }
  };
  // Copies what's in the box now, edits included
  const copy = async (key, ref) => {
    try {
      await navigator.clipboard.writeText(ref.current?.value || '');
      setCopied(key);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setCopied('');
    }
  };

  const ready = tax.noticeValue > 0 && counted + evidence.filter((e) => e.inside).length > 0;

  return (
    <div className="page property-tax">
      <div className="page-header">
        <div>
          <h2>Property Tax</h2>
          <p className="page-subtitle">{property.address}: what the home was worth on the appraisal date, from sales the assessor has to consider</p>
        </div>
        {properties.length > 1 && (
          <div className="page-header-actions">
            <select className="month-select" aria-label="Property" value={property.id} onChange={(e) => setParams({ property: e.target.value })}>
              {properties.map((p) => <option key={p.id} value={p.id}>{p.address}</option>)}
            </select>
          </div>
        )}
      </div>

      <div className="summary-grid">
        <SummaryCard label="On the Notice" value={tax.noticeValue > 0 ? whole(tax.noticeValue) : 'Not yet'} note={tax.noticeValue > 0 ? 'the assessor’s value' : 'enter it when the notice comes'} />
        <SummaryCard
          label="Sales Support"
          value={supported ? whole(supported.median) : '-'}
          accent
          note={supported ? `${supported.count} sale${supported.count === 1 ? '' : 's'}, ${whole(supported.low)} to ${whole(supported.high)}` : 'add comparable sales below'}
        />
        <SummaryCard
          label="Possible Savings"
          value={impact ? whole(impact.total) : '-'}
          tone={impact?.total > 0 ? 'good' : undefined}
          note={impact ? `${whole(impact.perYear)} a year${impact.years > 1 ? ` for ${impact.years} years` : ''}, asking ${whole(requested)}` : 'needs the notice value, your tax rate and evidence'}
        />
        <SummaryCard
          label="Deadline"
          value={tax.deadline ? shortDate(tax.deadline) : 'Not set'}
          tone={left !== null && left >= 0 && left <= 14 ? 'bad' : undefined}
          note={left === null ? 'set it below' : left >= 0 ? `${left} day${left === 1 ? '' : 's'} left` : 'passed'}
        />
      </div>

      <div className="card">
        <h3>The Rules</h3>
        <p className="muted settings-help">
          From your assessor&apos;s website or notice: the date values are set as of, the window of sales the assessor must use, and the protest
          deadline. Evidence has to be sales (not listings) from inside the window.
        </p>
        <div className="form-grid">
          {field('appraisalDate', 'Appraisal date (values as of)', { type: 'date' })}
          {field('deadline', 'Protest deadline', { type: 'date' })}
          {field('salesFrom', 'Sales window starts', { type: 'date' })}
          {field('salesTo', 'Sales window ends', { type: 'date' })}
          {field('years', 'Years a value lasts', { placeholder: '1' })}
          {field('trend', 'Market change a month (%)', { step: '0.1', placeholder: 'e.g. -0.3; blank for none' })}
          {field('parcel', 'Parcel or account number', { type: 'text', wide: true })}
        </div>
      </div>

      <div className="card">
        <h3>Values and Tax</h3>
        <div className="form-grid">
          {field('noticeValue', 'Value on the notice')}
          {field('requested', 'Value to ask for', { placeholder: requested ? `${Math.round(requested)} (worked out)` : '' })}
          {field('lastTax', 'Last year’s tax bill')}
          {field('lastTaxValue', 'The value that bill was based on')}
        </div>
        <p className="muted">
          {rate !== null
            ? `Your tax comes to ${(rate * 100).toFixed(3)}% of the value, so each $10,000 off saves about ${whole(rate * 10000)} a year.`
            : 'The tax rate comes from your last bill and the value it was based on (both on the bill).'}
        </p>
      </div>

      <div className="card">
        <h3>Your Home</h3>
        <p className="muted settings-help">Use the same size measure as the sales you compare (e.g. above-grade living area).</p>
        <div className="form-grid">
          {field('sqft', 'Living area (sq ft)')}
          {field('yearBuilt', 'Year built')}
          {field('beds', 'Bedrooms')}
          {field('baths', 'Bathrooms', { step: '0.5' })}
        </div>
      </div>

      <div className="card">
        <h3>Evidence About Your Home</h3>
        <p className="muted settings-help">
          Your own purchase and appraisals inside the sales window are strong evidence, moved to the appraisal date by the market change.
        </p>
        {evidence.length === 0 && <p className="muted">None yet.</p>}
        {evidence.map((e) => (
          <div key={e.id} className="item-row">
            <div className="item-main">
              <div className="item-title">
                {e.kind === 'appraisal' ? 'Appraisal' : e.kind === 'purchase' ? 'Your purchase' : 'Sale of the home'}
                {!e.inside && <span className="chip warn">outside the window</span>}
              </div>
              <div className="item-meta">{shortDate(e.date)}{e.auto ? ' · from the Mortgage page' : ''}{e.notes ? ` · ${e.notes}` : ''}</div>
            </div>
            <div className="item-side">
              <span className="item-amount">{whole(e.value)}</span>
              {e.adjusted !== e.value && <span className="item-meta">{whole(e.adjusted)} adjusted</span>}
              {!e.auto && <ConfirmButton label="Remove" confirmLabel="Remove?" className="btn-icon danger" onConfirm={() => removeEvidence(e.id)} />}
            </div>
          </div>
        ))}
        <div className="form-grid mt-12">
          <div className="form-group">
            <label>Kind</label>
            <select value={evidenceForm.kind} onChange={(e) => setEvidenceForm((f) => ({ ...f, kind: e.target.value }))}>
              <option value="appraisal">Appraisal</option>
              <option value="sale">An earlier sale of the home</option>
            </select>
          </div>
          <div className="form-group"><label>Date</label><input type="date" value={evidenceForm.date} onChange={(e) => setEvidenceForm((f) => ({ ...f, date: e.target.value }))} /></div>
          <div className="form-group"><label>Value</label><input type="number" value={evidenceForm.value} onChange={(e) => setEvidenceForm((f) => ({ ...f, value: e.target.value }))} /></div>
          <div className="form-group"><label>Notes</label><input value={evidenceForm.notes} placeholder="e.g. refinance appraisal" onChange={(e) => setEvidenceForm((f) => ({ ...f, notes: e.target.value }))} /></div>
        </div>
        <button className="btn-secondary" disabled={!evidenceForm.date || !(Number(evidenceForm.value) > 0)} onClick={addEvidence}>Add Evidence</button>
      </div>

      <div className="card">
        <h3>Comparable Sales</h3>
        <p className="muted settings-help">
          Homes like yours nearby that sold inside the window. Import a CSV (a listing site&apos;s sold homes, or the assessor&apos;s sales list saved
          as CSV) or add them by hand. Each one says what your home is worth at its price per square foot, adjusted to the appraisal date.
        </p>
        <FileDropZone onFiles={importComps} accept=".csv" label="Drop a sales CSV here or" />
        {importNote && <p className={`${importNote.error ? 'error-text' : 'muted'} mt-12`}>{importNote.text}</p>}
        {comps.length > 0 && (
          <p className="muted mt-12">
            {counted} of {comps.length} used{supported ? `; they support ${whole(supported.median)}` : ''}.
          </p>
        )}
        {comps.map((c) => (
          <div key={c.id} className={`item-row ${c.counted ? '' : 'muted-row'}`}>
            <div className="item-main">
              <div className="item-title">
                <label className="comp-use"><input type="checkbox" checked={c.include !== false} onChange={() => toggleComp(c.id)} /> {c.address}</label>
                {c.notes.map((n) => <span key={n} className="chip warn">{n}</span>)}
              </div>
              <div className="item-meta">
                {[shortDate(c.saleDate), c.sqft && `${c.sqft.toLocaleString('en-US')} sq ft`, c.beds && `${c.beds} bd`, c.baths && `${c.baths} ba`, c.yearBuilt && `built ${c.yearBuilt}`].filter(Boolean).join(' · ')}
              </div>
            </div>
            <div className="item-side">
              <span className="item-amount">{whole(c.price)}</span>
              {c.indicated !== null && <span className="item-meta">{formatCurrency(c.perSqft)}/sq ft → {whole(c.indicated)}</span>}
              <ConfirmButton label="Remove" confirmLabel="Remove?" className="btn-icon danger" onConfirm={() => removeComp(c.id)} />
            </div>
          </div>
        ))}
        <div className="form-grid mt-12">
          <div className="form-group wide"><label>Address</label><input value={compForm.address} onChange={(e) => setCompForm((f) => ({ ...f, address: e.target.value }))} /></div>
          <div className="form-group"><label>Sale date</label><input type="date" value={compForm.saleDate} onChange={(e) => setCompForm((f) => ({ ...f, saleDate: e.target.value }))} /></div>
          <div className="form-group"><label>Price</label><input type="number" value={compForm.price} onChange={(e) => setCompForm((f) => ({ ...f, price: e.target.value }))} /></div>
          <div className="form-group"><label>Living area (sq ft)</label><input type="number" value={compForm.sqft} onChange={(e) => setCompForm((f) => ({ ...f, sqft: e.target.value }))} /></div>
          <div className="form-group"><label>Year built</label><input type="number" value={compForm.yearBuilt} onChange={(e) => setCompForm((f) => ({ ...f, yearBuilt: e.target.value }))} /></div>
          <div className="form-group"><label>Bedrooms</label><input type="number" value={compForm.beds} onChange={(e) => setCompForm((f) => ({ ...f, beds: e.target.value }))} /></div>
          <div className="form-group"><label>Bathrooms</label><input type="number" step="0.5" value={compForm.baths} onChange={(e) => setCompForm((f) => ({ ...f, baths: e.target.value }))} /></div>
        </div>
        <button className="btn-secondary" disabled={!compForm.address.trim() || !compForm.saleDate || !(Number(compForm.price) > 0)} onClick={addComp}>Add Sale</button>
      </div>

      <div className="card">
        <h3>Protest Letter</h3>
        <p className="muted settings-help">
          Written from everything above. Edit it, then file it the way your assessor takes protests (many have an online form that takes a
          reason and uploaded documents: attach the appraisal too).
          {server.state === 'ready' && !server.writing && ` ${server.problem}`}
        </p>
        <div className="data-actions">
          <button className="btn-secondary" disabled={!ready} onClick={plainLetter}>{tax.letter ? 'Rewrite Plain Letter' : 'Write Plain Letter'}</button>
          {server.state === 'ready' && server.writing && (
            <button className="btn-primary" disabled={!ready || writing.state === 'writing'} onClick={claudeLetter}>
              {writing.state === 'writing' ? 'Claude is writing…' : 'Write with Claude'}
            </button>
          )}
        </div>
        {!ready && <p className="muted mt-12">Needs the value on the notice and at least one sale or piece of evidence inside the window.</p>}
        {writing.state === 'error' && <p className="error-text mt-12">{writing.message}</p>}
        {tax.reason && (
          <div className="form-group mt-12">
            <label>Reason (for an online form)</label>
            <textarea ref={reasonRef} key={`reason:${tax.letterAt}:${tax.reason.length}`} className="letter-text short" defaultValue={tax.reason} onBlur={(e) => e.target.value !== tax.reason && save({ reason: e.target.value })} />
            <button className="btn-icon" onClick={() => copy('reason', reasonRef)}>{copied === 'reason' ? 'Copied' : 'Copy'}</button>
          </div>
        )}
        {tax.letter && (
          <div className="form-group mt-12">
            <label>Letter{tax.letterBy ? ' (written by Claude: check every figure)' : ''}{tax.letterAt ? `, ${shortDate(tax.letterAt)}` : ''}</label>
            <textarea ref={letterRef} key={`letter:${tax.letterAt}:${tax.letter.length}`} className="letter-text" defaultValue={tax.letter} onBlur={(e) => e.target.value !== tax.letter && save({ letter: e.target.value })} />
            <button className="btn-icon" onClick={() => copy('letter', letterRef)}>{copied === 'letter' ? 'Copied' : 'Copy'}</button>
          </div>
        )}
      </div>
    </div>
  );
}
