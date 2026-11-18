// Measurements of the current selection: faces, edges and bodies, alone or
// in pairs (distance, angle). Runs in the kernel worker on an evaluated model.

import { measureArea, measureDistanceBetween, measureLength, measureShapeVolumeProperties, measureVolume, type Edge, type Face, type Shape3D } from "replicad";
import type { Measurement, MeasureRow, MeasureSelection } from "../model/types";
import type { Vec3 } from "../model/frame";
import type { EvaluationResult } from "./evaluate";
import { faceSamples, nameEdges } from "./naming";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: Vec3) => Math.hypot(...a);
const unit = (a: Vec3): Vec3 => {
  const l = len(a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const tuple = (v: { toTuple(): number[] }) => v.toTuple() as Vec3;

/** Circle through three points in space (center and radius), or null when they're in line. */
export function circle3(a: Vec3, b: Vec3, c: Vec3): { center: Vec3; r: number } | null {
  const ab = sub(b, a), ac = sub(c, a);
  const n = cross(ab, ac);
  const n2 = dot(n, n);
  if (n2 < 1e-18) return null;
  // Circumcenter: a + ((|ac|² (n × ab)) + (|ab|² (ac × n))) / (2 |n|²)
  const t1 = cross(n, ab), t2 = cross(ac, n);
  const k1 = dot(ac, ac), k2 = dot(ab, ab);
  const center: Vec3 = [0, 1, 2].map((i) => a[i] + (k1 * t1[i] + k2 * t2[i]) / (2 * n2)) as Vec3;
  return { center, r: len(sub(a, center)) };
}

function edgeInfo(e: Edge): { kind: "line"; dir: Vec3 } | { kind: "circle"; center: Vec3; r: number } | { kind: "other" } {
  const type = e.geomType;
  if (type === "LINE") return { kind: "line", dir: unit(sub(tuple(e.endPoint), tuple(e.startPoint))) };
  if (type === "CIRCLE") {
    const c = circle3(tuple(e.pointAt(0)), tuple(e.pointAt(0.37)), tuple(e.pointAt(0.71)));
    if (c) return { kind: "circle", ...c };
  }
  return { kind: "other" };
}

const mm = (label: string, value: number): MeasureRow => ({ label, value, unit: "mm" });

/** Measures the named faces/edges (or a body) of an evaluated model. */
export function measureSelection(result: EvaluationResult, sel: MeasureSelection): Measurement {
  const body = result.body;
  if (!body) return { title: "Nothing to measure", rows: [] };

  if (sel.body) {
    const b = result.bodies.find((x) => x.id === sel.body);
    if (!b) return { title: "Body not found", rows: [] };
    const s = b.shape.shape as Shape3D;
    const props = measureShapeVolumeProperties(s);
    const com = props.centerOfMass as Vec3;
    props.delete();
    const bb = s.boundingBox.bounds;
    const volume = measureVolume(s), area = measureArea(s);
    return {
      title: "Body",
      body: { volume, area, size: [0, 1, 2].map((k) => bb[1][k] - bb[0][k]) as [number, number, number] },
      rows: [
        { label: "Volume", value: volume, unit: "mm³" },
        { label: "Surface area", value: area, unit: "mm²" },
        { label: "Size", text: [0, 1, 2].map((k) => fmt(bb[1][k] - bb[0][k])).join(" × ") + " mm" },
        { label: "Center of mass", text: com.map(fmt).join(", ") },
      ],
    };
  }

  const faces: Face[] = [];
  for (const f of body.shape.faces) {
    const n = body.names.get(f.hashCode);
    if (n && sel.faces.some((x) => x === n || x.replace(/#\d+$/, "") === n)) faces.push(f);
  }
  const naming = sel.edges.length ? nameEdges(body.shape, body.names) : null;
  const edges = sel.edges.map((n) => naming?.byName.get(n)).filter((e): e is Edge => !!e);
  const items: ({ kind: "face"; f: Face } | { kind: "edge"; e: Edge })[] = [...faces.map((f) => ({ kind: "face" as const, f })), ...edges.map((e) => ({ kind: "edge" as const, e }))];
  if (!items.length) return { title: "Nothing to measure", rows: [] };

  const normals = faces.length ? faceSamples(body.shape) : null;
  const planeNormal = (f: Face): Vec3 | null => (f.geomType === "PLANE" ? (normals!.get(f.hashCode)?.n ?? null) : null);

  if (items.length === 1) {
    const it = items[0];
    if (it.kind === "face") {
      const f = it.f;
      const rows: MeasureRow[] = [{ label: "Area", value: measureArea(f), unit: "mm²" }];
      const n = planeNormal(f);
      if (n) rows.push({ label: "Normal", text: n.map((v) => fmt(v, 3)).join(", ") });
      if (f.geomType === "CYLINDRE") {
        const c = f.edges.map(edgeInfo).find((x) => x.kind === "circle") as Extract<ReturnType<typeof edgeInfo>, { kind: "circle" }> | undefined;
        if (c) rows.push(mm("Radius", c.r), mm("Diameter", 2 * c.r));
      }
      return { title: `Face (${typeName(f.geomType)})`, rows };
    }
    const e = it.e;
    const info = edgeInfo(e);
    const rows: MeasureRow[] = [mm("Length", measureLength(e))];
    if (info.kind === "circle") rows.push(mm("Radius", info.r), mm("Diameter", 2 * info.r), { label: "Center", text: info.center.map((v) => fmt(v)).join(", ") });
    return { title: `Edge (${typeName(e.geomType)})`, rows };
  }

  if (items.length === 2) {
    const [a, b] = items;
    const sa = a.kind === "face" ? a.f : a.e, sb = b.kind === "face" ? b.f : b.e;
    const rows: MeasureRow[] = [mm("Distance", measureDistanceBetween(sa, sb))];
    // Angle between directions: plane normals and line directions.
    const dirOf = (x: (typeof items)[number]): { v: Vec3; normal: boolean } | null => {
      if (x.kind === "face") {
        const n = planeNormal(x.f);
        return n ? { v: n, normal: true } : null;
      }
      const i = edgeInfo(x.e);
      return i.kind === "line" ? { v: i.dir, normal: false } : null;
    };
    const da = dirOf(a), db = dirOf(b);
    if (da && db) {
      let deg = (Math.acos(Math.max(-1, Math.min(1, Math.abs(dot(da.v, db.v))))) * 180) / Math.PI;
      // A line against a plane: the angle to the plane, not to its normal.
      if (da.normal !== db.normal) deg = 90 - deg;
      rows.push({ label: "Angle", value: deg, unit: "°" });
      if (da.normal && db.normal && deg < 1e-6) {
        // Parallel planes: their gap along the normal.
        const pa = normals!.get((a as { f: Face }).f.hashCode)!.p, pb = normals!.get((b as { f: Face }).f.hashCode)!.p;
        rows.push(mm("Gap along normal", Math.abs(dot(sub(pb, pa), da.v))));
      }
    }
    return { title: `${label(a)} and ${label(b)}`, rows };
  }

  const rows: MeasureRow[] = [];
  if (faces.length) rows.push({ label: `Total area (${faces.length} faces)`, value: faces.reduce((s, f) => s + measureArea(f), 0), unit: "mm²" });
  if (edges.length) rows.push(mm(`Total length (${edges.length} edges)`, edges.reduce((s, e) => s + measureLength(e), 0)));
  return { title: `${items.length} items`, rows };
}

const label = (x: { kind: "face" | "edge" }) => (x.kind === "face" ? "Face" : "Edge");

function typeName(t: string): string {
  const names: Record<string, string> = { PLANE: "plane", CYLINDRE: "cylinder", CONE: "cone", SPHERE: "sphere", TORUS: "torus", LINE: "line", CIRCLE: "arc", ELLIPSE: "ellipse", BSPLINE_SURFACE: "freeform", BSPLINE_CURVE: "spline", BEZIER_CURVE: "spline" };
  return names[t] ?? t.toLowerCase();
}

function fmt(v: number, digits = 2): string {
  const r = Math.round(v * 10 ** digits) / 10 ** digits;
  return Object.is(r, -0) ? "0" : String(r);
}

