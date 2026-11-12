// Vertex blends with setback: where fillets of different radii meet at a
// corner, OCCT's own corner patch can come out hook-shaped. This replaces the
// corner by cutting a ball of radius `setback` around the vertex and filling
// the hole with one smooth patch, tangent (G1) to every face around it.

import { cast, getOC, makeSphere, type Edge, type Face, type Shape3D } from "replicad";
import type { Vec3 } from "../model/frame";
import { cutShapes } from "./booleans";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const wrapped = (s: unknown) => (s as { wrapped: unknown }).wrapped;

const dist = (p: { x: number; y: number; z: number }, v: Vec3) => Math.hypot(p.x - v[0], p.y - v[1], p.z - v[2]);

/** Faces that lie on the sphere of radius `r` around `v`. */
function onBall(f: Face, v: Vec3, r: number): boolean {
  if (f.geomType !== "SPHERE") return false;
  return [0.25, 0.5, 0.75].every((u) => Math.abs(dist(f.pointOnSurface(u, 0.5), v) - r) < 1e-4 * Math.max(1, r));
}

/** Replaces everything within `setback` of `v` with one patch tangent to the faces around it. */
export function blendVertex(shape: Shape3D, v: Vec3, setback: number): Shape3D {
  const oc = getOC() as Any;
  const ball = makeSphere(setback).translate(v) as unknown as Shape3D;
  const cut = cutShapes(shape, [ball], { simplify: false });
  const faces = cut.faces;
  const holes = faces.filter((f) => onBall(f, v, setback));
  if (!holes.length) throw new Error("The corner is not near the vertex");
  const rest = faces.filter((f) => !holes.includes(f));
  const patches: unknown[] = [];
  for (const hole of holes) {
    const filling = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2);
    try {
      for (const e of hole.edges) {
        const support = rest.find((f) => f.edges.some((x) => x.isSame(e)));
        if (support) filling.Add(wrapped(e), wrapped(support), oc.GeomAbs_Shape.GeomAbs_G1, true);
        else filling.Add(wrapped(e), oc.GeomAbs_Shape.GeomAbs_C0, true);
      }
      filling.Build();
      if (!filling.IsDone()) throw new Error("Could not build the corner patch");
      patches.push(filling.Shape());
    } finally {
      filling.delete();
    }
  }
  const sewing = new oc.BRepBuilderAPI_Sewing(1e-4);
  try {
    for (const f of rest) sewing.Add(wrapped(f));
    for (const p of patches) sewing.Add(p);
    sewing.Perform();
    const sewed = sewing.SewedShape();
    const shell = oc.TopoDS.Shell(sewed);
    const fix = new oc.ShapeFix_Solid();
    const solid = fix.SolidFromShell(shell);
    fix.delete();
    return cast(solid) as unknown as Shape3D;
  } finally {
    sewing.delete();
  }
}

function isValid(s: Shape3D): boolean {
  const oc = getOC() as Any;
  const a = new oc.BRepCheck_Analyzer(wrapped(s), true);
  const ok = a.IsValid_2 ? a.IsValid_2() : a.IsValid();
  a.delete();
  return ok;
}

export interface Corner {
  v: Vec3;
  radii: number[];
  /** Largest setback the edges meeting there leave room for. */
  room: number;
}

const keyOf = (v: Vec3) => v.map((c) => c.toFixed(4)).join(",");

/** Vertices where three or more of the filleted edges meet with different radii. */
export function mixedRadiusCorners(items: { edge: Edge; size: number }[]): Corner[] {
  const at = new Map<string, { v: Vec3; radii: number[]; edges: { length: number; other: string | null }[] }>();
  for (const { edge, size } of items) {
    const ends = [edge.startPoint, edge.endPoint].map((p) => [p.x, p.y, p.z] as Vec3);
    const keys = ends.map(keyOf);
    const closed = keys[0] === keys[1];
    for (const [k, v] of ends.entries()) {
      if (closed && k === 1) continue;
      const c = at.get(keys[k]) ?? { v, radii: [], edges: [] };
      c.radii.push(size);
      c.edges.push({ length: edge.length, other: closed ? null : keys[1 - k] });
      at.set(keys[k], c);
    }
  }
  const mixed = (c: { radii: number[] }) => c.radii.length >= 3 && Math.max(...c.radii) > Math.min(...c.radii) * 1.001;
  return [...at.values()].filter(mixed).map((c) => ({
    v: c.v,
    radii: c.radii,
    // Along an edge whose other end is blended too, each ball takes less than half of it.
    room: Math.min(...c.edges.map((e) => (e.other && mixed(at.get(e.other)!) ? 0.45 : 0.85) * e.length)),
  }));
}

/**
 * Whether OCCT's corner needs replacing, and how far from the vertex the new
 * patch starts. OCCT closes a corner cleanly with a sphere (equal radii) or a
 * torus (two equal radii); otherwise it fits a free-form patch, which comes out
 * hook-shaped. The setback goes past OCCT's own corner faces (`faces`).
 */
function cornerPlan(c: Corner, faces: { face: Face; far: number }[]): { setback: number; replace: boolean } {
  const rmax = Math.max(...c.radii);
  const reach = Math.max(0, ...faces.map((f) => f.far));
  const replace = faces.some((f) => !["SPHERE", "TORUS", "CYLINDRE", "CONE", "PLANE"].includes(f.face.geomType));
  const setback = Math.min(Math.max(1.1 * rmax, 1.2 * reach), c.room);
  return { setback, replace: replace && setback > 1.05 * reach };
}

/** OCCT's corner faces grouped by the corner they are closest to. */
function cornerFaces(shape: Shape3D, corners: Corner[], isCornerFace: (f: Face) => boolean) {
  const groups = corners.map(() => [] as { face: Face; far: number }[]);
  for (const face of shape.faces) {
    if (!isCornerFace(face)) continue;
    const pts = face.edges.flatMap((e) => [e.startPoint, e.endPoint]);
    let best = -1, bestNear = Infinity, far = 0;
    corners.forEach((c, k) => {
      const d = pts.map((p) => dist(p, c.v));
      const near = Math.min(...d);
      if (near < bestNear) [best, bestNear, far] = [k, near, Math.max(...d)];
    });
    if (best >= 0 && bestNear < 2 * Math.max(...corners[best].radii)) groups[best].push({ face, far });
  }
  return groups;
}

/**
 * Replaces the free-form corner patches at mixed-radius corners with setback
 * vertex blends. A corner whose blend fails keeps OCCT's patch; returns how many were blended.
 */
export function blendCorners(shape: Shape3D, corners: Corner[], isCornerFace: (f: Face) => boolean): { shape: Shape3D; blended: number } {
  // Planned on OCCT's result, before any corner is replaced.
  const groups = cornerFaces(shape, corners, isCornerFace);
  const plans = corners.map((c, k) => cornerPlan(c, groups[k]));
  let out = shape, blended = 0;
  for (const [k, c] of corners.entries()) {
    if (!plans[k].replace) continue;
    try {
      const next = blendVertex(out, c.v, plans[k].setback);
      if (next.faces.length && isValid(next)) {
        out = next;
        blended++;
      }
    } catch {
      // keep OCCT's corner
    }
  }
  return { shape: out, blended };
}
