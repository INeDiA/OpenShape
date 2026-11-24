// Building blocks for Split, Face Offset, Replace Face and Symmetry.

import { basicFaceExtrusion, cast, getOC, measureDistanceBetween, measureVolume, makeCircle, makeVertex, makeLine, makePolygon, makeThreePointArc, Vector, type Edge, type Face, type Shape3D } from "replicad";
import { frameToWorld, planeFrame, type Frame, type Vec3 } from "../model/frame";
import type { SketchFeature } from "../model/types";
import { entityMap, pointOf } from "../sketch/model";
import { arcMidpoint } from "../sketch/profiles";
import { curvePolyline } from "../sketch/curves";

const wrapped = (s: unknown) => (s as { wrapped: unknown }).wrapped;

function thickSolid(face: Face, distance: number): Shape3D {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const maker = new oc.BRepOffsetAPI_MakeThickSolid();
  // A deep copy of the face: the thick solid would otherwise share the body's
  // own face, and the Boolean that joins them then returns nothing.
  const trsf = new oc.gp_Trsf();
  const copier = new oc.BRepBuilderAPI_Transform(wrapped(face), trsf, true, false);
  try {
    maker.MakeThickSolidBySimple(copier.Shape(), distance);
    if (!maker.IsDone()) throw new Error(`Can't offset the face by ${distance} mm`);
    return cast(maker.Shape()) as Shape3D;
  } finally {
    maker.delete();
    copier.delete();
    trsf.delete();
  }
}

/**
 * The solid swept by a face moved `distance` along its outward normal `n`
 * (taken at the point `p` of the face). It follows curved faces: a hole's
 * wall thickened inward is a tube.
 */
export function thickenFace(face: Face, distance: number, p: Vec3, n: Vec3): Shape3D {
  // OCCT doesn't follow the face's orientation consistently (planes and
  // cylinders differ): keep the result that reaches the offset point.
  const reach: Vec3 = [p[0] + n[0] * distance, p[1] + n[1] * distance, p[2] + n[2] * distance];
  const v = makeVertex(reach);
  let solid = thickSolid(face, distance);
  try {
    if (measureDistanceBetween(v, solid) > Math.abs(distance) / 2) {
      solid.delete();
      solid = thickSolid(face, -distance);
    }
  } finally {
    v.delete();
  }
  // The result can also come out inside out (negative volume), which Booleans misread.
  if (measureVolume(solid) >= 0) return solid;
  const flipped = cast((solid as unknown as { wrapped: { Reversed(): unknown } }).wrapped.Reversed() as Parameters<typeof cast>[0]) as Shape3D;
  solid.delete();
  return flipped;
}

/** The sketch's curves (not construction geometry) as 3D edges on its plane. */
export function sketchEdges(f: SketchFeature, frame: Frame): Edge[] {
  const m = entityMap(f.sketch);
  const w = (p: { x: number; y: number } | [number, number]) => (Array.isArray(p) ? frameToWorld(frame, p[0], p[1]) : frameToWorld(frame, p.x, p.y));
  const out: Edge[] = [];
  for (const e of f.sketch.entities) {
    if (e.kind === "point" || e.construction) continue;
    if (e.kind === "line") {
      const a = w(pointOf(m, e.p1)), b = w(pointOf(m, e.p2));
      if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 1e-9) out.push(makeLine(a, b));
    } else if (e.kind === "circle") {
      out.push(makeCircle(e.radius, w(pointOf(m, e.center)), frame.n));
    } else if (e.kind === "arc") {
      out.push(makeThreePointArc(w(pointOf(m, e.start)), w(arcMidpoint(m, e)), w(pointOf(m, e.end))));
    } else {
      // Ellipses and splines: a fine polyline is enough to split faces with.
      const pts = curvePolyline(m, e, 48).map(w);
      for (let i = 1; i < pts.length; i++) out.push(makeLine(pts[i - 1], pts[i]));
    }
  }
  return out;
}

/**
 * A big box on one side of the plane through `point` with normal `n`: the
 * side `n` points to when `side` is 1, the other when -1. `size` must exceed
 * the model (it's the box's half width and its depth).
 */
export function halfSpace(point: Vec3, n: Vec3, size: number, side: 1 | -1): Shape3D {
  const fr = planeFrame(point, n);
  // Centre the square on the point's projection, not on the frame origin.
  const c: Vec3 = [point[0], point[1], point[2]];
  const corner = (u: number, v: number): Vec3 => [c[0] + fr.x[0] * u + fr.y[0] * v, c[1] + fr.x[1] * u + fr.y[1] * v, c[2] + fr.x[2] * u + fr.y[2] * v];
  const square = makePolygon([corner(-size, -size), corner(size, -size), corner(size, size), corner(-size, size)]);
  const k = side * size;
  return basicFaceExtrusion(square, new Vector([fr.n[0] * k, fr.n[1] * k, fr.n[2] * k])) as Shape3D;
}

/** The face extruded by `distance` along `dir`. */
export function prism(face: Face, dir: Vec3, distance: number): Shape3D {
  return basicFaceExtrusion(face, new Vector([dir[0] * distance, dir[1] * distance, dir[2] * distance])) as Shape3D;
}

/** Whether a shape has any volume left (Booleans can return an empty compound). */
export const hasSolid = (s: Shape3D) => s.faces.length > 0;

/** A point's projection on the plane through `origin` with unit normal `n`. */
export function projectOnPlane(p: Vec3, origin: Vec3, n: Vec3): Vec3 {
  const d = (p[0] - origin[0]) * n[0] + (p[1] - origin[1]) * n[1] + (p[2] - origin[2]) * n[2];
  return [p[0] - n[0] * d, p[1] - n[1] * d, p[2] - n[2] * d];
}
