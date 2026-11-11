// Finds closed regions in a sketch for the kernel to turn into faces.
// Pure geometry, no WASM: runs in the kernel worker and in tests.

import type { SkArc, SkCurve, SketchData } from "./model";
import { curveEnds, entityMap, pointOf } from "./model";
import { bezierPoint, ellipseGeom, ellipsePolygon, splineBeziers, splinePoints, type EllipseGeom } from "./curves";

export type Pt = [number, number];

/** One piece of a closed path; arcs are given by a point halfway along them. */
export type Segment = { kind: "line"; to: Pt } | { kind: "arc"; to: Pt; mid: Pt } | { kind: "bezier"; to: Pt; c1: Pt; c2: Pt };

export type Loop =
  | { kind: "path"; start: Pt; segments: Segment[] }
  | { kind: "circle"; cx: number; cy: number; r: number }
  | ({ kind: "ellipse" } & EllipseGeom);

export interface ProfileResult {
  loops: Loop[];
  /** Curves that are not part of any closed loop (shown, but ignored by solids). */
  openCurves: string[];
}

const TOL = 1e-6;

/** Point halfway along an arc (counter-clockwise from start to end). */
export function arcMidpoint(s: SketchData | ReturnType<typeof entityMap>, a: SkArc): Pt {
  const c = pointOf(s, a.center), p0 = pointOf(s, a.start), p1 = pointOf(s, a.end);
  const a0 = Math.atan2(p0.y - c.y, p0.x - c.x);
  let a1 = Math.atan2(p1.y - c.y, p1.x - c.x);
  if (a1 <= a0) a1 += Math.PI * 2;
  const am = (a0 + a1) / 2;
  const r = Math.hypot(p0.x - c.x, p0.y - c.y);
  return [c.x + r * Math.cos(am), c.y + r * Math.sin(am)];
}

/** A piece of a curve between two vertices (a whole curve unless something ends on it). */
interface Piece {
  curve: string;
  a: string;
  b: string;
  segs: (forward: boolean) => Segment[];
  /** A point a little way along the piece from where the walk starts (gives the leaving direction). */
  probe: (forward: boolean) => Pt;
}

/** Distance under which an end point counts as lying on another curve. */
const ON_TOL = 1e-5;

/**
 * Closed regions from non-construction geometry. Lines, arcs and open splines
 * are joined through shared point ids or coincident constraints. A curve end
 * that lies on another line, arc or circle splits it there (T-junctions, as
 * left by trimming) and dangling pieces are ignored. The pieces form a planar
 * graph whose bounded faces are the loops; faces side by side are fused later
 * (see nestLoops). Circles and ellipses nothing ends on are loops of their own.
 */
export function findLoops(s: SketchData): ProfileResult {
  const m = entityMap(s);
  const loops: Loop[] = [];

  // Union-find over point ids so coincident points act as one vertex.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  for (const c of s.constraints) if (c.kind === "coincident") parent.set(find(c.a), find(c.b));

  type OpenCurve = Extract<SkCurve, { kind: "line" | "arc" | "spline" }>;
  const solid = s.entities.filter((e): e is SkCurve => e.kind !== "point" && !e.construction);
  const open = solid.filter((e): e is OpenCurve => e.kind === "line" || e.kind === "arc" || (e.kind === "spline" && !e.closed));

  // Vertices: the (merged) end points of open curves.
  const vertices = new Map<string, Pt>();
  for (const c of open) for (const id of curveEnds(c)!) {
    const p = pointOf(m, find(id));
    vertices.set(find(id), [p.x, p.y]);
  }
  const pos = (v: string) => vertices.get(v)!;
  const ang = (cx: number, cy: number, p: Pt) => Math.atan2(p[1] - cy, p[0] - cx);
  const arcSeg = (cx: number, cy: number, r: number, a0: number, a1: number, to: Pt): Segment => {
    const am = (a0 + a1) / 2;
    return { kind: "arc", to, mid: [cx + r * Math.cos(am), cy + r * Math.sin(am)] };
  };
  /** Counter-clockwise arc pieces through the sorted vertices `vs` (angles increasing from a0). */
  const arcPieces = (curve: string, cx: number, cy: number, r: number, vs: { v: string; t: number }[]): Piece[] =>
    vs.slice(0, -1).map((x, i) => {
      const y = vs[i + 1];
      const at = (t: number): Pt => [cx + r * Math.cos(t), cy + r * Math.sin(t)];
      return {
        curve,
        a: x.v,
        b: y.v,
        segs: (fwd) => [fwd ? arcSeg(cx, cy, r, x.t, y.t, pos(y.v)) : arcSeg(cx, cy, r, x.t, y.t, pos(x.v))],
        probe: (fwd) => at(fwd ? x.t + (y.t - x.t) * 0.02 : y.t - (y.t - x.t) * 0.02),
      };
    });
  const twoPi = Math.PI * 2;

  const pieces: Piece[] = [];
  for (const c of solid) {
    if (c.kind === "line") {
      const [a, b] = [find(c.p1), find(c.p2)];
      const A = pos(a), B = pos(b);
      const dx = B[0] - A[0], dy = B[1] - A[1], len2 = dx * dx + dy * dy;
      const inner: { v: string; t: number }[] = [];
      for (const [v, p] of vertices) {
        if (v === a || v === b || len2 < 1e-18) continue;
        const t = ((p[0] - A[0]) * dx + (p[1] - A[1]) * dy) / len2;
        if (t <= 1e-9 || t >= 1 - 1e-9) continue;
        if (Math.hypot(A[0] + t * dx - p[0], A[1] + t * dy - p[1]) < ON_TOL) inner.push({ v, t });
      }
      const chain = [{ v: a, t: 0 }, ...inner.sort((x, y) => x.t - y.t), { v: b, t: 1 }];
      for (let i = 0; i + 1 < chain.length; i++) {
        const x = chain[i].v, y = chain[i + 1].v;
        pieces.push({
          curve: c.id,
          a: x,
          b: y,
          segs: (fwd) => [{ kind: "line", to: pos(fwd ? y : x) }],
          probe: (fwd) => (fwd ? pos(y) : pos(x)),
        });
      }
    } else if (c.kind === "arc" || c.kind === "circle") {
      const ctr = pointOf(m, c.center);
      const r = c.radius;
      const onCurve = (p: Pt) => Math.abs(Math.hypot(p[0] - ctr.x, p[1] - ctr.y) - r) < ON_TOL;
      if (c.kind === "arc") {
        const [a, b] = [find(c.start), find(c.end)];
        const a0 = ang(ctr.x, ctr.y, pos(a));
        let span = ang(ctr.x, ctr.y, pos(b)) - a0;
        if (span <= 0) span += twoPi;
        const inner: { v: string; t: number }[] = [];
        for (const [v, p] of vertices) {
          if (v === a || v === b || !onCurve(p)) continue;
          let t = ang(ctr.x, ctr.y, p) - a0;
          t = ((t % twoPi) + twoPi) % twoPi;
          if (t > 1e-9 && t < span - 1e-9) inner.push({ v, t: a0 + t });
        }
        pieces.push(...arcPieces(c.id, ctr.x, ctr.y, r, [{ v: a, t: a0 }, ...inner.sort((x, y) => x.t - y.t), { v: b, t: a0 + span }]));
      } else {
        const on = [...vertices].filter(([, p]) => onCurve(p)).map(([v, p]) => ({ v, t: ang(ctr.x, ctr.y, p) }));
        if (on.length < 2) {
          if (r > TOL) loops.push({ kind: "circle", cx: ctr.x, cy: ctr.y, r });
          continue;
        }
        on.sort((x, y) => x.t - y.t);
        pieces.push(...arcPieces(c.id, ctr.x, ctr.y, r, [...on, { v: on[0].v, t: on[0].t + twoPi }]));
      }
    } else if (c.kind === "spline" && !c.closed) {
      const [a, b] = curveEnds(c)!.map(find);
      pieces.push({
        curve: c.id,
        a,
        b,
        // A spline walked backwards is the same curve through its points reversed.
        segs: (fwd) => {
          const pts = splinePoints(m, c);
          return splineBeziers(fwd ? pts : pts.reverse()).map((z) => ({ kind: "bezier", ...z }));
        },
        probe: (fwd) => {
          const pts = splinePoints(m, c);
          if (!fwd) pts.reverse();
          return bezierPoint(pts[0], splineBeziers(pts)[0], 0.02);
        },
      });
    } else if (c.kind === "ellipse") {
      const g = ellipseGeom(m, c);
      if (g.a > TOL && g.b > TOL) loops.push({ kind: "ellipse", ...g });
    } else if (c.kind === "spline" && c.closed && c.points.length >= 3) {
      const pts = splinePoints(m, c);
      const loop: Loop = { kind: "path", start: pts[0], segments: splineBeziers(pts, true).map((b) => ({ kind: "bezier", ...b })) };
      if (loopArea(loop) > TOL) loops.push(loop);
    }
  }

  // Drop dangling pieces (an end nothing else meets), repeatedly.
  let live = pieces;
  for (;;) {
    const deg = new Map<string, number>();
    for (const p of live) for (const v of [p.a, p.b]) deg.set(v, (deg.get(v) ?? 0) + 1);
    const next = live.filter((p) => deg.get(p.a)! > 1 && deg.get(p.b)! > 1);
    if (next.length === live.length) break;
    live = next;
  }

  // Half-edges leaving each vertex, sorted counter-clockwise by leaving direction.
  type Half = { p: Piece; fwd: boolean };
  const from = (h: Half) => (h.fwd ? h.p.a : h.p.b);
  const to = (h: Half) => (h.fwd ? h.p.b : h.p.a);
  const angle = (h: Half) => {
    const o = pos(from(h)), q = h.p.probe(h.fwd);
    return Math.atan2(q[1] - o[1], q[0] - o[0]);
  };
  const out = new Map<string, Half[]>();
  for (const p of live) for (const h of [{ p, fwd: true }, { p, fwd: false }]) out.set(from(h), [...(out.get(from(h)) ?? []), h]);
  for (const list of out.values()) list.sort((x, y) => angle(x) - angle(y));

  // Walk each face keeping it on the left: at every vertex turn to the edge just clockwise of the way back.
  const key = (h: Half) => `${pieces.indexOf(h.p)}${h.fwd ? "+" : "-"}`;
  const seen = new Set<string>();
  const inLoop = new Set<string>();
  for (const first of [...out.values()].flat()) {
    if (seen.has(key(first))) continue;
    const face: Half[] = [];
    let h = first;
    while (!seen.has(key(h))) {
      seen.add(key(h));
      face.push(h);
      const list = out.get(to(h))!;
      const back = list.findIndex((x) => x.p === h.p && x.fwd !== h.fwd);
      h = list[(back - 1 + list.length) % list.length];
    }
    if (face.length < 2 || h !== first) continue;
    const loop: Loop = { kind: "path", start: pos(from(face[0])), segments: face.flatMap((x) => x.p.segs(x.fwd)) };
    // Bounded faces run counter-clockwise; the outside of each component comes out clockwise.
    if (polygonArea(loopPolygon(loop)) > TOL) {
      loops.push(loop);
      for (const x of face) inLoop.add(x.p.curve);
    }
  }

  const openCurves = [...new Set(pieces.map((p) => p.curve))].filter((id) => !inLoop.has(id));
  return { loops, openCurves };
}

/** Polyline approximation of a loop (arcs sampled), for area and containment. */
export function loopPolygon(l: Loop, arcSteps = 16): Pt[] {
  if (l.kind === "circle") {
    return Array.from({ length: 48 }, (_, i) => [l.cx + l.r * Math.cos((i / 48) * Math.PI * 2), l.cy + l.r * Math.sin((i / 48) * Math.PI * 2)] as Pt);
  }
  if (l.kind === "ellipse") return ellipsePolygon(l, 64);
  const pts: Pt[] = [l.start];
  let from = l.start;
  for (const s of l.segments) {
    if (s.kind === "bezier") for (let k = 1; k < arcSteps; k++) pts.push(bezierPoint(from, s, k / arcSteps));
    if (s.kind === "arc") {
      const c = circleThrough(from, s.mid, s.to);
      if (c) {
        const a0 = Math.atan2(from[1] - c.y, from[0] - c.x);
        const am = Math.atan2(s.mid[1] - c.y, s.mid[0] - c.x);
        const a1 = Math.atan2(s.to[1] - c.y, s.to[0] - c.x);
        // Sweep from a0 to a1 passing through am.
        const ccw = normAngle(am - a0) < normAngle(a1 - a0);
        const sweep = ccw ? normAngle(a1 - a0) : -normAngle(a0 - a1);
        for (let k = 1; k < arcSteps; k++) {
          const t = a0 + (sweep * k) / arcSteps;
          pts.push([c.x + c.r * Math.cos(t), c.y + c.r * Math.sin(t)]);
        }
      }
    }
    pts.push(s.to);
    from = s.to;
  }
  pts.pop(); // closing point repeats the start
  return pts;
}

const normAngle = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);

export function circleThrough(a: Pt, b: Pt, c: Pt): { x: number; y: number; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const x = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const y = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { x, y, r: Math.hypot(a[0] - x, a[1] - y) };
}

export function polygonArea(pts: Pt[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function loopArea(l: Loop): number {
  return l.kind === "circle" ? Math.PI * l.r * l.r : Math.abs(polygonArea(loopPolygon(l)));
}

/** A point just inside the loop (off its boundary, which neighbouring regions share). */
function samplePoint(l: Loop): Pt {
  if (l.kind === "circle") return [l.cx + l.r * 0.999, l.cy];
  if (l.kind === "ellipse") return [l.cx + l.a * 0.999 * Math.cos(l.angle), l.cy + l.a * 0.999 * Math.sin(l.angle)];
  const poly = loopPolygon(l);
  const sign = polygonArea(poly) > 0 ? 1 : -1;
  // Midpoint of the longest edge, nudged towards the inside.
  let best = 0, len = -1;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
    const d = Math.hypot(x2 - x1, y2 - y1);
    if (d > len) {
      len = d;
      best = i;
    }
  }
  const [x1, y1] = poly[best], [x2, y2] = poly[(best + 1) % poly.length];
  const k = (sign * Math.min(len * 0.01, 1e-3)) / (len || 1);
  return [(x1 + x2) / 2 - (y2 - y1) * k, (y1 + y2) / 2 + (x2 - x1) * k];
}

export function loopContains(outer: Loop, [x, y]: Pt): boolean {
  if (outer.kind === "circle") return (x - outer.cx) ** 2 + (y - outer.cy) ** 2 < outer.r * outer.r;
  let inside = false;
  const p = loopPolygon(outer);
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Orders loops by area and assigns nesting depth: even adds material, odd is a hole. */
export function nestLoops(loops: Loop[]): { loop: Loop; depth: number }[] {
  const sorted = [...loops].sort((a, b) => loopArea(b) - loopArea(a));
  return sorted.map((loop, i) => {
    const pt = samplePoint(loop);
    const depth = sorted.slice(0, i).filter((o) => loopContains(o, pt)).length;
    return { loop, depth };
  });
}
