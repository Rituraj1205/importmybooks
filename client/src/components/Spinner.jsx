export default function Spinner({ size = 16, color = "currentColor" }) {
  return (
    <span
      className="spinner"
      style={{ "--sz": `${size}px`, "--clr": color }}
      aria-label="Loading"
    />
  );
}
