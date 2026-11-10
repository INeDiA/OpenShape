// Persistent topological naming.
//
// OCCT ids (hash codes) change on every rebuild, so features can't reference
// faces or edges by id. Instead every face gets a *name* derived from the
// feature and sketch curve that generated it:
//
//   <extrudeId>:start          cap on the sketch plane
//   <extrudeId>:end            opposite cap
//   <extrudeId>:side:<curveId> lateral face swept from a sketch curve
//   <revolveId>:rev:<k>        revolve faces, in kernel order (coarse)
//   <filletId>:blend:<edge>    new face created by a fillet/chamfer on <edge>
//
// After a boolean or edge treatment, each resulting face inherits the name of
// the source face it lies on (checked geometrically: point on face + normal).
// A face split into several pieces gets "#1", "#2", ... ordered by position.
//
// Edges are named by their two adjacent faces: "[faceA|faceB]" with the names
// sorted, plus "#k" when several edges share the same pair.
//
// The names only depend on the recipe (feature ids, sketch curve ids), so they
// survive upstream parameter changes as long as the topology stays the same.

import { makeVertex, measureDistanceBetween, type Edge, type Face, type Shape3D } from "replicad";
import type { SketchFeature } from "../model/types";
import { entityMap, pointOf, type SkCurve } from "../sketch/model";
import { frameToLocal, type Frame } from "../model/frame";
import { distToSegment } from "../sketch/geometry";

export type FaceNames = Map<number, string>; // face hashCode -> name

export interface NamedShape {
  shape: Shape3D;
  names: FaceNames;
}

type Vec3 = [number, number, number];
interface Sample {
  p: Vec3;
  n: Vec3;
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
/** replicad's normalAt is not normalized (its length is the radius on cylinders). */
const normalAt = (face: Face, p: Vec3): Vec3 => unit(face.normalAt(p).toTuple() as Vec3);

/**
 * One point strictly inside each face (centroid of the face's largest triangle)
 * plus the face normal there. Face centers can't be used: for a face with a
 * hole the center of mass lies in the hole.
 */
export function faceSamples(shape: Shape3D): Map<number, Sample> {
  const m = shape.mesh({ tolerance: 0.2, angularTolerance: 20 });
  const faces = new Map(shape.faces.map((f) => [f.hashCode, f]));
  const out = new Map<number, Sample>();
  for (const g of m.faceGroups) {
    let best = -1, bestArea = -1;
    for (let t = g.start; t < g.start + g.count; t += 3) {
      const [a, b, c] = [m.triangles[t], m.triangles[t + 1], m.triangles[t + 2]].map((i) => [m.vertices[i * 3], m.vertices[i * 3 + 1], m.vertices[i * 3 + 2]] as Vec3);
      const u = sub(b, a), v = sub(c, a);
      const cr: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const area = Math.hypot(...cr);
      if (area > bestArea) {
        bestArea = area;
        best = t;
      }
    }
    if (best < 0) continue;
    const idx = [m.triangles[best], m.triangles[best + 1], m.triangles[best + 2]];
    let p: Vec3 = [0, 1, 2].map((k) => idx.reduce((s, i) => s + m.vertices[i * 3 + k], 0) / 3) as Vec3;
    let n: Vec3 = [0, 1, 2].map((k) => idx.reduce((s, i) => s + m.normals[i * 3 + k], 0)) as Vec3;
    // The triangle centroid sits on the chord, off curved surfaces: project it onto the exact surface.
    const face = faces.get(g.faceId);
    if (face) {
      try {
        // uvCoordinates returns absolute parameters, pointOnSurface expects them normalized to [0, 1].
        const [u, v] = face.uvCoordinates(p);
        const b = face.UVBounds;
        const nu = b.uMax > b.uMin ? (u - b.uMin) / (b.uMax - b.uMin) : 0.5;
        const nv = b.vMax > b.vMin ? (v - b.vMin) / (b.vMax - b.vMin) : 0.5;
        p = face.pointOnSurface(nu, nv).toTuple() as Vec3;
        const exact = normalAt(face, p);
        // Keep the mesh's (outward) orientation; the surface normal may be reversed.
        n = dot(exact, n) < 0 ? [-exact[0], -exact[1], -exact[2]] : exact;
      } catch {
        /* keep the mesh approximation */
      }
    }
    out.set(g.faceId, { p, n: unit(n) });
  }
  return out;
}

// ---- naming new solids -------------------------------------------------------

/** Distance from a sketch-local point to a curve (lines, circles, arcs). */
function curveDistance(m: ReturnType<typeof entityMap>, c: SkCurve, u: number, v: number): number {
  if (c.kind === "line") {
    const a = pointOf(m, c.p1), b = pointOf(m, c.p2);
    return distToSegment(u, v, a.x, a.y, b.x, b.y);
  }
  const ctr = pointOf(m, c.center);
  const radial = Math.abs(Math.hypot(u - ctr.x, v - ctr.y) - c.radius);
  if (c.kind === "circle") return radial;
  // Arc: radial distance inside the angular range, else distance to the nearest end.
  const s0 = pointOf(m, c.start), s1 = pointOf(m, c.end);
  const ang = (x: number, y: number) => (Math.atan2(y - ctr.y, x - ctr.x) + 2 * Math.PI) % (2 * Math.PI);
  const a0 = ang(s0.x, s0.y), a1 = ang(s1.x, s1.y), a = ang(u, v);
  const span = (a1 - a0 + 2 * Math.PI) % (2 * Math.PI);
  if ((a - a0 + 2 * Math.PI) % (2 * Math.PI) <= span) return radial;
  return Math.min(Math.hypot(u - s0.x, v - s0.y), Math.hypot(u - s1.x, v - s1.y));
}

/** Names the faces of a freshly extruded tool solid from its sketch. */
export function nameExtrusion(tool: Shape3D, featureId: string, sketch: SketchFeature, frame: Frame, distance: number): FaceNames {
  const samples = faceSamples(tool);
  const m = entityMap(sketch.sketch);
  const curves = sketch.sketch.entities.filter((e): e is SkCurve => e.kind !== "point" && !e.construction);
  const names: FaceNames = new Map();

  for (const [hash, s] of samples) {
    if (Math.abs(dot(s.n, frame.n)) > 0.999) {
      const depth = dot(sub(s.p, frame.origin), frame.n);
      names.set(hash, Math.abs(depth) < Math.abs(distance) / 2 ? `${featureId}:start` : `${featureId}:end`);
      continue;
    }
    const [u, v] = frameToLocal(frame, s.p);
    let best = "?", bestD = Infinity;
    for (const c of curves) {
      const d = curveDistance(m, c, u, v);
      if (d < bestD) {
        bestD = d;
        best = c.id;
      }
    }
    names.set(hash, `${featureId}:side:${best}`);
  }
  return disambiguate(names, samples);
}

/**
 * Names a face pushed/pulled along its normal: caps by depth, sides by the
 * edge of the source face they were swept from.
 */
export function nameFaceExtrusion(tool: Shape3D, featureId: string, normal: Vec3, origin: Vec3, distance: number, sourceEdges: EdgeNaming, sourceFaceEdges: Set<string>): FaceNames {
  const samples = faceSamples(tool);
  const names: FaceNames = new Map();
  for (const [hash, s] of samples) {
    if (Math.abs(dot(s.n, normal)) > 0.999) {
      const depth = dot(sub(s.p, origin), normal);
      names.set(hash, Math.abs(depth) < Math.abs(distance) / 2 ? `${featureId}:start` : `${featureId}:end`);
      continue;
    }
    // Project the sample back onto the source face plane and find the edge it came from.
    const back = sub(s.p, [normal[0] * dot(sub(s.p, origin), normal), normal[1] * dot(sub(s.p, origin), normal), normal[2] * dot(sub(s.p, origin), normal)]);
    names.set(hash, `${featureId}:side:${nearestEdgeName(back, sourceEdges, sourceFaceEdges)}`);
  }
  return disambiguate(names, samples);
}

/**
 * Names for a transformed copy (mirror, pattern instance): a rigid transform
 * keeps face order, so copy k inherits "<prefix>:<original name>" by index.
 */
export function copyNames(original: NamedShape, copy: Shape3D, prefix: string): FaceNames {
  const src = original.shape.faces;
  const names: FaceNames = new Map();
  copy.faces.forEach((f, k) => names.set(f.hashCode, `${prefix}:${original.names.get(src[k]?.hashCode) ?? k}`));
  return names;
}

/** Imported solids have no recipe: name faces by kernel order. */
export function nameByOrder(shape: Shape3D, prefix: string): FaceNames {
  const names: FaceNames = new Map();
  shape.faces.forEach((f, k) => names.set(f.hashCode, `${prefix}:${k}`));
  return names;
}

/** Revolved solids: kernel face order is stable for a given sketch topology. */
export function nameRevolution(tool: Shape3D, featureId: string): FaceNames {
  const names: FaceNames = new Map();
  tool.faces.forEach((f, k) => names.set(f.hashCode, `${featureId}:rev:${k}`));
  return names;
}

// ---- transferring names through operations -----------------------------------

interface SourceFace {
  face: Face;
  name: string;
  lo: Vec3;
  hi: Vec3;
}

function sourceFaces(sources: NamedShape[]): SourceFace[] {
  const out: SourceFace[] = [];
  for (const s of sources) {
    for (const face of s.shape.faces) {
      const name = s.names.get(face.hashCode);
      if (!name) continue;
      const [lo, hi] = face.boundingBox.bounds as [Vec3, Vec3];
      out.push({ face, name, lo, hi });
    }
  }
  return out;
}

/**
 * Gives every face of `result` the name of the source face it lies on.
 * Faces with no source (created by the operation) are passed to `nameNew`.
 */
export function transferNames(result: Shape3D, sources: NamedShape[], nameNew: (face: Face, s: Sample) => string): FaceNames {
  const samples = faceSamples(result);
  const candidates = sourceFaces(sources);
  const names: FaceNames = new Map();
  const tol = 1e-3;

  for (const face of result.faces) {
    const s = samples.get(face.hashCode);
    if (!s) continue;
    let name: string | null = null;
    for (const c of candidates) {
      if (c.face.geomType !== face.geomType) continue;
      if (s.p.some((v, k) => v < c.lo[k] - tol || v > c.hi[k] + tol)) continue;
      const vtx = makeVertex(s.p);
      const d = measureDistanceBetween(vtx, c.face);
      vtx.delete();
      if (d > tol) continue;
      const n = normalAt(c.face, s.p);
      if (Math.abs(dot(n, s.n)) < 0.98) continue;
      name = c.name;
      break;
    }
    names.set(face.hashCode, name ?? nameNew(face, s));
  }
  return disambiguate(names, samples);
}

/** Appends #1, #2... to faces that ended up with the same name, ordered by position. */
function disambiguate(names: FaceNames, samples: Map<number, Sample>): FaceNames {
  const groups = new Map<string, number[]>();
  for (const [hash, n] of names) groups.set(n, [...(groups.get(n) ?? []), hash]);
  for (const [n, hashes] of groups) {
    if (hashes.length < 2) continue;
    hashes.sort((a, b) => comparePoints(samples.get(a)?.p, samples.get(b)?.p));
    hashes.forEach((h, i) => names.set(h, `${n}#${i + 1}`));
  }
  return names;
}

function comparePoints(a?: Vec3, b?: Vec3): number {
  if (!a || !b) return 0;
  for (let k = 0; k < 3; k++) {
    const d = Math.round(a[k] * 1000) - Math.round(b[k] * 1000);
    if (d !== 0) return d;
  }
  return 0;
}

// ---- edges ---------------------------------------------------------------------

export interface EdgeNaming {
  byHash: Map<number, string>;
  byName: Map<string, Edge>;
}

/** Names every edge "[a|b]" from the names of its two adjacent faces. */
export function nameEdges(shape: Shape3D, faces: FaceNames): EdgeNaming {
  const adjacent = new Map<number, string[]>();
  for (const f of shape.faces) {
    const fname = faces.get(f.hashCode) ?? "?";
    for (const e of f.edges) adjacent.set(e.hashCode, [...(adjacent.get(e.hashCode) ?? []), fname]);
  }
  const edges = shape.edges;
  const raw = new Map<number, string>();
  for (const e of edges) {
    const pair = (adjacent.get(e.hashCode) ?? ["?"]).slice().sort();
    raw.set(e.hashCode, `[${pair.join("|")}]`);
  }
  // Disambiguate edges sharing the same face pair by midpoint position.
  const groups = new Map<string, Edge[]>();
  for (const e of edges) groups.set(raw.get(e.hashCode)!, [...(groups.get(raw.get(e.hashCode)!) ?? []), e]);
  const byHash = new Map<number, string>();
  const byName = new Map<string, Edge>();
  for (const [n, es] of groups) {
    if (es.length === 1) {
      byHash.set(es[0].hashCode, n);
      byName.set(n, es[0]);
      continue;
    }
    const mids = new Map(es.map((e) => [e.hashCode, e.pointAt(0.5).toTuple() as Vec3]));
    es.sort((a, b) => comparePoints(mids.get(a.hashCode), mids.get(b.hashCode)));
    es.forEach((e, i) => {
      const name = `${n}#${i + 1}`;
      byHash.set(e.hashCode, name);
      byName.set(name, e);
    });
  }
  return { byHash, byName };
}

/** Name of the edge (from `naming`) closest to a point; used to name blend faces. */
export function nearestEdgeName(p: Vec3, naming: EdgeNaming, among?: Set<string>): string {
  let best = "?", bestD = Infinity;
  const vtx = makeVertex(p);
  for (const [name, e] of naming.byName) {
    if (among && !among.has(name)) continue;
    const d = measureDistanceBetween(vtx, e);
    if (d < bestD) {
      bestD = d;
      best = name;
    }
  }
  vtx.delete();
  return best;
}
