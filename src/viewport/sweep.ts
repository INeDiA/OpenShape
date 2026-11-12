// Client-side previews of extrusions and revolutions of sketch regions: the
// swept volume as plain triangles, drawn translucent while a handle is dragged
// (the exact solid comes from the kernel afterwards).

import * as THREE from "three";
import type { Vec3 } from "../model/frame";
import type { SketchPreview } from "../model/types";

type Loop2 = THREE.Vector2[];

/** Outline and holes of the chosen regions (all of them when `ids` is empty), in sketch coordinates. */
function regionLoops(sk: SketchPreview, ids?: string[]): { outer: Loop2; holes: Loop2[] }[] {
  const toLoop = (a: Float32Array): Loop2 => {
    const pts = Array.from({ length: a.length / 2 }, (_, i) => new THREE.Vector2(a[i * 2], a[i * 2 + 1]));
    // Drop a repeated closing point.
    if (pts.length > 1 && pts[0].distanceTo(pts[pts.length - 1]) < 1e-9) pts.pop();
    return pts;
  };
  const chosen = ids?.length ? sk.regions.filter((r) => ids.includes(r.id)) : sk.regions;
  return chosen.map((r) => ({ outer: toLoop(r.outer), holes: r.holes.map(toLoop) }));
}

const onPlane = (sk: SketchPreview, p: THREE.Vector2): THREE.Vector3 => {
  const { origin: o, x, y } = sk.frame;
  return new THREE.Vector3(o[0] + x[0] * p.x + y[0] * p.y, o[1] + x[1] * p.x + y[1] * p.y, o[2] + x[2] * p.x + y[2] * p.y);
};

/**
 * Triangles of a profile swept through `steps + 1` positions given by `place`
 * (k = 0 … steps): side walls between consecutive positions, and caps at both
 * ends unless `closed` (a full turn has no ends).
 */
function sweep(loops: { outer: Loop2; holes: Loop2[] }[], steps: number, place: (p: THREE.Vector2, k: number) => THREE.Vector3, closed: boolean): Float32Array {
  const out: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (const { outer, holes } of loops) {
    for (const loop of [outer, ...holes]) {
      for (let i = 0; i < loop.length; i++) {
        const p = loop[i], q = loop[(i + 1) % loop.length];
        for (let k = 0; k < steps; k++) {
          const a = place(p, k), b = place(q, k), c = place(q, k + 1), d = place(p, k + 1);
          tri(a, b, c);
          tri(a, c, d);
        }
      }
    }
    if (closed) continue;
    const faces = THREE.ShapeUtils.triangulateShape(outer, holes);
    const all = [outer, ...holes].flat();
    for (const k of [0, steps]) for (const [i, j, l] of faces) tri(place(all[i], k), place(all[j], k), place(all[l], k));
  }
  return new Float32Array(out);
}

/** The volume swept by extruding regions of a sketch by `distance` along its normal. */
export function extrudeSweep(sk: SketchPreview, ids: string[] | undefined, distance: number): Float32Array {
  const n = new THREE.Vector3(...sk.frame.n);
  return sweep(regionLoops(sk, ids), 1, (p, k) => onPlane(sk, p).addScaledVector(n, k * distance), false);
}

/** The volume swept by revolving regions of a sketch by `angle` degrees about the axis through `origin` along `dir`. */
export function revolveSweep(sk: SketchPreview, ids: string[] | undefined, origin: Vec3, dir: Vec3, angle: number): Float32Array {
  const o = new THREE.Vector3(...origin);
  const axis = new THREE.Vector3(...dir).normalize();
  const steps = Math.max(4, Math.ceil(Math.abs(angle) / 6));
  const closed = Math.abs(angle) >= 360 - 1e-6;
  const q = new THREE.Quaternion();
  return sweep(
    regionLoops(sk, ids),
    steps,
    (p, k) => {
      q.setFromAxisAngle(axis, ((angle * k) / steps) * (Math.PI / 180));
      return onPlane(sk, p).sub(o).applyQuaternion(q).add(o);
    },
    closed,
  );
}
