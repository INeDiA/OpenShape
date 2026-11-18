// Wall thickness analysis for 3D printing: parts of the surface where the
// material behind it is thinner than the printer can lay down (about two
// nozzle widths). From points on each triangle, a ray goes straight into the
// material; where it comes out is the wall's other side. Large triangles are
// split into small pieces first, so a wall that thins out is marked only
// where it is thin.

import type { MeshData } from "../model/types";

export interface ThinWalls {
  /** Pieces thinner than the limit, as plain positions (x, y, z × 3 per triangle). */
  positions: Float32Array;
  /** Their total area, mm². */
  area: number;
  /** Thinnest wall found, mm (Infinity when none is under the limit). */
  min: number;
}

type V = [number, number, number];

/** Bounding volume hierarchy over the triangles, for fast ray casts. */
interface Node {
  lo: V;
  hi: V;
  /** Leaf: triangle indices (into the triangle list, ×3 for vertices). */
  tris?: number[];
  a?: Node;
  b?: Node;
}

function build(tris: number[], centre: Float64Array, lo: Float64Array, hi: Float64Array): Node {
  const box: Node = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
  for (const t of tris)
    for (let k = 0; k < 3; k++) {
      box.lo[k] = Math.min(box.lo[k], lo[t * 3 + k]);
      box.hi[k] = Math.max(box.hi[k], hi[t * 3 + k]);
    }
  if (tris.length <= 8) return { ...box, tris };
  // Split at the middle of the longest side of the centres' spread.
  const clo: V = [Infinity, Infinity, Infinity], chi: V = [-Infinity, -Infinity, -Infinity];
  for (const t of tris)
    for (let k = 0; k < 3; k++) {
      clo[k] = Math.min(clo[k], centre[t * 3 + k]);
      chi[k] = Math.max(chi[k], centre[t * 3 + k]);
    }
  const axis = [0, 1, 2].reduce((m, k) => (chi[k] - clo[k] > chi[m] - clo[m] ? k : m), 0);
  const mid = (clo[axis] + chi[axis]) / 2;
  let left = tris.filter((t) => centre[t * 3 + axis] < mid);
  let right = tris.filter((t) => centre[t * 3 + axis] >= mid);
  if (!left.length || !right.length) {
    // All centres on one spot: split by count.
    const sorted = [...tris].sort((p, q) => centre[p * 3 + axis] - centre[q * 3 + axis]);
    left = sorted.slice(0, sorted.length >> 1);
    right = sorted.slice(sorted.length >> 1);
  }
  return { ...box, a: build(left, centre, lo, hi), b: build(right, centre, lo, hi) };
}

/** Distance along the ray (o, d) to the slab box, or Infinity when missed (or beyond `far`). */
function boxHit(n: Node, o: V, inv: V, far: number): number {
  let t0 = 0, t1 = far;
  for (let k = 0; k < 3; k++) {
    let a = (n.lo[k] - o[k]) * inv[k], b = (n.hi[k] - o[k]) * inv[k];
    if (a > b) [a, b] = [b, a];
    t0 = Math.max(t0, a);
    t1 = Math.min(t1, b);
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/**
 * Parts of the surface where the wall behind is thinner than `limit` (mm).
 * Each body is measured against its own triangles only.
 */
export function findThinWalls(m: MeshData, limit: number): ThinWalls {
  const nTri = m.triangles.length / 3;
  const P = (i: number): V => [m.vertices[i * 3], m.vertices[i * 3 + 1], m.vertices[i * 3 + 2]];
  // Body of each triangle.
  const triBody: string[] = new Array(nTri).fill("");
  m.faceGroups.forEach((g, i) => {
    for (let k = g.start; k < g.start + g.count; k += 3) triBody[k / 3] = m.faceBody[i] ?? "";
  });
  const centre = new Float64Array(nTri * 3), lo = new Float64Array(nTri * 3), hi = new Float64Array(nTri * 3);
  for (let t = 0; t < nTri; t++) {
    const a = P(m.triangles[t * 3]), b = P(m.triangles[t * 3 + 1]), c = P(m.triangles[t * 3 + 2]);
    for (let k = 0; k < 3; k++) {
      centre[t * 3 + k] = (a[k] + b[k] + c[k]) / 3;
      lo[t * 3 + k] = Math.min(a[k], b[k], c[k]);
      hi[t * 3 + k] = Math.max(a[k], b[k], c[k]);
    }
  }
  const byBody = new Map<string, number[]>();
  for (let t = 0; t < nTri; t++) {
    const list = byBody.get(triBody[t]) ?? [];
    list.push(t);
    byBody.set(triBody[t], list);
  }
  const trees = new Map([...byBody].map(([body, tris]) => [body, build(tris, centre, lo, hi)]));

  /** Nearest hit of the ray (o, d) within `far`, skipping triangle `skip`. */
  const cast = (root: Node, o: V, d: V, far: number, skip: number): number => {
    const inv: V = [1 / d[0], 1 / d[1], 1 / d[2]];
    let best = far;
    const stack: Node[] = [root];
    while (stack.length) {
      const n = stack.pop()!;
      if (boxHit(n, o, inv, best) === Infinity) continue;
      if (n.tris) {
        for (const t of n.tris) {
          if (t === skip) continue;
          const hit = rayTriangle(o, d, P(m.triangles[t * 3]), P(m.triangles[t * 3 + 1]), P(m.triangles[t * 3 + 2]));
          if (hit > 1e-5 && hit < best) best = hit;
        }
      } else stack.push(n.a!, n.b!);
    }
    return best;
  };

  const out: number[] = [];
  let area = 0, min = Infinity;
  const piece = limit / 2; // pieces about this size: the marking follows the wall closely enough
  for (let t = 0; t < nTri; t++) {
    const ia = m.triangles[t * 3], ib = m.triangles[t * 3 + 1], ic = m.triangles[t * 3 + 2];
    const a = P(ia), b = P(ib), c = P(ic);
    const u = sub(b, a), w = sub(c, a);
    let n = cross(u, w);
    const len = Math.hypot(...n);
    if (len < 1e-12) continue;
    n = n.map((x) => x / len) as V;
    // Orient like the mesh's own normals (outward), whatever the winding.
    const vn = [0, 1, 2].map((k) => m.normals[ia * 3 + k] + m.normals[ib * 3 + k] + m.normals[ic * 3 + k]);
    if (n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2] < 0) n = n.map((x) => -x) as V;
    const into: V = [-n[0], -n[1], -n[2]];
    const root = trees.get(triBody[t])!;
    // Split into k × k pieces and test each at its centre.
    const edge = Math.max(Math.hypot(...u), Math.hypot(...w), Math.hypot(...sub(c, b)));
    const k = Math.min(24, Math.max(1, Math.ceil(edge / piece)));
    const at = (i: number, j: number): V => [0, 1, 2].map((q) => a[q] + (u[q] * i + w[q] * j) / k) as V;
    const test = (p: V, q: V, r: V) => {
      const o: V = [0, 1, 2].map((s) => (p[s] + q[s] + r[s]) / 3) as V;
      const d = cast(root, o, into, limit, t);
      if (d >= limit) return;
      min = Math.min(min, d);
      out.push(...p, ...q, ...r);
      area += Math.hypot(...cross(sub(q, p), sub(r, p))) / 2;
    };
    for (let i = 0; i < k; i++)
      for (let j = 0; j < k - i; j++) {
        test(at(i, j), at(i + 1, j), at(i, j + 1));
        if (j < k - i - 1) test(at(i + 1, j), at(i + 1, j + 1), at(i, j + 1));
      }
  }
  return { positions: new Float32Array(out), area, min };
}

const sub = (a: V, b: V): V => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** Möller–Trumbore: distance along the ray to the triangle, or Infinity. */
function rayTriangle(o: V, d: V, a: V, b: V, c: V): number {
  const e1 = sub(b, a), e2 = sub(c, a);
  const p = cross(d, e2);
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-12) return Infinity;
  const inv = 1 / det;
  const s = sub(o, a);
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return Infinity;
  const q = cross(s, e1);
  const v = (d[0] * q[0] + d[1] * q[1] + d[2] * q[2]) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return Infinity;
  return (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
}
