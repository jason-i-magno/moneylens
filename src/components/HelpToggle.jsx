// The small "i" that shows or hides an explanation; `about` finishes "What … does" for screen readers
export default function HelpToggle({ about, open, onClick }) {
  return (
    <button type="button" className={`info-toggle ${open ? 'active' : ''}`} aria-expanded={open} aria-label={`What ${about} does`} title={open ? 'Hide' : 'What this does'} onClick={onClick}>
      i
    </button>
  );
}
