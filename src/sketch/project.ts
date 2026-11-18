// Project: the model's edges seen straight through the sketch plane, as
// curves that can be added to the sketch as fixed reference geometry. Edges
// come from the display mesh (each kernel edge sampled into segments) and are
// recognised as lines, circles and arcs where they are; anything else becomes
// a spline through its samples.

import type { MeshData } from "../model/types";
import { frameToLocal, type Frame } from "../model/frame";
import { skId, type SkConstraint, type SkEntity, type SketchData } from "./model";

type P = { x: number; y: number };

export type Projected =
  | { kind: "line"; edge: string; a: P; b: P }
  | { kind: "circle"; edge: string; c: P; r: number }
  /** Counter-clockwise from `a` to `b` around `c`. */
  | { kind: "arc"; edge: string; c: P; r: number; a: P; b: P }
  | { kind: "spline"; edge: string; points: P[]; closed: boolean };

const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);

/** Circle through three points, or null when they're (nearly) collinear. */
function circle3(a: P, b: P, c: P): { c: P; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null;
  const a2 = a.x ** 2 + a.y ** 2, b2 = b.x ** 2 + b.y ** 2, c2 = c.x ** 2 + c.y ** 2;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { c: { x, y }, r: Math.hypot(a.x - x, a.y - y) };
}

/** What one edge's samples (in order, in sketch coordinates) look like on the plane. */
export function classify(edge: string, pts: P[], tol: number): Projected | null {
  if (pts.length < 2) return null;
  // Straight: every sample within tol of the line through the two farthest-apart ones.
  let a = pts[0], b = pts[0], far = 0;
  for (const p of pts) {
    const d = dist(pts[0], p);
    if (d > far) [b, far] = [p, d];
  }
  far = 0;
  for (const p of pts) {
    const d = dist(b, p);
    if (d > far) [a, far] = [p, d];
  }
  if (far < tol) return null; // seen end-on: a point
  const ux = (b.x - a.x) / far, uy = (b.y - a.y) / far;
  if (pts.every((p) => Math.abs((p.x - a.x) * uy - (p.y - a.y) * ux) < tol)) return { kind: "line", edge, a, b };
  // Round: a circle through three spread samples that all the others sit on.
  const closed = dist(pts[0], pts[pts.length - 1]) < tol;
  const n = pts.length - 1;
  const fit = circle3(pts[0], pts[Math.floor(n / 3)], pts[Math.floor((2 * n) / 3)]);
  if (fit && fit.r < 1e5 && pts.every((p) => Math.abs(dist(p, fit.c) - fit.r) < tol)) {
    if (closed) return { kind: "circle", edge, c: fit.c, r: fit.r };
    // Turning direction of the samples: counter-clockwise keeps the order.
    let turn = 0;
    for (let i = 0; i + 1 < pts.length; i++) turn += (pts[i].x - fit.c.x) * (pts[i + 1].y - fit.c.y) - (pts[i].y - fit.c.y) * (pts[i + 1].x - fit.c.x);
    const [s, e] = turn > 0 ? [pts[0], pts[n]] : [pts[n], pts[0]];
    // Centre exactly as far from both ends (the solver keeps the ends on the arc).
    const exact = circle3(pts[0], pts[Math.floor(n / 2)], pts[n]) ?? fit;
    return { kind: "arc", edge, c: exact.c, r: dist(exact.c, s), a: s, b: e };
  }
  // Anything else: a spline through up to 16 of its samples.
  const keep = Math.min(closed ? 15 : 16, closed ? n : n + 1);
  const step = (closed ? n : n) / Math.max(1, keep - (closed ? 0 : 1));
  const points: P[] = [];
  for (let i = 0; i < keep; i++) points.push(pts[Math.min(n, Math.round(i * step))]);
  if (!closed) points[points.length - 1] = pts[n];
  return { kind: "spline", edge, points, closed };
}

/** Every edge of the model as seen through the sketch plane, duplicates (edges behind one another) once. */
export function projectEdges(mesh: MeshData, frame: Frame): Projected[] {
  const v = mesh.edges;
  // Tolerance from the model's size: samples of curved edges are a little off their curve.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < v.length; i++) [lo, hi] = [Math.min(lo, v[i]), Math.max(hi, v[i])];
  const tol = Math.max(1e-4, (hi - lo) * 2e-4);
  const out: Projected[] = [];
  const seen = new Set<string>();
  const r = (x: number) => Math.round(x / (tol * 5));
  const pk = (p: P) => `${r(p.x)},${r(p.y)}`;
  // Edge ends meeting at a vertex get the very same coordinates, so the curves join.
  const ends: P[] = [];
  const snap = (p: P) => ends.find((q) => dist(p, q) < tol) ?? (ends.push(p), p);
  mesh.edgeGroups.forEach((g, i) => {
    if (isSeam(mesh.edgeNames[i])) return;
    const pts: P[] = [];
    for (let k = g.start; k < g.start + g.count; k++) {
      const [x, y] = frameToLocal(frame, [v[k * 3], v[k * 3 + 1], v[k * 3 + 2]]);
      const p = { x, y };
      if (!pts.length || dist(pts[pts.length - 1], p) > 1e-9) pts.push(p);
    }
    if (pts.length >= 2) {
      pts[0] = snap(pts[0]);
      pts[pts.length - 1] = snap(pts[pts.length - 1]);
    }
    const c = classify(mesh.edgeNames[i] ?? String(g.edgeId), pts, tol);
    if (!c) return;
    const key =
      c.kind === "line"
        ? [pk(c.a), pk(c.b)].sort().join("|")
        : c.kind === "circle"
          ? `c${pk(c.c)}:${r(c.r)}`
          : c.kind === "arc"
            ? `a${pk(c.c)}:${r(c.r)}:${pk(c.a)}:${pk(c.b)}`
            : `s${c.points.map(pk).join(";")}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(c);
  });
  // Arcs that go all the way round together (a circle split in pieces) become one circle.
  const sweep = (c: { c: P; a: P; b: P }) => {
    const s = Math.atan2(c.b.y - c.c.y, c.b.x - c.c.x) - Math.atan2(c.a.y - c.c.y, c.a.x - c.c.x);
    return s <= 1e-9 ? s + 2 * Math.PI : s;
  };
  const rings = new Map<string, Extract<Projected, { kind: "arc" }>[]>();
  for (const c of out)
    if (c.kind === "arc") {
      const k = `${pk(c.c)}:${r(c.r)}`;
      rings.set(k, [...(rings.get(k) ?? []), c]);
    }
  for (const arcs of rings.values()) {
    if (arcs.length < 2 || Math.abs(arcs.reduce((t, c) => t + sweep(c), 0) - 2 * Math.PI) > 1e-3) continue;
    const at = out.indexOf(arcs[0]);
    out.splice(at, 1, { kind: "circle", edge: arcs[0].edge, c: arcs[0].c, r: arcs[0].r });
    for (const a of arcs.slice(1)) out.splice(out.indexOf(a), 1);
  }
  return out;
}

/**
 * An edge between two pieces of one split face ("[f#1|f#2]"), like the seam
 * of a cylinder: smooth, not a real edge of the shape.
 */
function isSeam(name: string | undefined): boolean {
  const m = name?.match(/^\[(.*)\|(.*)\](#\d+)?$/);
  if (!m) return false;
  const base = (f: string) => f.replace(/#\d+$/, "");
  return base(m[1]) === base(m[2]);
}

/** Distance from `p` to a projected curve, in sketch units. */
export function distanceTo(c: Projected, p: P): number {
  switch (c.kind) {
    case "line": {
      const dx = c.b.x - c.a.x, dy = c.b.y - c.a.y;
      const t = Math.max(0, Math.min(1, ((p.x - c.a.x) * dx + (p.y - c.a.y) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(p.x - c.a.x - t * dx, p.y - c.a.y - t * dy);
    }
    case "circle":
      return Math.abs(dist(p, c.c) - c.r);
    case "arc": {
      const ang = (q: P) => Math.atan2(q.y - c.c.y, q.x - c.c.x);
      const sweep = (((ang(c.b) - ang(c.a)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const at = (((ang(p) - ang(c.a)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return at <= sweep ? Math.abs(dist(p, c.c) - c.r) : Math.min(dist(p, c.a), dist(p, c.b));
    }
    case "spline": {
      let best = Infinity;
      const pts = c.closed ? [...c.points, c.points[0]] : c.points;
      for (let i = 0; i + 1 < pts.length; i++) best = Math.min(best, distanceTo({ kind: "line", edge: "", a: pts[i], b: pts[i + 1] }, p));
      return best;
    }
  }
}

/**
 * Adds projected curves to the sketch as ordinary curves pinned in place
 * (fixed points; a fixed point on each circle holds its radius). Points that
 * land on an existing point are shared, so projected outlines stay joined.
 * Curves already in the sketch (the same line, circle or arc) are skipped.
 */
export function addProjected(s: SketchData, curves: Projected[]): { sketch: SketchData; ids: string[] } {
  const entities: SkEntity[] = [...s.entities];
  const constraints: SkConstraint[] = [...s.constraints];
  const fixed = new Set(constraints.filter((c) => c.kind === "fixed").map((c) => (c as { point: string }).point));
  const ids: string[] = [];
  const point = (p: P): string => {
    const hit = entities.find((e) => e.kind === "point" && Math.hypot(e.x - p.x, e.y - p.y) < 1e-6);
    const id = hit?.id ?? skId("p");
    if (!hit) entities.push({ id, kind: "point", x: p.x, y: p.y });
    if (!fixed.has(id)) {
      constraints.push({ id: skId("c"), kind: "fixed", point: id });
      fixed.add(id);
    }
    return id;
  };
  const at = (id: string) => entities.find((e) => e.id === id) as { x: number; y: number } | undefined;
  const same = (id: string, p: P) => {
    const q = at(id);
    return !!q && Math.hypot(q.x - p.x, q.y - p.y) < 1e-6;
  };
  const present = (c: Projected) =>
    entities.some((e) =>
      c.kind === "line"
        ? e.kind === "line" && ((same(e.p1, c.a) && same(e.p2, c.b)) || (same(e.p1, c.b) && same(e.p2, c.a)))
        : c.kind === "circle"
          ? e.kind === "circle" && same(e.center, c.c) && Math.abs(e.radius - c.r) < 1e-6
          : c.kind === "arc" && e.kind === "arc" && same(e.center, c.c) && same(e.start, c.a) && same(e.end, c.b),
    );
  for (const c of curves) {
    if (present(c)) continue;
    if (c.kind === "line") {
      const id = skId("l");
      entities.push({ id, kind: "line", p1: point(c.a), p2: point(c.b) });
      ids.push(id);
    } else if (c.kind === "circle") {
      const id = skId("k");
      entities.push({ id, kind: "circle", center: point(c.c), radius: c.r });
      const rim = point({ x: c.c.x + c.r, y: c.c.y });
      constraints.push({ id: skId("c"), kind: "pointOnCircle", point: rim, circle: id });
      ids.push(id);
    } else if (c.kind === "arc") {
      const id = skId("a");
      entities.push({ id, kind: "arc", center: point(c.c), start: point(c.a), end: point(c.b), radius: c.r });
      ids.push(id);
    } else {
      const id = skId("s");
      entities.push({ id, kind: "spline", points: c.points.map(point), closed: c.closed });
      ids.push(id);
    }
  }
  return { sketch: { entities, constraints }, ids };
}
