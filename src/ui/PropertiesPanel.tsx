import type { BooleanOp, Feature, FeatureStatus, PlaneName, SketchFeature } from "../model/types";
import { isDimension } from "../sketch/model";
import { findLoops } from "../sketch/profiles";

interface Props {
  feature: Feature | null;
  sketches: SketchFeature[];
  status?: FeatureStatus;
  onChange: (patch: Partial<Feature>) => void;
  onEditSketch: (id: string) => void;
  canEditSketch: boolean;
}

function Num({ label, value, onChange, step = 1, min }: { label: string; value: number; onChange: (v: number) => void; step?: number; min?: number }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        value={value}
        step={step}
        min={min}
        onChange={(e) => {
          const v = e.target.valueAsNumber;
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </label>
  );
}

function Select<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}

const OPS: [BooleanOp, string][] = [
  ["new", "New body"],
  ["join", "Join"],
  ["cut", "Cut"],
  ["intersect", "Intersect"],
];
const PLANES: [PlaneName, string][] = [
  ["XY", "XY (top)"],
  ["XZ", "XZ (front)"],
  ["YZ", "YZ (right)"],
];

export function PropertiesPanel({ feature: f, sketches, status, onChange, onEditSketch, canEditSketch }: Props) {
  if (!f) {
    return (
      <aside className="panel props">
        <h2>Properties</h2>
        <p className="muted">Select a feature in the history.</p>
      </aside>
    );
  }

  return (
    <aside className="panel props">
      <h2>{f.name}</h2>
      {status && !status.ok && <p className="error-msg">{status.error}</p>}

      {f.type === "sketch" && (
        <>
          <Select label="Plane" value={f.plane} options={PLANES} onChange={(plane) => onChange({ plane })} />
          <Num label="Plane offset" value={f.offset} onChange={(offset) => onChange({ offset })} />
          <button className="wide" disabled={!canEditSketch} onClick={() => onEditSketch(f.id)}>
            ✎ Edit sketch
          </button>
          <SketchSummary feature={f} />
        </>
      )}

      {(f.type === "extrude" || f.type === "revolve") && (
        <>
          <Select
            label="Sketch"
            value={f.sketchId}
            options={sketches.map((s) => [s.id, s.name] as [string, string])}
            onChange={(sketchId) => onChange({ sketchId })}
          />
          <Select label="Operation" value={f.op} options={OPS} onChange={(op) => onChange({ op })} />
          {f.type === "extrude" ? (
            <Num label="Distance" value={f.distance} onChange={(distance) => onChange({ distance })} />
          ) : (
            <>
              <Select
                label="Axis"
                value={f.axis}
                options={[["X", "X"], ["Y", "Y"], ["Z", "Z"]]}
                onChange={(axis) => onChange({ axis })}
              />
              <Num label="Angle °" value={f.angle} min={1} onChange={(angle) => onChange({ angle })} />
            </>
          )}
        </>
      )}

      {(f.type === "fillet" || f.type === "chamfer") && (
        <>
          <Num label={f.type === "fillet" ? "Radius" : "Distance"} value={f.size} min={0.1} step={0.5} onChange={(size) => onChange({ size })} />
          <p className="muted">Applied to all edges. Edge selection coming next.</p>
        </>
      )}
    </aside>
  );
}

function SketchSummary({ feature }: { feature: SketchFeature }) {
  const { entities, constraints } = feature.sketch;
  const curves = entities.filter((e) => e.kind !== "point").length;
  const { loops } = findLoops(feature.sketch);
  const dims = constraints.filter(isDimension);
  return (
    <div className="summary">
      <p className="muted">
        {curves} curves · {loops.length} closed profile{loops.length === 1 ? "" : "s"} · {constraints.length} constraints
      </p>
      {dims.length > 0 && (
        <ul className="dims">
          {dims.map((d) => (
            <li key={d.id}>
              <span>{d.kind}</span>
              <span>{d.kind === "angle" ? `${d.value}°` : d.kind === "radius" ? `R${d.value}` : d.value}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted">Double-click the sketch in the history to edit it.</p>
    </div>
  );
}
