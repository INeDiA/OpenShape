// Finds closed regions in a sketch for the kernel to turn into faces.
// Pure geometry, no WASM: runs in the kernel worker and in tests.

import type { SkArc, SkCurve, SketchData } from "./model";
import { curveEnds, entityMap, pointOf } from "./model";

export type Pt = [number, number];

/** One piece of a closed path; arcs are given by a point halfway along them. */
export type Segment = { kind: "line"; to: Pt } | { kind: "arc"; to: Pt; mid: Pt };

export type Loop =
  | { kind: "path"; start: Pt; segments: Segment[] }
  | { kind: "circle"; cx: number; cy: number; r: number };

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

/**
 * Closed loops from non-construction geometry. Lines and arcs are joined
 * through shared point ids or coincident constraints; every vertex of a loop
 * must have degree 2. Circles are loops on their own.
 */
export function findLoops(s: SketchData): ProfileResult {
  const m = entityMap(s);
  const loops: Loop[] = [];
  const openCurves: string[] = [];

  for (const e of s.entities) {
    if (e.kind === "circle" && !e.construction) {
      const c = pointOf(m, e.center);
      if (e.radius > TOL) loops.push({ kind: "circle", cx: c.x, cy: c.y, r: e.radius });
    }
  }

  // Union-find over point ids so coincident points act as one vertex.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  for (const c of s.constraints) if (c.kind === "coincident") parent.set(find(c.a), find(c.b));

  const open = s.entities.filter((e): e is Exclude<SkCurve, { kind: "circle" }> => (e.kind === "line" || e.kind === "arc") && !e.construction);
  const ends = (c: (typeof open)[number]) => curveEnds(c)!.map(find) as [string, string];
  const adj = new Map<string, (typeof open)[number][]>();
  for (const c of open) for (const p of ends(c)) adj.set(p, [...(adj.get(p) ?? []), c]);

  const visited = new Set<string>();
  for (const first of open) {
    if (visited.has(first.id)) continue;
    const comp: (typeof open)[number][] = [];
    const stack = [first];
    while (stack.length) {
      const c = stack.pop()!;
      if (visited.has(c.id)) continue;
      visited.add(c.id);
      comp.push(c);
      for (const p of ends(c)) for (const n of adj.get(p) ?? []) if (!visited.has(n.id)) stack.push(n);
    }
    const vertices = new Set(comp.flatMap(ends));
    // Two arcs (or an arc and a line) can close a loop; a single curve can't.
    const closed = comp.length >= 2 && [...vertices].every((v) => adj.get(v)!.length === 2);
    if (!closed) {
      openCurves.push(...comp.map((c) => c.id));
      continue;
    }

    // Walk the cycle, recording each curve in the direction it's traversed.
    const startId = curveEnds(comp[0])![0];
    const start = pointOf(m, startId);
    let at = find(startId);
    let cur = comp[0];
    const used = new Set<string>();
    const segments: Segment[] = [];
    for (let i = 0; i < comp.length; i++) {
      used.add(cur.id);
      const [a, b] = curveEnds(cur)!;
      const forward = find(a) === at;
      const toId = forward ? b : a;
      const to = pointOf(m, toId);
      segments.push(cur.kind === "line" ? { kind: "line", to: [to.x, to.y] } : { kind: "arc", to: [to.x, to.y], mid: arcMidpoint(m, cur) });
      at = find(toId);
      const next = adj.get(at)!.find((c) => !used.has(c.id));
      if (!next) break;
      cur = next;
    }
    const loop: Loop = { kind: "path", start: [start.x, start.y], segments };
    if (loopArea(loop) > TOL) loops.push(loop);
    else openCurves.push(...comp.map((c) => c.id));
  }

  return { loops, openCurves };
}

/** Polyline approximation of a loop (arcs sampled), for area and containment. */
export function loopPolygon(l: Loop, arcSteps = 16): Pt[] {
  if (l.kind === "circle") {
    return Array.from({ length: 48 }, (_, i) => [l.cx + l.r * Math.cos((i / 48) * Math.PI * 2), l.cy + l.r * Math.sin((i / 48) * Math.PI * 2)] as Pt);
  }
  const pts: Pt[] = [l.start];
  let from = l.start;
  for (const s of l.segments) {
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

function samplePoint(l: Loop): Pt {
  if (l.kind === "circle") return [l.cx + l.r * 0.999, l.cy];
  return l.start;
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
