// Geometry of the curves that aren't lines or circular arcs: ellipses and
// splines, plus a polyline of any curve (drawing, hit testing, naming).

import type { SkCurve, SkEllipse, SkSpline } from "./model";
import { entityMap, pointOf } from "./model";

export type Pt = [number, number];
type Points = Parameters<typeof pointOf>[0];

export interface EllipseGeom {
  cx: number;
  cy: number;
  /** Semi-axes: a along the major direction, b perpendicular to it. */
  a: number;
  b: number;
  /** Major axis direction, radians from +X. */
  angle: number;
}

export function ellipseGeom(m: Points, e: SkEllipse): EllipseGeom {
  const c = pointOf(m, e.center), ma = pointOf(m, e.major), mi = pointOf(m, e.minor);
  return { cx: c.x, cy: c.y, a: Math.hypot(ma.x - c.x, ma.y - c.y), b: Math.hypot(mi.x - c.x, mi.y - c.y), angle: Math.atan2(ma.y - c.y, ma.x - c.x) };
}

export function ellipsePolygon(g: EllipseGeom, steps = 64): Pt[] {
  const ca = Math.cos(g.angle), sa = Math.sin(g.angle);
  return Array.from({ length: steps }, (_, i) => {
    const t = (i / steps) * Math.PI * 2;
    const x = g.a * Math.cos(t), y = g.b * Math.sin(t);
    return [g.cx + x * ca - y * sa, g.cy + x * sa + y * ca] as Pt;
  });
}

export interface Bezier {
  c1: Pt;
  c2: Pt;
  to: Pt;
}

/**
 * Cubic Bézier pieces of a Catmull-Rom spline through `pts` (uniform, tension
 * 1/6 control offsets). Open splines get a zero-curvature-ish end by mirroring
 * the neighbours; closed ones wrap around.
 */
export function splineBeziers(pts: Pt[], closed = false): Bezier[] {
  const n = pts.length;
  if (n < 2) return [];
  const at = (i: number): Pt => {
    if (closed) return pts[((i % n) + n) % n];
    if (i < 0) return [2 * pts[0][0] - pts[1][0], 2 * pts[0][1] - pts[1][1]];
    if (i >= n) return [2 * pts[n - 1][0] - pts[n - 2][0], 2 * pts[n - 1][1] - pts[n - 2][1]];
    return pts[i];
  };
  const out: Bezier[] = [];
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    out.push({
      c1: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      c2: [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      to: p2,
    });
  }
  return out;
}

export function bezierPoint(from: Pt, b: Bezier, t: number): Pt {
  const u = 1 - t;
  const k0 = u * u * u, k1 = 3 * u * u * t, k2 = 3 * u * t * t, k3 = t * t * t;
  return [k0 * from[0] + k1 * b.c1[0] + k2 * b.c2[0] + k3 * b.to[0], k0 * from[1] + k1 * b.c1[1] + k2 * b.c2[1] + k3 * b.to[1]];
}

export function splinePoints(m: Points, e: SkSpline): Pt[] {
  return e.points.map((id) => {
    const p = pointOf(m, id);
    return [p.x, p.y] as Pt;
  });
}

/** Points along a spline, closed splines end back at the start. */
export function splinePolyline(pts: Pt[], closed = false, steps = 16): Pt[] {
  const out: Pt[] = pts.length ? [pts[0]] : [];
  let from = pts[0];
  for (const b of splineBeziers(pts, closed)) {
    for (let k = 1; k <= steps; k++) out.push(bezierPoint(from, b, k / steps));
    from = b.to;
  }
  return out;
}

/** Polyline approximation of any curve, in sketch coordinates. Closed curves repeat their first point. */
export function curvePolyline(s: Points, c: SkCurve, steps = 24): Pt[] {
  const m = s instanceof Map ? s : entityMap(s);
  switch (c.kind) {
    case "line": {
      const a = pointOf(m, c.p1), b = pointOf(m, c.p2);
      return [
        [a.x, a.y],
        [b.x, b.y],
      ];
    }
    case "circle": {
      const ctr = pointOf(m, c.center);
      const pts = ellipsePolygon({ cx: ctr.x, cy: ctr.y, a: c.radius, b: c.radius, angle: 0 }, steps * 2);
      return [...pts, pts[0]];
    }
    case "arc": {
      const ctr = pointOf(m, c.center), s0 = pointOf(m, c.start), s1 = pointOf(m, c.end);
      const a0 = Math.atan2(s0.y - ctr.y, s0.x - ctr.x);
      let a1 = Math.atan2(s1.y - ctr.y, s1.x - ctr.x);
      if (a1 <= a0) a1 += Math.PI * 2;
      const r = Math.hypot(s0.x - ctr.x, s0.y - ctr.y);
      return Array.from({ length: steps + 1 }, (_, i) => {
        const t = a0 + ((a1 - a0) * i) / steps;
        return [ctr.x + r * Math.cos(t), ctr.y + r * Math.sin(t)] as Pt;
      });
    }
    case "ellipse": {
      const pts = ellipsePolygon(ellipseGeom(m, c), steps * 3);
      return [...pts, pts[0]];
    }
    case "spline":
      return splinePolyline(splinePoints(m, c), c.closed, Math.max(4, Math.round(steps / 2)));
  }
}

/** Distance from (x, y) to a polyline. */
export function polylineDistance(pts: Pt[], x: number, y: number): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
  }
  return best;
}
