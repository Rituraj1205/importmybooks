import { useRef, useState } from "react";
import { Upload, FileText, X } from "lucide-react";

const EXCEL_EXTS = [".xlsx", ".xls", ".xlsm", ".xlsb"];
const isExcel = (name = "") => EXCEL_EXTS.some(ext => name.toLowerCase().endsWith(ext));

export default function FileDropZone({ accept = ".csv", file, onChange, label = "Upload CSV", disabled = false }) {
  const inputRef = useRef(null);
  const [isDragging, setIsDragging] = useState(false);
  const [excelError, setExcelError] = useState("");

  const handleFile = (f) => {
    if (!f) { onChange(null); return; }
    if (isExcel(f.name)) {
      setExcelError(`Excel files are not accepted. Please save "${f.name}" as CSV first, then upload the .csv file.`);
      return;
    }
    setExcelError("");
    onChange(f);
  };

  const handleDragOver = e => {
    e.preventDefault();
    if (!disabled) setIsDragging(true);
  };
  const handleDragLeave = () => setIsDragging(false);
  const handleDrop = e => {
    e.preventDefault();
    setIsDragging(false);
    if (disabled) return;
    handleFile(e.dataTransfer.files[0] || null);
  };
  const handleChange = e => {
    handleFile(e.target.files[0] || null);
    e.target.value = "";
  };
  const handleClear = e => {
    e.stopPropagation();
    setExcelError("");
    onChange(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        className={`file-drop-zone ${isDragging ? "file-drop-zone--dragging" : ""} ${file ? "file-drop-zone--has-file" : ""} ${disabled ? "file-drop-zone--disabled" : ""}`}
        onClick={() => !disabled && !file && inputRef.current?.click()}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".csv"
          onChange={handleChange}
          style={{ display: "none" }}
          disabled={disabled}
        />

        {file ? (
          <div className="file-drop-zone__file">
            <div className="file-drop-zone__file-icon">
              <FileText size={20} />
            </div>
            <div className="file-drop-zone__file-info">
              <span className="file-drop-zone__file-name">{file.name}</span>
              <span className="file-drop-zone__file-size">
                {(file.size / 1024).toFixed(1)} KB
              </span>
            </div>
            <button
              className="file-drop-zone__clear"
              onClick={handleClear}
              type="button"
              title="Remove file"
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <div className="file-drop-zone__empty">
            <div className="file-drop-zone__icon">
              <Upload size={22} />
            </div>
            <div className="file-drop-zone__text">
              <span className="file-drop-zone__label">{label}</span>
              <span className="file-drop-zone__hint">
                {isDragging ? "Drop it here!" : "Drag & drop or click to browse"}
              </span>
            </div>
            <span className="file-drop-zone__formats">CSV only</span>
          </div>
        )}
      </div>
      {excelError && (
        <div style={{
          background: "rgba(239,68,68,0.1)",
          border: "1px solid rgba(239,68,68,0.35)",
          borderRadius: 8,
          padding: "8px 12px",
          fontSize: 12,
          color: "#ef4444",
          lineHeight: 1.5
        }}>
          ❌ {excelError}
        </div>
      )}
    </div>
  );
}
