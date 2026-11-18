import type { Measurement, MeasureRow } from "../model/types";
import { estimatePrint, fitsBed, type PrinterProfile } from "../print/profile";

const fmt = (r: MeasureRow) => {
  if ("text" in r) return r.text;
  const digits = r.unit === "mm³" || r.unit === "mm²" ? (Math.abs(r.value) >= 1000 ? 0 : 2) : 2;
  const v = r.value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  return r.unit === "°" ? `${v}°` : `${v} ${r.unit}`;
};

/** Read-out of the measurements of the current model selection. */
export function MeasurePanel({ measurement, busy, printer }: { measurement: Measurement | null; busy: boolean; printer?: PrinterProfile }) {
  if (!measurement) return busy ? <div className="measure-panel muted">Measuring…</div> : null;
  // A body: what printing it takes, with the printer profile.
  const b = measurement.body;
  const print = b && printer ? estimatePrint(b.volume, b.area, printer) : null;
  const extra: MeasureRow[] =
    b && print && printer
      ? [
          { label: `Weight (${printer.material}, ${Math.round(printer.infill * 100)}%)`, text: `≈ ${print.grams.toFixed(1)} g · solid ${print.solidGrams.toFixed(1)} g` },
          { label: "Material cost", text: `≈ ${print.cost.toFixed(2)} €` },
          { label: "Build volume", text: fitsBed(b.size, printer.bed) ? `fits (${printer.bed.join(" × ")} mm)` : `too big for ${printer.bed.join(" × ")} mm` },
        ]
      : [];
  const rows = [...measurement.rows, ...extra];
  return (
    <div className="measure-panel" aria-live="polite">
      <div className="measure-title">
        <span>📏 {measurement.title}</span>
        {busy && <span className="muted">…</span>}
      </div>
      {rows.length === 0 && <div className="muted">Nothing measurable selected</div>}
      <dl>
        {rows.map((r) => (
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
