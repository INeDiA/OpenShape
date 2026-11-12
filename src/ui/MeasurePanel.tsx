import type { Measurement, MeasureRow } from "../model/types";

const fmt = (r: MeasureRow) => {
  if ("text" in r) return r.text;
  const digits = r.unit === "mm³" || r.unit === "mm²" ? (Math.abs(r.value) >= 1000 ? 0 : 2) : 2;
  const v = r.value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  return r.unit === "°" ? `${v}°` : `${v} ${r.unit}`;
};

/** Read-out of the measurements of the current model selection. */
export function MeasurePanel({ measurement, busy }: { measurement: Measurement | null; busy: boolean }) {
  if (!measurement) return busy ? <div className="measure-panel muted">Measuring…</div> : null;
  return (
    <div className="measure-panel" aria-live="polite">
      <div className="measure-title">
        <span>📏 {measurement.title}</span>
        {busy && <span className="muted">…</span>}
      </div>
      {measurement.rows.length === 0 && <div className="muted">Nothing measurable selected</div>}
      <dl>
        {measurement.rows.map((r) => (
          <div key={r.label} className="measure-row">
            <dt>{r.label}</dt>
            <dd
              title="Click to copy"
              onClick={() => navigator.clipboard?.writeText("value" in r ? String(Math.round(r.value * 1e6) / 1e6) : r.text).catch(() => {})}
            >
              {fmt(r)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
