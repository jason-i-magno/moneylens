import { useState } from 'react';

// Destructive action that needs a second click; `confirmLabel` should say what gets deleted
export default function ConfirmButton({ label, confirmLabel, onConfirm, className = 'btn-danger' }) {
  const [armed, setArmed] = useState(false);

  const handleClick = (e) => {
    e.stopPropagation();
    if (armed) {
      onConfirm();
      setArmed(false);
    } else {
      setArmed(true);
    }
  };

  return (
    <button className={className} onClick={handleClick} onBlur={() => setArmed(false)}>
      {armed ? confirmLabel || 'Click again to confirm' : label}
    </button>
  );
}
