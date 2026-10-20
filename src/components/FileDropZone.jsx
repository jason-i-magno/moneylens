import { useState, useRef } from 'react';

export default function FileDropZone({ onFiles, multiple = false, accept = '.csv,.tsv', label }) {
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef(null);

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length > 0) onFiles(multiple ? files : [files[0]]);
  };

  const handleChange = (e) => {
    const files = [...e.target.files];
    if (files.length > 0) onFiles(multiple ? files : [files[0]]);
    e.target.value = '';
  };

  return (
    <div
      className={`drop-zone ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        onChange={handleChange}
        style={{ display: 'none' }}
      />
      <p className="drop-text">
        {label || `Drop file${multiple ? 's' : ''} here or`} <span className="drop-link">browse</span>
      </p>
    </div>
  );
}
