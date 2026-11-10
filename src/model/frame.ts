// Sketch coordinate frames: an origin and three orthonormal axes in world space.
// Standard planes and planar faces both resolve to a Frame.

import type { PlaneName } from "./types";

export type Vec3 = [number, number, number];

export interface Frame {
  origin: Vec3;
  x: Vec3;
  y: Vec3;
  /** Plane normal; extrusions go along +n for positive distances. */
  n: Vec3;
}

export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

/** Matches replicad's named planes (XZ has its normal along -Y). */
export function standardFrame(plane: PlaneName, offset = 0): Frame {
  switch (plane) {
    case "XY":
      return { origin: [0, 0, offset], x: [1, 0, 0], y: [0, 1, 0], n: [0, 0, 1] };
    case "XZ":
      return { origin: [0, -offset, 0], x: [1, 0, 0], y: [0, 0, 1], n: [0, -1, 0] };
    case "YZ":
      return { origin: [offset, 0, 0], x: [0, 1, 0], y: [0, 0, 1], n: [1, 0, 0] };
  }
}

/**
 * Frame for a planar face, independent of where the face happens to be:
 * origin is the point of the plane closest to the world origin and x is the
 * world X axis projected onto the plane (world Y if X is nearly normal).
 * That keeps sketch coordinates stable when upstream dimensions change.
 */
export function planeFrame(point: Vec3, normal: Vec3, offset = 0): Frame {
  const n = unit(normal);
  const origin = scale(n, dot(point, n) + offset);
  const ref: Vec3 = Math.abs(n[0]) > 0.9 ? [0, 1, 0] : [1, 0, 0];
  const x = unit(sub(ref, scale(n, dot(ref, n))));
  const y = cross(n, x);
  return { origin, x, y, n };
}

export const frameToWorld = (f: Frame, u: number, v: number): Vec3 => add(f.origin, add(scale(f.x, u), scale(f.y, v)));

export function frameToLocal(f: Frame, p: Vec3): [number, number] {
  const d = sub(p, f.origin);
  return [dot(d, f.x), dot(d, f.y)];
}
