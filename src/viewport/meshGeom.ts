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

const vtx = (m: MeshData, i: number): Vec3 => [m.vertices[i * 3], m.vertices[i * 3 + 1], m.vertices[i * 3 + 2]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const avg = (ps: Vec3[]): Vec3 => [0, 1, 2].map((k) => ps.reduce((s, p) => s + p[k], 0) / ps.length) as Vec3;
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
