// Export: the format, which bodies, one file or one per body, mesh quality.
// The choices are remembered in this browser for next time.

import { useEffect, useState } from "react";
import type { BodyId, MeshQuality } from "../model/types";
import { EXPORT_FORMATS, type ExportFormat } from "./exporters";
import { Icon } from "../ui/icons";

export interface ExportOptions {
  format: ExportFormat;
  /** Bodies to export; empty means all. */
  bodies: BodyId[];
  /** Keep bodies apart (3MF: separate objects; other mesh formats: one file each, zipped). */
  separate: boolean;
  quality: MeshQuality;
}

const KEY = "openshape.export.v1";

function remembered(): Omit<ExportOptions, "bodies"> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { format: "3mf", separate: true, quality: "normal", ...(JSON.parse(raw) as Partial<ExportOptions>) };
  } catch {
    /* preference only */
  }
  return { format: "3mf", separate: true, quality: "normal" };
}

export function ExportDialog({
  bodies,
  preselected,
  onExport,
  onClose,
}: {
  bodies: { id: BodyId; name: string }[];
  /** A body selected in the model: exported alone by default. */
  preselected: BodyId | null;
  onExport: (o: ExportOptions) => void;
  onClose: () => void;
}) {
  const start = remembered();
  const [format, setFormat] = useState<ExportFormat>(start.format);
  const [separate, setSeparate] = useState(start.separate);
  const [quality, setQuality] = useState<MeshQuality>(start.quality);
  const [chosen, setChosen] = useState<Set<BodyId>>(() => new Set(preselected ? [preselected] : bodies.map((b) => b.id)));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const mesh = format !== "step";
  const many = chosen.size > 1;
  const go = () => {
    const o: ExportOptions = { format, separate, quality, bodies: chosen.size === bodies.length ? [] : [...chosen] };
    try {
      localStorage.setItem(KEY, JSON.stringify({ format, separate, quality }));
    } catch {
      /* preference only */
    }
    onClose();
    onExport(o);
  };

  return (
    <div className="palette-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog export-dialog" role="dialog" aria-label="Export">
        <div className="dialog-head">
          <Icon name="export" /> <strong>Export</strong>
          <button className="ghost" onClick={onClose} title="Close (Esc)" aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        <h2>Format</h2>
        <div className="format-list" role="radiogroup">
          {EXPORT_FORMATS.map((f) => (
            <label key={f.id} className={`format-option${format === f.id ? " chosen" : ""}`}>
              <input type="radio" name="format" checked={format === f.id} onChange={() => setFormat(f.id)} />
              <strong>{f.label}</strong>
              <span className="muted">{f.hint}</span>
            </label>
          ))}
        </div>
        {bodies.length > 1 && (
          <>
            <h2>Bodies</h2>
            {bodies.map((b) => (
              <label key={b.id} className="field check">
                <input
                  type="checkbox"
                  checked={chosen.has(b.id)}
                  onChange={(e) => {
                    const next = new Set(chosen);
                    if (e.target.checked) next.add(b.id);
                    else next.delete(b.id);
                    setChosen(next);
                  }}
                />
                <span>{b.name}</span>
              </label>
            ))}
            {mesh && many && (
              <label className="field check" title={format === "3mf" ? "Each body is its own object in the 3MF" : "One file per body, in a zip"}>
                <input type="checkbox" checked={separate} onChange={(e) => setSeparate(e.target.checked)} />
                <span>{format === "3mf" ? "Separate objects" : "One file per body (zip)"}</span>
              </label>
            )}
          </>
        )}
        {mesh && (
          <>
            <h2>Mesh quality</h2>
            <div className="segmented" role="radiogroup">
              {(["draft", "normal", "fine"] as const).map((q) => (
                <button key={q} className={quality === q ? "active" : ""} onClick={() => setQuality(q)} title={q === "draft" ? "0.05 mm, small files" : q === "normal" ? "0.01 mm" : "0.002 mm, smooth curves, big files"}>
                  {q === "draft" ? "Draft" : q === "normal" ? "Normal" : "Fine"}
                </button>
              ))}
            </div>
          </>
        )}
        <div className="dialog-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!chosen.size} onClick={go}>
            Export {chosen.size === bodies.length ? (bodies.length > 1 ? "all bodies" : "") : `${chosen.size} bod${chosen.size === 1 ? "y" : "ies"}`}
          </button>
        </div>
      </div>
    </div>
  );
}
