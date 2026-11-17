// Overhang analysis for 3D printing: triangles of the display mesh that face
// downwards more steeply than the printer can bridge without supports. Z is
// the build direction; each body sits on the bed at its lowest point.

import type { MeshData } from "../model/types";

export interface Overhangs {
  /** Triangles needing support, as plain positions (x, y, z × 3 per triangle). */
  positions: Float32Array;
  /** Their total area, mm². */
  area: number;
}

/**
 * Faces leaning more than `angle` degrees from vertical while facing down
 * need support (45° is the usual limit). Downward faces lying on the bed
 * (at the body's lowest z) print on the plate and don't count.
 */
export function findOverhangs(m: MeshData, angle = 45): Overhangs {
  const limit = -Math.sin((angle * Math.PI) / 180);
  // Lowest point of each body: its bed.
  const bed = new Map<string, number>();
  const triBody: string[] = [];
  m.faceGroups.forEach((g, i) => {
    const body = m.faceBody[i] ?? "";
    for (let k = g.start; k < g.start + g.count; k += 3) triBody[k / 3] = body;
  });
  for (let k = 0; k < m.triangles.length; k++) {
    const body = triBody[Math.floor(k / 3)] ?? "";
    const z = m.vertices[m.triangles[k] * 3 + 2];
    if (z < (bed.get(body) ?? Infinity)) bed.set(body, z);
  }
  const out: number[] = [];
  let area = 0;
  const v = (i: number) => [m.vertices[i * 3], m.vertices[i * 3 + 1], m.vertices[i * 3 + 2]];
  for (let t = 0; t < m.triangles.length; t += 3) {
    const ia = m.triangles[t], ib = m.triangles[t + 1], ic = m.triangles[t + 2];
    const a = v(ia), b = v(ib), c = v(ic);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-12) continue;
    n = n.map((x) => x / len);
    // Orient like the mesh's own normals (outward), whatever the winding.
    const vn = [0, 1, 2].map((k) => m.normals[ia * 3 + k] + m.normals[ib * 3 + k] + m.normals[ic * 3 + k]);
    if (n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2] < 0) n = n.map((x) => -x);
    if (n[2] >= limit) continue;
    const floor = bed.get(triBody[t / 3] ?? "") ?? -Infinity;
    if (Math.max(a[2], b[2], c[2]) - floor < 1e-3) continue; // on the bed
    out.push(...a, ...b, ...c);
    area += len / 2;
  }
  return { positions: new Float32Array(out), area };
}
