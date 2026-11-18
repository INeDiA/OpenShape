// Printer settings: build volume, nozzle, material, slicer settings for the estimates.

import { useEffect } from "react";
import { BEDS, MATERIALS, type PrinterProfile } from "./profile";
import { Icon } from "../ui/icons";

function Num({ label, value, onChange, step = 1, min = 0, suffix }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number; suffix?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="num-with-suffix">
        <input type="number" value={value} step={step} min={min} onChange={(e) => Number.isFinite(e.target.valueAsNumber) && e.target.valueAsNumber >= min && onChange(e.target.valueAsNumber)} />
        {suffix && <span className="suffix">{suffix}</span>}
      </span>
    </label>
  );
}

export function PrinterDialog({ profile, onChange, onClose }: { profile: PrinterProfile; onChange: (p: PrinterProfile) => void; onClose: () => void }) {
  const set = (patch: Partial<PrinterProfile>) => onChange({ ...profile, ...patch });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const preset = BEDS.find((b) => b.bed.every((v, k) => v === profile.bed[k]))?.name ?? "";
  return (
    <div className="palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog printer-dialog" role="dialog" aria-label="Printer settings">
        <div className="dialog-head">
          <Icon name="print" /> <strong>Printer</strong>
          <button className="ghost" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <h2>Build volume</h2>
        <label className="field">
          <span>Preset</span>
          <select value={preset} onChange={(e) => e.target.value && set({ bed: BEDS.find((b) => b.name === e.target.value)!.bed })}>
            <option value="">Custom</option>
            {BEDS.map((b) => (
              <option key={b.name}>{b.name}</option>
            ))}
          </select>
        </label>
        {(["X", "Y", "Z"] as const).map((axis, k) => (
          <Num key={axis} label={axis} value={profile.bed[k]} min={1} suffix="mm" onChange={(v) => set({ bed: profile.bed.map((x, j) => (j === k ? v : x)) as PrinterProfile["bed"] })} />
        ))}
        <label className="field check">
          <input type="checkbox" checked={profile.showBed} onChange={(e) => set({ showBed: e.target.checked })} />
          <span>Show the bed under the model</span>
        </label>
        <h2>Extrusion</h2>
        <Num label="Nozzle" value={profile.nozzle} step={0.05} min={0.05} suffix="mm" onChange={(nozzle) => set({ nozzle })} />
        <Num label="Layer height" value={profile.layer} step={0.02} min={0.01} suffix="mm" onChange={(layer) => set({ layer })} />
        <Num label="Walls" value={profile.perimeters} step={1} min={1} onChange={(perimeters) => set({ perimeters: Math.round(perimeters) })} />
        <Num label="Infill" value={Math.round(profile.infill * 100)} step={5} suffix="%" onChange={(v) => set({ infill: Math.min(100, v) / 100 })} />
        <h2>Material</h2>
        <label className="field">
          <span>Material</span>
          <select
            value={MATERIALS.some((m) => m.name === profile.material) ? profile.material : ""}
            onChange={(e) => {
              const m = MATERIALS.find((x) => x.name === e.target.value);
              if (m) set({ material: m.name, density: m.density, pricePerKg: m.price });
            }}
          >
            <option value="">Custom</option>
            {MATERIALS.map((m) => (
              <option key={m.name}>{m.name}</option>
            ))}
          </select>
        </label>
        <Num label="Density" value={profile.density} step={0.01} min={0.1} suffix="g/cm³" onChange={(density) => set({ density, material: "Custom" })} />
        <Num label="Price" value={profile.pricePerKg} step={1} suffix="€/kg" onChange={(pricePerKg) => set({ pricePerKg })} />
        <p className="muted">Saved in this browser. Select a body to see its weight and cost; the walls ({profile.perimeters} × {profile.nozzle} mm) count as solid.</p>
      </div>
    </div>
  );
}
