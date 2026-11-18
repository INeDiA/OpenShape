// 3D printing helpers for holes: teardrop roofs (horizontal holes print
// without supports) and hole compensation (printed holes come out small).

import { basicFaceExtrusion, getOC, makeBox, makeCylinder, makePolygon, measureVolume, Vector, type Face, type Shape3D } from "replicad";
import type { Vec3 } from "../model/frame";
import { faceSamples } from "./naming";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export interface Cylinder {
  /** A point on the axis, at the start of the face along it. */
  start: Vec3;
  /** Unit axis direction. */
  axis: Vec3;
  radius: number;
  /** Extent of the face along the axis, from `start`. */
  length: number;
  /** A hole (material outside the cylinder) rather than a pin. */
  hole: boolean;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: Vec3, b: Vec3, k = 1): Vec3 => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Axis, radius and extent of a cylindrical face of `shape`. */
export function cylinderOf(shape: Shape3D, face: Face): Cylinder {
  if (face.geomType !== "CYLINDRE") throw new Error("Pick cylindrical faces (holes)");
  const oc = getOC() as Any;
  const adaptor = new oc.BRepAdaptor_Surface((face as unknown as { wrapped: unknown }).wrapped, true);
  const cyl = adaptor.Cylinder();
  const ax = cyl.Axis();
  const loc = ax.Location(), dir = ax.Direction();
  const origin: Vec3 = [loc.X(), loc.Y(), loc.Z()];
  const axis = unit([dir.X(), dir.Y(), dir.Z()]);
  const radius = cyl.Radius();
  for (const o of [loc, dir, ax, cyl, adaptor]) o.delete?.();
  // Extent along the axis from the face's edges.
  let lo = Infinity, hi = -Infinity;
  for (const e of face.edges)
    for (let i = 0; i <= 8; i++) {
      const p = e.pointAt(i / 8);
      const t = dot([p.x - origin[0], p.y - origin[1], p.z - origin[2]], axis);
      lo = Math.min(lo, t);
      hi = Math.max(hi, t);
    }
  // Outward normal pointing at the axis: material outside, a hole.
  const s = faceSamples(shape).get(face.hashCode)!;
  const onAxis = add(origin, axis, dot([s.p[0] - origin[0], s.p[1] - origin[1], s.p[2] - origin[2]], axis));
  const hole = dot(s.n, [onAxis[0] - s.p[0], onAxis[1] - s.p[1], onAxis[2] - s.p[2]]) > 0;
  return { start: add(origin, axis, lo), axis, radius, length: hi - lo, hole };
}

/**
 * The material to remove over a horizontal hole so its top is a 45° roof
 * (pointed, or cut flat at the top of the circle when `flat`): sides at 45°
 * print without supports. A hair longer than the hole so its ends open cleanly.
 */
export function teardropTool(c: Cylinder, flat = false): Shape3D {
  // "Up" across the hole: world Z without its component along the axis.
  const z: Vec3 = [0, 0, 1];
  const up0 = add(z, c.axis, -dot(z, c.axis));
  if (Math.hypot(...up0) < 1e-6) throw new Error("The hole is vertical: it prints fine without a teardrop");
  return roofTool(c, unit(up0), flat);
}

function roofTool(c: Cylinder, up: Vec3, flat: boolean): Shape3D {
  const side = unit(cross(c.axis, up));
  const r = c.radius, k = Math.SQRT1_2;
  const extra = 0.01;
  const base = add(c.start, c.axis, -extra);
  const at = (u: number, v: number) => add(add(base, side, u), up, v);
  const pts: Vec3[] = flat
    ? [at(0, 0), at(r * k, r * k), at(r * (Math.SQRT2 - 1), r), at(-r * (Math.SQRT2 - 1), r), at(-r * k, r * k)]
    : [at(0, 0), at(r * k, r * k), at(0, r * Math.SQRT2), at(-r * k, r * k)];
  const profile = makePolygon(pts);
  return basicFaceExtrusion(profile, new Vector(c.axis).multiply(c.length + 2 * extra)) as unknown as Shape3D;
}

/** A cylinder `amount` wider than a hole, along its whole length: cutting it enlarges the hole. */
export function holeFitTool(c: Cylinder, amount: number): Shape3D {
  if (!c.hole) throw new Error("Hole compensation works on holes (this is a pin)");
  const extra = 0.01;
  return makeCylinder(c.radius + amount, c.length + 2 * extra, add(c.start, c.axis, -extra), c.axis) as unknown as Shape3D;
}

/** Whether `p` lies inside the solid `shape` (a tiny cube there keeps some volume). */
function inside(shape: Shape3D, p: Vec3): boolean {
  const h = 0.01;
  const probe = makeBox([p[0] - h, p[1] - h, p[2] - h], [p[0] + h, p[1] + h, p[2] + h]);
  try {
    return measureVolume(shape.intersect(probe)) > 1e-9;
  } catch {
    return false;
  }
}

/**
 * Where a hole opens to the outside, as a point on its axis and the direction
 * into the material. A through hole opens at both ends: the upper one (or the
 * other with `flip`).
 */
export function holeEntry(shape: Shape3D, c: Cylinder, flip = false): { at: Vec3; into: Vec3 } {
  const eps = 0.05;
  const end = add(c.start, c.axis, c.length);
  // Just beyond each end, next to the wall: open air at an opening, material at a blind bottom.
  const radial = unit(Math.abs(c.axis[2]) < 0.9 ? cross(c.axis, [0, 0, 1]) : cross(c.axis, [1, 0, 0]));
  const probe = (p: Vec3, out: Vec3) => add(add(p, out, eps), radial, c.radius * 0.5);
  const openStart = !inside(shape, probe(c.start, c.axis.map((x) => -x) as Vec3));
  const openEnd = !inside(shape, probe(end, c.axis));
  const fromStart = { at: c.start, into: c.axis };
  const fromEnd = { at: end, into: c.axis.map((x) => -x) as Vec3 };
  let pick: typeof fromStart;
  if (openStart && openEnd) pick = end[2] > c.start[2] + 1e-6 || (Math.abs(end[2] - c.start[2]) <= 1e-6 && dot(c.axis, [1, 1, 1]) > 0) ? fromEnd : fromStart;
  else if (openStart) pick = fromStart;
  else if (openEnd) pick = fromEnd;
  else throw new Error("The hole doesn't open to the outside");
  if (flip && openStart && openEnd) pick = pick === fromEnd ? fromStart : fromEnd;
  return pick;
}

/** The seat for a heat-set insert: a cylinder of `diameter` from the hole's opening, `depth` deep. */
export function insertTool(shape: Shape3D, c: Cylinder, diameter: number, depth: number, flip = false): Shape3D {
  if (!c.hole) throw new Error("Insert seats go in holes (this is a pin)");
  if (diameter / 2 < c.radius - 1e-6) throw new Error(`The hole (Ø ${(c.radius * 2).toFixed(2)}) is already wider than the insert seat`);
  const { at, into } = holeEntry(shape, c, flip);
  const extra = 0.01;
  return makeCylinder(diameter / 2, depth + extra, add(at, into, -extra), into) as unknown as Shape3D;
}
