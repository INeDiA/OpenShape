// Geometry read from the display mesh, used to place on-model handles.

import type { MeshData } from "../model/types";
import type { Vec3 } from "../model/frame";

/** A point inside the face (centroid of its largest triangle) and its normal. */
export function faceAnchor(m: MeshData, faceName: string): { p: Vec3; n: Vec3 } | null {
  const i = m.faceNames.indexOf(faceName);
  if (i < 0) return null;
  const g = m.faceGroups[i];
  let best = -1, bestArea = -1;
  for (let t = g.start; t < g.start + g.count; t += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => vtx(m, m.triangles[t + k]));
    const u = sub(b, a), v = sub(c, a);
    const area = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
    if (area > bestArea) {
      bestArea = area;
      best = t;
    }
  }
  if (best < 0) return null;
  const idx = [0, 1, 2].map((k) => m.triangles[best + k]);
  const p = avg(idx.map((j) => vtx(m, j)));
  const n = unit(idx.reduce<Vec3>((s, j) => [s[0] + m.normals[j * 3], s[1] + m.normals[j * 3 + 1], s[2] + m.normals[j * 3 + 2]], [0, 0, 0]));
  return { p, n };
}

/**
 * Directions for a fillet handle on the edge between faces A and B: the edge
 * tangent, and `along` = the direction on face A perpendicular to the edge,
 * pointing away from it (where the fillet's tangent line moves as it grows).
 */
export function edgeFrame(m: MeshData, edgeName: string): { tangent: Vec3; along: Vec3; outward: Vec3 } | null {
  const inner = edgeName.replace(/#\d+$/, "").replace(/^\[|\]$/g, "");
  const [a, b] = splitPair(inner);
  const A = a ? faceAnchor(m, a) : null, B = b ? faceAnchor(m, b) : null;
  if (!A || !B) return null;
  // Prefer the planar face to slide on: its direction is the same along the whole edge.
  const planarA = m.facePlanar[m.faceNames.indexOf(a)], planarB = m.facePlanar[m.faceNames.indexOf(b)];
  const [nA, nB] = !planarA && planarB ? [B.n, A.n] : [A.n, B.n];
  const t = cross(nA, nB);
  if (Math.hypot(...t) < 1e-6) return null; // tangent faces: no sharp edge
  const tangent = unit(t);
  let along = unit(cross(tangent, nA));
  if (dot(along, nB) > 0) along = [-along[0], -along[1], -along[2]];
  // Out of the solid, between the two faces (perpendicular to the edge as well).
  const outward = unit([nA[0] + nB[0], nA[1] + nB[1], nA[2] + nB[2]]);
  return { tangent, along, outward };
}

/**
 * Midpoint of an edge and the direction pointing into the material, between
 * its two adjacent faces (the way a fillet grows).
 */
export function edgeAnchor(m: MeshData, edgeName: string): { p: Vec3; inward: Vec3 } | null {
  const i = m.edgeNames.indexOf(edgeName);
  if (i < 0) return null;
  const g = m.edgeGroups[i];
  const pts: Vec3[] = [];
  for (let k = g.start; k < g.start + g.count; k++) pts.push([m.edges[k * 3], m.edges[k * 3 + 1], m.edges[k * 3 + 2]]);
  if (!pts.length) return null;
  const p = halfway(pts);
  // Edge names are "[faceA|faceB]#k": average the outward normals of both faces.
  const inner = edgeName.replace(/#\d+$/, "").replace(/^\[|\]$/g, "");
  const faces = splitPair(inner);
  const normals = faces.map((f) => faceAnchor(m, f)?.n).filter((n): n is Vec3 => !!n);
  if (!normals.length) return { p, inward: [0, 0, -1] };
  const out = unit(normals.reduce<Vec3>((s, n) => [s[0] + n[0], s[1] + n[1], s[2] + n[2]], [0, 0, 0]));
  return { p, inward: [-out[0], -out[1], -out[2]] };
}

/** Bounding box of one body's faces. */
export function bodyBounds(m: MeshData, bodyId: string): { min: Vec3; max: Vec3; center: Vec3; size: number } | null {
  const min: Vec3 = [Infinity, Infinity, Infinity], max: Vec3 = [-Infinity, -Infinity, -Infinity];
  m.faceGroups.forEach((g, i) => {
    if (m.faceBody[i] !== bodyId) return;
    for (let t = g.start; t < g.start + g.count; t++) {
      const v = vtx(m, m.triangles[t]);
      for (let k = 0; k < 3; k++) {
        min[k] = Math.min(min[k], v[k]);
        max[k] = Math.max(max[k], v[k]);
      }
    }
  });
  if (!Number.isFinite(min[0])) return null;
  const center = avg([min, max]);
  return { min, max, center, size: Math.hypot(...sub(max, min)) };
}

/**
 * Splits "a|b" at the top-level bar: face names can themselves contain
 * bracketed edge names, e.g. "fillet:blend:[x:end|x:side:l1]".
 */
export function splitPair(s: string): string[] {
  const out: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "[") depth++;
    else if (s[i] === "]") depth--;
    else if (s[i] === "|" && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out.filter(Boolean);
}

/** Point at half the length of a polyline given as segment pairs. */
function halfway(pts: Vec3[]): Vec3 {
  let total = 0;
  for (let i = 0; i + 1 < pts.length; i += 2) total += Math.hypot(...sub(pts[i + 1], pts[i]));
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i += 2) {
    const len = Math.hypot(...sub(pts[i + 1], pts[i]));
    if (acc + len >= total / 2 && len > 0) {
      const t = (total / 2 - acc) / len;
      return [0, 1, 2].map((k) => pts[i][k] + (pts[i + 1][k] - pts[i][k]) * t) as Vec3;
    }
    acc += len;
  }
  return pts[0];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

const vtx = (m: MeshData, i: number): Vec3 => [m.vertices[i * 3], m.vertices[i * 3 + 1], m.vertices[i * 3 + 2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const avg = (ps: Vec3[]): Vec3 => [0, 1, 2].map((k) => ps.reduce((s, p) => s + p[k], 0) / ps.length) as Vec3;
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/**
 * The body whose closed surface contains `p` (ray parity test on the display
 * mesh), or null when the point is outside every body.
 */
export function bodyContaining(m: MeshData, p: Vec3): string | null {
  // A ray that grazes an edge shared by two triangles counts it twice and flips the
  // answer: cast three oblique rays and let the majority decide, per body.
  const dirs: Vec3[] = [unit([0.5773, 0.6133, 0.5392]), unit([-0.6421, 0.3187, 0.6971]), unit([0.2213, -0.8417, 0.4924])];
  const votes = new Map<string, number>();
  for (const d of dirs) {
    const crossings = new Map<string, number>();
    m.faceGroups.forEach((g, fi) => {
      const body = m.faceBody[fi];
      if (!body) return;
      for (let t = g.start; t < g.start + g.count; t += 3) {
        const a = vtx(m, m.triangles[t]), b = vtx(m, m.triangles[t + 1]), c = vtx(m, m.triangles[t + 2]);
        if (rayHitsTriangle(p, d, a, b, c)) crossings.set(body, (crossings.get(body) ?? 0) + 1);
      }
    });
    for (const [body, n] of crossings) if (n % 2 === 1) votes.set(body, (votes.get(body) ?? 0) + 1);
  }
  for (const [body, v] of votes) if (v >= 2) return body;
  return null;
}

/**
 * Whether the edge through `p` between faces A and B (anchors with outward
 * normals) is convex. Each face of a convex edge lies below the other's plane;
 * when that's ambiguous (curved faces), ask whether there's material just
 * inside the bisector.
 */
function edgeIsConvex(m: MeshData, A: { p: Vec3; n: Vec3 }, B: { p: Vec3; n: Vec3 }, p: Vec3): boolean {
  const scale = Math.max(1e-6, Math.hypot(...sub(A.p, p)), Math.hypot(...sub(B.p, p)));
  const below = dot(sub(B.p, p), A.n) / scale, below2 = dot(sub(A.p, p), B.n) / scale;
  if (below < -1e-4 && below2 < -1e-4) return true;
  if (below > 1e-4 && below2 > 1e-4) return false;
  const bis = unit([A.n[0] + B.n[0], A.n[1] + B.n[1], A.n[2] + B.n[2]]);
  return bodyContaining(m, [p[0] - bis[0] * 0.05, p[1] - bis[1] * 0.05, p[2] - bis[2] * 0.05]) !== null;
}

/** Möller–Trumbore, forward hits only. */
function rayHitsTriangle(o: Vec3, d: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  const e1 = sub(b, a), e2 = sub(c, a);
  const h = cross(d, e2);
  const det = dot(e1, h);
  if (Math.abs(det) < 1e-12) return false;
  const f = 1 / det;
  const s = sub(o, a);
  const u = f * dot(s, h);
  if (u < 0 || u > 1) return false;
  const q = cross(s, e1);
  const v = f * dot(d, q);
  if (v < 0 || u + v > 1) return false;
  return f * dot(e2, q) > 1e-9;
}

export interface FilletPreview {
  /** The rounded surface (triangles) and its outward normals, for shading. */
  arc: Float32Array;
  normals: Float32Array;
  /** Bands on the two adjacent faces, from the edge to where the fillet starts. */
  bands: Float32Array;
}

/**
 * Appends to `out` the fillet of `radius` along straight segments of an edge
 * between faces with outward normals `nA` and `nB`: the arc tangent to both
 * faces (on the inside of a convex edge, the outside of a concave one), its
 * normals, and the bands it takes off each face.
 */
function roundSegments(segs: [Vec3, Vec3][], nA: Vec3, nB: Vec3, convex: boolean, radius: number, steps: number, out: { arc: number[]; normals: number[]; bands: number[] }) {
  const d = dot(nA, nB);
  const s = convex ? -1 : 1;
  // Center at distance r from both planes: c = p + s r (nA + nB) / (1 + nA·nB).
  const k = (s * radius) / (1 + d);
  const uA: Vec3 = [-s * nA[0], -s * nA[1], -s * nA[2]], uB: Vec3 = [-s * nB[0], -s * nB[1], -s * nB[2]];
  const ang = Math.acos(Math.max(-1, Math.min(1, dot(uA, uB))));
  const sin = Math.sin(ang) || 1;
  const section = (p: Vec3): { pts: Vec3[]; nrm: Vec3[] } => {
    const c: Vec3 = [p[0] + k * (nA[0] + nB[0]), p[1] + k * (nA[1] + nB[1]), p[2] + k * (nA[2] + nB[2])];
    const res = { pts: [] as Vec3[], nrm: [] as Vec3[] };
    for (let j = 0; j <= steps; j++) {
      const t = j / steps;
      const wa = Math.sin((1 - t) * ang) / sin, wb = Math.sin(t * ang) / sin;
      const u: Vec3 = [wa * uA[0] + wb * uB[0], wa * uA[1] + wb * uB[1], wa * uA[2] + wb * uB[2]];
      res.pts.push([c[0] + radius * u[0], c[1] + radius * u[1], c[2] + radius * u[2]]);
      // The surface faces out of the solid: away from the center on a convex edge, towards it on a concave one.
      res.nrm.push(convex ? u : [-u[0], -u[1], -u[2]]);
    }
    return res;
  };
  for (const [p0, p1] of segs) {
    const a0 = section(p0), a1 = section(p1);
    for (let j = 0; j < steps; j++) {
      out.arc.push(...a0.pts[j], ...a1.pts[j], ...a1.pts[j + 1], ...a0.pts[j], ...a1.pts[j + 1], ...a0.pts[j + 1]);
      out.normals.push(...a0.nrm[j], ...a1.nrm[j], ...a1.nrm[j + 1], ...a0.nrm[j], ...a1.nrm[j + 1], ...a0.nrm[j + 1]);
    }
    // Face A band: edge -> tangent line on A (first arc point); face B band: edge -> last arc point.
    for (const [t0, t1] of [
      [a0.pts[0], a1.pts[0]],
      [a0.pts[steps], a1.pts[steps]],
    ] as const) {
      out.bands.push(...p0, ...p1, ...t1, ...p0, ...t1, ...t0);
    }
  }
}

const pack = (o: { arc: number[]; normals: number[]; bands: number[] }): FilletPreview => ({
  arc: new Float32Array(o.arc),
  normals: new Float32Array(o.normals),
  bands: new Float32Array(o.bands),
});

/** The two faces an edge (or a blend's source edge) "[faceA|faceB]#k" lies between. */
const edgeFaces = (edgeName: string) => splitPair(edgeName.replace(/#\d+$/, "").replace(/^\[|\]$/g, ""));

/**
 * Approximate fillets of `radius` on the given edges, for a preview. Each edge
 * segment gets the circular arc tangent to its two faces (exact between planar
 * faces; curved faces use the normal at their anchor). Concave edges get the
 * arc on the outside.
 */
export function filletPreview(m: MeshData, edgeNames: string[], radius: number, steps = 8): FilletPreview {
  const out = { arc: [] as number[], normals: [] as number[], bands: [] as number[] };
  if (radius <= 0) return pack(out);
  for (const name of edgeNames) {
    const i = m.edgeNames.indexOf(name);
    if (i < 0) continue;
    const [fa, fb] = edgeFaces(name);
    const A = fa ? faceAnchor(m, fa) : null, B = fb ? faceAnchor(m, fb) : null;
    if (!A || !B || dot(A.n, B.n) > 0.999) continue; // tangent faces: nothing to round
    const g = m.edgeGroups[i];
    const pts: Vec3[] = [];
    for (let k = g.start; k < g.start + g.count; k++) pts.push([m.edges[k * 3], m.edges[k * 3 + 1], m.edges[k * 3 + 2]]);
    if (pts.length < 2) continue;
    const convex = edgeIsConvex(m, A, B, pts[Math.floor(pts.length / 2)]);
    const segs: [Vec3, Vec3][] = [];
    for (let p = 0; p + 1 < pts.length; p += 2) segs.push([pts[p], pts[p + 1]]);
    roundSegments(segs, A.n, B.n, convex, radius, steps, out);
  }
  return pack(out);
}

/**
 * Preview of an existing fillet face with a new `radius`. The sharp edge it
 * replaced is rebuilt as the line where the planes of its two faces meet,
 * as long as the blend face covers it. Null when those faces aren't planar.
 */
export function refilletPreview(m: MeshData, blendFace: string, edgeName: string, radius: number, steps = 8): FilletPreview | null {
  const [fa, fb] = edgeFaces(edgeName);
  const iA = m.faceNames.indexOf(fa), iB = m.faceNames.indexOf(fb), iBlend = m.faceNames.indexOf(blendFace);
  if (iA < 0 || iB < 0 || iBlend < 0 || !m.facePlanar[iA] || !m.facePlanar[iB] || radius <= 0) return null;
  const A = faceAnchor(m, fa), B = faceAnchor(m, fb);
  if (!A || !B) return null;
  const tRaw = cross(A.n, B.n);
  if (Math.hypot(...tRaw) < 1e-6) return null;
  const t = unit(tRaw);
  // Points of the current blend face.
  const g = m.faceGroups[iBlend];
  const verts: Vec3[] = [];
  for (let k = g.start; k < g.start + g.count; k++) verts.push(vtx(m, m.triangles[k]));
  if (!verts.length) return null;
  const c = verts.reduce<Vec3>((acc, v) => [acc[0] + v[0] / verts.length, acc[1] + v[1] / verts.length, acc[2] + v[2] / verts.length], [0, 0, 0]);
  // The edge line: on both planes, through the blend's centroid along t.
  const x0 = solve3([A.n, B.n, t], [dot(A.n, A.p), dot(B.n, B.p), dot(t, c)]);
  if (!x0) return null;
  let lo = Infinity, hi = -Infinity;
  for (const v of verts) {
    const s = dot(sub(v, x0), t);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  const at = (s: number): Vec3 => [x0[0] + t[0] * s, x0[1] + t[1] * s, x0[2] + t[2] * s];
  // Same test as for a sharp edge, on the rebuilt one (in the air for a convex fillet).
  const convex = edgeIsConvex(m, A, B, at((lo + hi) / 2));
  const out = { arc: [] as number[], normals: [] as number[], bands: [] as number[] };
  roundSegments([[at(lo), at(hi)]], A.n, B.n, convex, radius, steps, out);
  return pack(out);
}

/** Solves the 3×3 system with rows `r` and right-hand side `b` (Cramer); null when singular. */
function solve3(r: [Vec3, Vec3, Vec3], b: [number, number, number]): Vec3 | null {
  const det = (m: [Vec3, Vec3, Vec3]) => dot(m[0], cross(m[1], m[2]));
  const D = det(r);
  if (Math.abs(D) < 1e-12) return null;
  const col = (k: number): [Vec3, Vec3, Vec3] => r.map((row, i) => row.map((v, j) => (j === k ? b[i] : v)) as Vec3) as [Vec3, Vec3, Vec3];
  return [det(col(0)) / D, det(col(1)) / D, det(col(2)) / D];
}

/**
 * Preview of a cove of `radius` on the edge `edgeName`, whose current groove
 * faces are `coveFaces`: the quarter-round surface centred on the edge (rebuilt
 * from the planes of its two faces) and the bands it takes off them. Null when
 * those faces aren't planar.
 */
export function covePreview(m: MeshData, coveFaces: string[], edgeName: string, radius: number, steps = 8): FilletPreview | null {
  const [fa, fb] = edgeFaces(edgeName);
  const iA = m.faceNames.indexOf(fa), iB = m.faceNames.indexOf(fb);
  if (iA < 0 || iB < 0 || !m.facePlanar[iA] || !m.facePlanar[iB] || radius <= 0) return null;
  const A = faceAnchor(m, fa), B = faceAnchor(m, fb);
  if (!A || !B) return null;
  const tRaw = cross(A.n, B.n);
  if (Math.hypot(...tRaw) < 1e-6) return null;
  const t = unit(tRaw);
  const verts: Vec3[] = [];
  for (const name of coveFaces) {
    const i = m.faceNames.indexOf(name);
    if (i < 0) continue;
    const g = m.faceGroups[i];
    for (let k = g.start; k < g.start + g.count; k++) verts.push(vtx(m, m.triangles[k]));
  }
  if (!verts.length) return null;
  const c = verts.reduce<Vec3>((acc, v) => [acc[0] + v[0] / verts.length, acc[1] + v[1] / verts.length, acc[2] + v[2] / verts.length], [0, 0, 0]);
  const x0 = solve3([A.n, B.n, t], [dot(A.n, A.p), dot(B.n, B.p), dot(t, c)]);
  if (!x0) return null;
  let lo = Infinity, hi = -Infinity;
  for (const v of verts) {
    const s = dot(sub(v, x0), t);
    lo = Math.min(lo, s);
    hi = Math.max(hi, s);
  }
  // Directions along each face away from the edge (into the face): minus the other normal, flattened.
  const along = (n: Vec3, other: Vec3): Vec3 => {
    const k = dot(other, n);
    return unit([-(other[0] - k * n[0]), -(other[1] - k * n[1]), -(other[2] - k * n[2])]);
  };
  const dA = along(A.n, B.n), dB = along(B.n, A.n);
  const ang = Math.acos(Math.max(-1, Math.min(1, dot(dA, dB))));
  const sin = Math.sin(ang) || 1;
  const arc: number[] = [], normals: number[] = [], bands: number[] = [];
  const section = (p: Vec3) => {
    const pts: Vec3[] = [], nrm: Vec3[] = [];
    for (let j = 0; j <= steps; j++) {
      const f = j / steps;
      const wa = Math.sin((1 - f) * ang) / sin, wb = Math.sin(f * ang) / sin;
      const u: Vec3 = [wa * dA[0] + wb * dB[0], wa * dA[1] + wb * dB[1], wa * dA[2] + wb * dB[2]];
      pts.push([p[0] + radius * u[0], p[1] + radius * u[1], p[2] + radius * u[2]]);
      // The groove faces out of the solid, towards the edge it's centred on.
      nrm.push([-u[0], -u[1], -u[2]]);
    }
    return { pts, nrm };
  };
  const p0: Vec3 = [x0[0] + t[0] * lo, x0[1] + t[1] * lo, x0[2] + t[2] * lo];
  const p1: Vec3 = [x0[0] + t[0] * hi, x0[1] + t[1] * hi, x0[2] + t[2] * hi];
  const a0 = section(p0), a1 = section(p1);
  for (let j = 0; j < steps; j++) {
    arc.push(...a0.pts[j], ...a1.pts[j], ...a1.pts[j + 1], ...a0.pts[j], ...a1.pts[j + 1], ...a0.pts[j + 1]);
    normals.push(...a0.nrm[j], ...a1.nrm[j], ...a1.nrm[j + 1], ...a0.nrm[j], ...a1.nrm[j + 1], ...a0.nrm[j + 1]);
  }
  for (const [t0, t1] of [
    [a0.pts[0], a1.pts[0]],
    [a0.pts[steps], a1.pts[steps]],
  ] as const) {
    bands.push(...p0, ...p1, ...t1, ...p0, ...t1, ...t0);
  }
  return { arc: new Float32Array(arc), normals: new Float32Array(normals), bands: new Float32Array(bands) };
}
