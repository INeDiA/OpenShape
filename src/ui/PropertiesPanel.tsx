import type { BooleanOp, Feature, FeatureStatus, PlaneName, SketchFeature } from "../model/types";
import type { Scope } from "../expr/expr";
import { isDimension, sketchLines } from "../sketch/model";
import { ExprInput } from "./ExprInput";
import { findLoops } from "../sketch/profiles";
import { useEffect, useState } from "react";

/** Feature name, edited in place; commits on Enter or blur, Escape restores it. */
function NameInput({ name, onRename }: { name: string; onRename: (name: string) => void }) {
  const [text, setText] = useState(name);
  useEffect(() => setText(name), [name]);
  const done = () => {
    const t = text.trim();
    if (t && t !== name) onRename(t);
    else setText(name);
  };
  return (
    <input
      className="name-input"
      value={text}
      title="Rename"
      aria-label="Feature name"
      onChange={(e) => setText(e.target.value)}
      onBlur={done}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        else if (e.key === "Escape") {
          setText(name);
          setTimeout(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}

interface Props {
  feature: Feature | null;
  sketches: SketchFeature[];
  status?: FeatureStatus;
  onChange: (patch: Partial<Feature>) => void;
  onEditSketch: (id: string) => void;
  canEditSketch: boolean;
  scope: Scope;
  /** Starts a sketch on a construction plane. */
  onSketchOnPlane: (planeId: string) => void;
  /** Bodies of the shown model (for Booleans). */
  bodies: { id: string; name: string }[];
  /** Draft: pick the neutral face again in the viewport. */
  onPickNeutral: () => void;
  pickingNeutral: boolean;
}

function Check({ label, checked, onChange, title }: { label: string; checked: boolean; onChange: (v: boolean) => void; title?: string }) {
  return (
    <label className="field check" title={title}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Numeric feature parameter that accepts expressions; stores the source in feature.exprs. */
function Field({ label, feature, field, scope, onChange, min }: { label: string; feature: Feature; field: string; scope: Scope; onChange: (patch: Partial<Feature>) => void; min?: number }) {
  const value = (feature as unknown as Record<string, number>)[field];
  return (
    <label className="field">
      <span>{label}</span>
      <ExprInput
        value={value}
        expr={feature.exprs?.[field]}
        scope={scope}
        min={min}
        onCommit={({ value: v, expr }) => {
          const exprs = { ...feature.exprs };
          if (expr) exprs[field] = expr;
          else delete exprs[field];
          onChange({ [field]: v, exprs } as Partial<Feature>);
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

export function PropertiesPanel({ feature: f, sketches, status, onChange, onEditSketch, canEditSketch, scope, bodies, onSketchOnPlane, onPickNeutral, pickingNeutral }: Props) {
  const sketchOptions = sketches.map((s) => [s.id, s.name] as [string, string]);
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
      <h2>Properties</h2>
      <NameInput key={f.id} name={f.name} onRename={(name) => onChange({ name })} />
      {status && !status.ok && <p className="error-msg">{status.error}</p>}

      {f.type === "sketch" && (
        <>
          {f.planeId ? (
            <p className="muted">On a construction plane: it follows the plane when the model changes.</p>
          ) : f.face ? (
            <p className="muted">
              On face <code title={f.face}>{shortName(f.face)}</code>. It follows the face when upstream features change.
            </p>
          ) : (
            <Select label="Plane" value={f.plane} options={PLANES} onChange={(plane) => onChange({ plane })} />
          )}
          <Field label="Plane offset" feature={f} field="offset" scope={scope} onChange={onChange} />
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
            <>
              <Field label={f.throughAll && (f.op === "cut" || f.op === "intersect") ? "Direction (sign)" : "Distance"} feature={f} field="distance" scope={scope} onChange={onChange} />
              {(f.op === "cut" || f.op === "intersect") && (
                <Check label="Through all" checked={!!f.throughAll} onChange={(throughAll) => onChange({ throughAll })} title="Cut through the whole body; the distance only gives the direction" />
              )}
            </>
          ) : (
            <>
              <Select
                label="Axis"
                value={f.axisLine ?? f.axis}
                options={[
                  ...sketchLines(sketches.find((s) => s.id === f.sketchId)?.sketch ?? { entities: [], constraints: [] }).map((l) => [l.id, l.label] as [string, string]),
                  ["X", "World X"],
                  ["Y", "World Y"],
                  ["Z", "World Z"],
                ]}
                onChange={(v) => onChange(v === "X" || v === "Y" || v === "Z" ? { axis: v, axisLine: undefined } : { axisLine: v })}
              />
              <Field label="Angle °" feature={f} field="angle" scope={scope} min={0.01} onChange={onChange} />
            </>
          )}
        </>
      )}

      {f.type === "sweep" && (
        <>
          <Select label="Profile" value={f.sketchId} options={sketchOptions} onChange={(sketchId) => onChange({ sketchId, regions: undefined })} />
          <Select label="Path" value={f.pathId} options={sketchOptions} onChange={(pathId) => onChange({ pathId })} />
          <Select label="Operation" value={f.op} options={OPS} onChange={(op) => onChange({ op })} />
          <p className="muted">The profile's closed regions move along the path: one chain of lines, arcs and splines, or a single closed curve, in another sketch.</p>
        </>
      )}

      {f.type === "loft" && (
        <>
          <div className="sections">
            {f.sections.map((id, i) => (
              <div className="section-row" key={i}>
                <Select
                  label={`Profile ${i + 1}`}
                  value={id}
                  options={sketchOptions}
                  onChange={(v) => onChange({ sections: f.sections.map((x, k) => (k === i ? v : x)) })}
                />
                <button title="Remove this profile" disabled={f.sections.length <= 2} onClick={() => onChange({ sections: f.sections.filter((_, k) => k !== i) })}>
                  ×
                </button>
              </div>
            ))}
            <button
              className="wide"
              disabled={!sketches.some((s) => !f.sections.includes(s.id))}
              onClick={() => onChange({ sections: [...f.sections, sketches.find((s) => !f.sections.includes(s.id))!.id] })}
            >
              + Add profile
            </button>
          </div>
          <Check label="Straight sides (ruled)" checked={f.ruled} onChange={(ruled) => onChange({ ruled })} />
          <Select label="Operation" value={f.op} options={OPS} onChange={(op) => onChange({ op })} />
          <p className="muted">Each sketch gives its largest closed profile; the solid passes through them in this order.</p>
        </>
      )}

      {f.type === "boolean" && (
        <>
          <Select
            label="Operation"
            value={f.op}
            options={[
              ["join", "Union"],
              ["cut", "Subtract"],
              ["intersect", "Intersect"],
            ]}
            onChange={(op) => onChange({ op })}
          />
          <Select
            label="Target"
            value={f.target}
            options={[["", "Click a body…"], ...bodies.map((b) => [b.id, b.name] as [string, string])]}
            onChange={(target) => onChange({ target, tools: f.tools.filter((t) => t !== target) })}
          />
          <p>
            <strong>
              {f.tools.length} tool bod{f.tools.length === 1 ? "y" : "ies"}
            </strong>
          </p>
          <ul className="body-list">
            {f.tools.map((t) => (
              <li key={t}>
                <span>{bodies.find((b) => b.id === t)?.name ?? "Missing body"}</span>
                <button className="ghost" title="Remove" onClick={() => onChange({ tools: f.tools.filter((x) => x !== t) })}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          {f.op === "cut" && (
            <Field label="Clearance (mm)" feature={{ ...f, clearance: f.clearance ?? 0 }} field="clearance" scope={scope} min={0} onChange={onChange} />
          )}
          <Check label="Keep tool bodies" checked={f.keepTools} onChange={(keepTools) => onChange({ keepTools })} />
          <p className="muted">
            The target keeps its name; the tools are {f.keepTools ? "kept as they are" : "used up"}.
            {f.op === "cut" && " Clearance leaves that gap all around the tools (e.g. 0.2 mm for printed parts that fit together; keep the tools to use them as the mating part)."} Click bodies in the
            viewport to add or remove tools.
          </p>
        </>
      )}

      {f.type === "draft" && (
        <>
          <Field label="Angle °" feature={f} field="angle" scope={scope} onChange={onChange} />
          <p>
            Neutral face: {f.neutral ? <code title={f.neutral}>{shortName(f.neutral)}</code> : <strong>not picked</strong>}
          </p>
          <button className="wide" disabled={pickingNeutral} onClick={onPickNeutral}>
            {pickingNeutral ? "Click the neutral face…" : "Pick the neutral face"}
          </button>
          <p>
            <strong>
              {f.faces.length} face{f.faces.length === 1 ? "" : "s"} to draft
            </strong>
          </p>
          <p className="muted">Faces tilt about where they meet the neutral face's plane; a positive angle narrows the part away from it. Click faces in the viewport to add or remove them.</p>
        </>
      )}

      {f.type === "pushpull" && (
        <>
          <Field label="Distance" feature={f} field="distance" scope={scope} onChange={onChange} />
          <p className="muted">
            Face <code title={f.face}>{shortName(f.face)}</code>. Positive adds material, negative removes it. Click another planar face to change it.
          </p>
        </>
      )}

      {f.type === "plane" && (
        <>
          <Select
            label="Type"
            value={f.mode}
            options={[
              ["offset", "Offset"],
              ["angle", "At an angle"],
              ["midplane", "Midplane"],
              ["normal", "Normal to edge"],
            ]}
            onChange={(mode) => onChange({ mode })}
          />
          {f.mode === "offset" && !f.face && <Select label="From" value={f.base ?? "XY"} options={PLANES} onChange={(base) => onChange({ base })} />}
          {f.mode === "offset" && <Field label="Distance" feature={f} field="distance" scope={scope} onChange={onChange} />}
          {f.mode === "angle" && <Field label="Angle °" feature={f} field="angle" scope={scope} onChange={onChange} />}
          {f.mode === "normal" && <Field label="Position (0–1)" feature={f} field="position" scope={scope} onChange={onChange} />}
          <p className="muted">
            {f.face && (
              <>
                Face <code title={f.face}>{shortName(f.face)}</code>
                {f.face2 && (
                  <>
                    {" "}
                    and <code title={f.face2}>{shortName(f.face2)}</code>
                  </>
                )}
                .{" "}
              </>
            )}
            {f.edge && (
              <>
                Edge <code title={f.edge}>{shortName(f.edge)}</code>.{" "}
              </>
            )}
            To change them, select the faces or edges and add a new plane.
          </p>
          <button className="wide" disabled={!canEditSketch} onClick={() => onSketchOnPlane(f.id)}>
            ✎ Sketch on this plane
          </button>
        </>
      )}

      {f.type === "layflat" && (
        <p className="muted">
          Face <code title={f.face}>{shortName(f.face)}</code> lies on the bed (z = 0), facing down: the print orientation. Click another planar face to change it; turn on ⚠ Overhangs to compare.
        </p>
      )}

      {f.type === "shell" && (
        <>
          <Field label="Thickness" feature={f} field="thickness" scope={scope} min={0.001} onChange={onChange} />
          <p>
            <strong>{f.faces.length} open face{f.faces.length === 1 ? "" : "s"}</strong>
          </p>
          <p className="muted">Click faces in the viewport to open or close them.</p>
        </>
      )}

      {f.type === "mirror" && (
        <>
          <Select label="Plane" value={f.plane} options={PLANES} onChange={(plane) => onChange({ plane })} />
          <Field label="Plane offset" feature={f} field="offset" scope={scope} onChange={onChange} />
        </>
      )}

      {f.type === "pattern" && (
        <>
          <Select label="Type" value={f.mode} options={[["linear", "Linear"], ["circular", "Circular"]]} onChange={(mode) => onChange({ mode })} />
          <Select label="Axis" value={f.axis} options={[["X", "X"], ["Y", "Y"], ["Z", "Z"]]} onChange={(axis) => onChange({ axis })} />
          <Field label="Count" feature={f} field="count" scope={scope} min={2} onChange={onChange} />
          {f.mode === "linear" ? (
            <Field label="Spacing" feature={f} field="spacing" scope={scope} onChange={onChange} />
          ) : (
            <Field label="Angle °" feature={f} field="angle" scope={scope} onChange={onChange} />
          )}
          {f.mode === "circular" && <p className="muted">360° spreads the copies evenly around the axis through the origin.</p>}
        </>
      )}

      {f.type === "import" && (
        <>
          <p>
            <strong>{f.fileName}</strong> ({f.format.toUpperCase()}, {Math.round((f.data.length * 0.75) / 1024)} KB)
          </p>
          <Select label="Operation" value={f.op} options={OPS} onChange={(op) => onChange({ op })} />
          <p className="muted">The file is embedded in the document.</p>
        </>
      )}

      {f.type === "cove" && (
        <>
          <Field label="Radius" feature={f} field="size" scope={scope} min={0.001} onChange={onChange} />
          <div className="edge-pick">
            <p>
              <strong>{f.edges.length} edge{f.edges.length === 1 ? "" : "s"} selected</strong>
            </p>
            <p className="muted">A quarter-round groove centred on each edge. Click edges in the viewport to add or remove them.</p>
          </div>
        </>
      )}

      {(f.type === "fillet" || f.type === "chamfer") && (
        <>
          <Field label={f.type === "fillet" ? "Radius" : "Distance"} feature={f} field="size" scope={scope} min={0.001} onChange={onChange} />
          <div className="edge-pick">
            <p>
              {f.edges.length === 0 ? <strong>All edges</strong> : <strong>{f.edges.length} edge{f.edges.length === 1 ? "" : "s"} selected</strong>}
            </p>
            <p className="muted">Click edges in the viewport to choose them. References use persistent names, so they survive upstream changes.</p>
            {f.edges.length > 0 && (
              <button className="wide" onClick={() => onChange({ edges: [] })}>
                Use all edges
              </button>
            )}
          </div>
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

/** Readable tail of a persistent name, e.g. "…:end". */
function shortName(n: string) {
  return n.length > 28 ? `…${n.slice(-26)}` : n;
}
