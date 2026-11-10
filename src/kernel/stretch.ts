// Push/pull as a face *move*: the face travels along its normal, the walls
// around it stretch, and whatever sits on top of it (fillets, chamfers,
// holes) travels with it.
//
// Method: find the "cap" region around the face (the face plus every
// non-wall face connected to it, e.g. its fillets) and how deep it reaches.
// Just below that depth the body must be made only of walls (faces parallel to
// the direction). Split the body there, translate the top part, fill the gap by
// extruding the cross-section, and fuse. When those conditions don't hold the
// caller falls back to a plain extrude-and-fuse.

import { basicFaceExtrusion, drawRectangle, makeVertex, measureDistanceBetween, measureVolume, Plane, Vector, type Face, type Shape3D } from "replicad";
import { planeFrame, type Vec3 } from "../model/frame";
import { faceBounds, faceSamples, transferNames, type FaceBounds, type FaceNames, type NamedShape } from "./naming";

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** A face is a wall when it's parallel to `n` everywhere (vertical planes, vertical cylinders...). */
function isWall(face: Face, n: Vec3): boolean {
  const b = face.UVBounds;
  // A plane has one normal; a cylinder needs two samples around it; anything else gets four.
  const type = face.geomType;
  const probes = type === "PLANE" ? [[0.5, 0.5]] : type === "CYLINDRE" ? [[0.2, 0.5], [0.8, 0.5]] : [[0.15, 0.15], [0.85, 0.5], [0.5, 0.85], [0.5, 0.5]];
  for (const [fu, fv] of probes) {
    const p = face.pointOnSurface(fu, fv).toTuple() as Vec3;
    const nn = unit(face.normalAt(p).toTuple() as Vec3);
    if (Math.abs(dot(nn, n)) > 1e-4) return false;
  }
  return b.uMax > b.uMin && b.vMax > b.vMin;
}

/** Min/max of a face along `n`, from its (mesh-derived, padded) bounds: conservative. */
let boundsOf: (face: Face) => FaceBounds = (f) => {
  const [lo, hi] = f.boundingBox.bounds as [Vec3, Vec3];
  return { lo, hi };
};
function extent(face: Face, n: Vec3): [number, number] {
  const { lo, hi } = boundsOf(face);
  let min = Infinity, max = -Infinity;
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
    const d = dot([x, y, z], n);
    min = Math.min(min, d);
    max = Math.max(max, d);
  }
  return [min, max];
}

/**
 * Big box occupying the half-space above (`up`) or below the plane at `level`
 * along `n`, centred on `center` so it covers the body wherever it is.
 */
function halfSpace(n: Vec3, level: number, size: number, up: boolean, center: Vec3): Shape3D {
  const fr = planeFrame([n[0] * level, n[1] * level, n[2] * level], n);
  const off = dot(center, n) - level;
  const origin: Vec3 = [center[0] - n[0] * off, center[1] - n[1] * off, center[2] - n[2] * off];
  const plane = new Plane(origin, fr.x, fr.n);
  return drawRectangle(size, size).sketchOnPlane(plane).extrude(up ? size : -size) as Shape3D;
}

export interface StretchResult {
  shape: Shape3D;
  names: FaceNames;
}

/**
 * Moves `faceName` of `body` by `distance` along `n`, or returns null when the
 * geometry isn't a clean stretch (the caller then extrudes instead).
 */
export function stretchFace(body: NamedShape, face: Face, n: Vec3, distance: number, featureId: string): StretchResult | null {
  const faces = body.shape.faces;
  const bodyBounds = faceBounds(body.shape);
  boundsOf = (f) => {
    const b = bodyBounds.get(f.hashCode);
    if (b) return b;
    const [lo, hi] = f.boundingBox.bounds as [Vec3, Vec3];
    return { lo, hi };
  };
  // The pushed face is planar: its exact level comes from a point on it, not from padded bounds.
  const level = dot(faceSamples(body.shape).get(face.hashCode)!.p, n);

  // Cap region: the face plus connected non-wall faces (its blends).
  const adjacency = new Map<number, Set<number>>();
  const edgeFaces = new Map<number, number[]>();
  for (const f of faces) for (const e of f.edges) edgeFaces.set(e.hashCode, [...(edgeFaces.get(e.hashCode) ?? []), f.hashCode]);
  for (const list of edgeFaces.values()) for (const a of list) for (const b of list) if (a !== b) (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b);
  const byHash = new Map(faces.map((f) => [f.hashCode, f]));
  const wall = new Map<number, boolean>();
  const isWallCached = (h: number) => {
    if (!wall.has(h)) wall.set(h, isWall(byHash.get(h)!, n));
    return wall.get(h)!;
  };
  const cap = new Set([face.hashCode]);
  const queue = [face.hashCode];
  while (queue.length) {
    const h = queue.pop()!;
    for (const nb of adjacency.get(h) ?? []) {
      if (cap.has(nb) || isWallCached(nb)) continue;
      // Only faces that stay near the top belong to the cap (not a far-away floor).
      const [, max] = extent(byHash.get(nb)!, n);
      if (max < level - 1e-6 && Math.abs(dot(unit(byHash.get(nb)!.normalAt().toTuple() as Vec3), n)) > 0.999) continue;
      cap.add(nb);
      queue.push(nb);
    }
  }
  const depth = Math.max(...[...cap].map((h) => level - extent(byHash.get(h)!, n)[0]));
  const cut = level - depth - Math.min(0.5, Math.max(0.01, depth * 0.25));
  const [bodyMin] = (() => {
    let min = Infinity;
    for (const f of faces) min = Math.min(min, extent(f, n)[0]);
    return [min];
  })();
  const lowest = cut + Math.min(0, distance);
  if (lowest <= bodyMin + 1e-3) return null;

  // Everything crossing the slab that moves or gets cut must be a wall.
  for (const f of faces) {
    if (cap.has(f.hashCode)) continue;
    const [min, max] = extent(f, n);
    if (max > lowest + 1e-6 && min < cut - 1e-6 && !isWallCached(f.hashCode)) return null;
    // A non-wall face fully inside the moving part that isn't in the cap (e.g. a separate bump) is fine: it moves.
  }

  const [lo, hi] = body.shape.boundingBox.bounds as [Vec3, Vec3];
  const size = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 4 + Math.abs(distance) * 4 + 10;
  const center: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];

  const upper = body.shape.clone().intersect(halfSpace(n, cut, size, true, center));
  const lower = body.shape.clone().intersect(halfSpace(n, lowest, size, false, center));
  const move = new Vector([n[0] * distance, n[1] * distance, n[2] * distance]);
  const moved = upper.clone().translate([move.x, move.y, move.z]);

  // Names: the moved part keeps its names (the pushed face becomes "<id>:end").
  const upperNames = transferNames(upper, [body], () => `${featureId}:cap`);
  const movedNames: FaceNames = new Map();
  const upperFaces = upper.faces;
  moved.faces.forEach((f, k) => {
    const name = upperNames.get(upperFaces[k]?.hashCode);
    movedNames.set(f.hashCode, name === undefined ? `${featureId}:cap` : name === bodyName(body, face) ? `${featureId}:end` : name);
  });
  const lowerNamed: NamedShape = { shape: lower, names: transferNames(lower, [body], () => `${featureId}:cap`) };

  let result: Shape3D = lower.fuse(moved);
  const sources: NamedShape[] = [lowerNamed, { shape: moved, names: movedNames }];

  if (distance > 0) {
    // Fill the gap by extruding the cross-section at the cut level.
    const lowerSamples = faceSamples(lower);
    const section = lower.faces.filter((f) => f.geomType === "PLANE" && Math.abs(dot(unit(f.normalAt().toTuple() as Vec3), n)) > 0.999 && Math.abs(dot(lowerSamples.get(f.hashCode)?.p ?? [0, 0, 0], n) - cut) < 1e-4);
    for (const sf of section) {
      const filler = basicFaceExtrusion(sf, move) as Shape3D;
      sources.push({ shape: filler, names: nameFiller(filler, body, n, cut, featureId) });
      result = result.fuse(filler);
    }
  }
  // Sanity check: the volume must change by the swept cross-section, in the right direction.
  const before = measureVolume(body.shape), after = measureVolume(result);
  if (!(after > 0) || (distance > 0 ? after <= before : after >= before)) return null;
  return { shape: result, names: transferNames(result, sources, () => `${featureId}:side`) };
}

function bodyName(body: NamedShape, face: Face) {
  return body.names.get(face.hashCode);
}

/** Filler walls take the name of the original wall right below them. */
function nameFiller(filler: Shape3D, body: NamedShape, n: Vec3, cut: number, featureId: string): FaceNames {
  const names: FaceNames = new Map();
  for (const [hash, s] of faceSamples(filler)) {
    const below = dot(s.p, n) - cut + 1e-3;
    const p: Vec3 = [s.p[0] - n[0] * below, s.p[1] - n[1] * below, s.p[2] - n[2] * below];
    let name = `${featureId}:side`;
    for (const f of body.shape.faces) {
      const v = makeVertex(p);
      const d = measureDistanceBetween(v, f);
      v.delete();
      if (d < 1e-3) {
        name = body.names.get(f.hashCode) ?? name;
        break;
      }
    }
    names.set(hash, name);
  }
  return names;
}
