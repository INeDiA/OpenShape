// Sketch editing operations: trim a curve between its intersections, and
// offset curves by a distance. Pure functions returning a new sketch.

import type { NewConstraint, SkArc, SkCircle, SkConstraint, SkCurve, SkEntity, SkLine, SketchData } from "./model";
import { constraintRefs, curveEnds, curvePoints, entityMap, pointOf, removeEntities, skId } from "./model";
import { curvePolyline, type Pt } from "./curves";

const TWO_PI = Math.PI * 2;
const EPS = 1e-9;
const norm = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI;

// ---- intersections ------------------------------------------------------------

/** A curve as something to intersect: a segment, a (possibly partial) circle, or a polyline. */
type Geom =
  | { kind: "seg"; a: Pt; b: Pt }
  | { kind: "circ"; c: Pt; r: number; a0: number; span: number } // span = 2π for full circles
  | { kind: "poly"; pts: Pt[] };

function geomOf(m: Map<string, SkEntity>, c: SkCurve): Geom {
  if (c.kind === "line") {
    const a = pointOf(m, c.p1), b = pointOf(m, c.p2);
    return { kind: "seg", a: [a.x, a.y], b: [b.x, b.y] };
  }
  if (c.kind === "circle" || c.kind === "arc") {
    const ctr = pointOf(m, c.center);
    if (c.kind === "circle") return { kind: "circ", c: [ctr.x, ctr.y], r: c.radius, a0: 0, span: TWO_PI };
    const s0 = pointOf(m, c.start), s1 = pointOf(m, c.end);
    const a0 = Math.atan2(s0.y - ctr.y, s0.x - ctr.x);
    let span = Math.atan2(s1.y - ctr.y, s1.x - ctr.x) - a0;
    if (span <= 0) span += TWO_PI;
    return { kind: "circ", c: [ctr.x, ctr.y], r: Math.hypot(s0.x - ctr.x, s0.y - ctr.y), a0, span };
  }
  return { kind: "poly", pts: curvePolyline(m, c, 48) };
}

const onSeg = (g: { a: Pt; b: Pt }, p: Pt, tol = 1e-7) => {
  const dx = g.b[0] - g.a[0], dy = g.b[1] - g.a[1];
  const len2 = dx * dx + dy * dy || 1;
  const t = ((p[0] - g.a[0]) * dx + (p[1] - g.a[1]) * dy) / len2;
  return t >= -tol && t <= 1 + tol;
};
const onArc = (g: { c: Pt; a0: number; span: number }, p: Pt) => g.span >= TWO_PI - EPS || norm(Math.atan2(p[1] - g.c[1], p[0] - g.c[0]) - g.a0) <= g.span + 1e-7;

/** Intersections of the infinite line through a, b with a circle. */
function lineCircle(a: Pt, b: Pt, c: Pt, r: number): Pt[] {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const fx = a[0] - c[0], fy = a[1] - c[1];
  const A = dx * dx + dy * dy, B = 2 * (fx * dx + fy * dy), C = fx * fx + fy * fy - r * r;
  const disc = B * B - 4 * A * C;
  if (A < EPS || disc < -1e-9) return [];
  const sq = Math.sqrt(Math.max(0, disc));
  const ts = disc < 1e-12 ? [-B / (2 * A)] : [(-B - sq) / (2 * A), (-B + sq) / (2 * A)];
  return ts.map((t) => [a[0] + t * dx, a[1] + t * dy] as Pt);
}

function lineLine(a: Pt, b: Pt, c: Pt, d: Pt): Pt | null {
  const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < EPS * Math.hypot(...r) * Math.hypot(...s) + 1e-15) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}

function circleCircle(c1: Pt, r1: number, c2: Pt, r2: number): Pt[] {
  const d = Math.hypot(c2[0] - c1[0], c2[1] - c1[1]);
  if (d < EPS || d > r1 + r2 + 1e-9 || d < Math.abs(r1 - r2) - 1e-9) return [];
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, r1 * r1 - a * a));
  const ux = (c2[0] - c1[0]) / d, uy = (c2[1] - c1[1]) / d;
  const px = c1[0] + a * ux, py = c1[1] + a * uy;
  return h < 1e-9 ? [[px, py]] : [
    [px - h * uy, py + h * ux],
    [px + h * uy, py - h * ux],
  ];
}

/** Intersection points of two curves, each within its own extent. */
function intersect(g1: Geom, g2: Geom): Pt[] {
  if (g1.kind === "poly" || g2.kind === "poly") {
    const [p, o] = g1.kind === "poly" ? [g1, g2] : [g2 as Extract<Geom, { kind: "poly" }>, g1];
    const out: Pt[] = [];
    for (let i = 0; i + 1 < p.pts.length; i++) out.push(...intersect({ kind: "seg", a: p.pts[i], b: p.pts[i + 1] }, o));
    return out;
  }
  if (g1.kind === "seg" && g2.kind === "seg") {
    const p = lineLine(g1.a, g1.b, g2.a, g2.b);
    return p && onSeg(g1, p) && onSeg(g2, p) ? [p] : [];
  }
  if (g1.kind === "circ" && g2.kind === "circ") return circleCircle(g1.c, g1.r, g2.c, g2.r).filter((p) => onArc(g1, p) && onArc(g2, p));
  const [s, c] = g1.kind === "seg" ? [g1, g2 as Extract<Geom, { kind: "circ" }>] : [g2 as Extract<Geom, { kind: "seg" }>, g1];
  return lineCircle(s.a, s.b, c.c, c.r).filter((p) => onSeg(s, p) && onArc(c, p));
}

// ---- helpers --------------------------------------------------------------------

/** Adds geometry while reusing points that already sit at a location. */
class Builder {
  entities: SkEntity[];
  constraints: SkConstraint[];
  constructor(s: SketchData) {
    this.entities = [...s.entities];
    this.constraints = [...s.constraints];
  }
  get sketch(): SketchData {
    return { entities: this.entities, constraints: this.constraints };
  }
  pointAt(p: Pt, reuse = true): { id: string; fresh: boolean } {
    if (reuse) {
      for (const e of this.entities) if (e.kind === "point" && Math.hypot(e.x - p[0], e.y - p[1]) < 1e-6) return { id: e.id, fresh: false };
    }
    const id = skId("p");
    this.entities.push({ id, kind: "point", x: p[0], y: p[1] });
    return { id, fresh: true };
  }
  constrain(c: NewConstraint) {
    this.constraints.push({ ...c, id: skId("c") } as SkConstraint);
  }
  replace(e: SkEntity) {
    this.entities = this.entities.map((x) => (x.id === e.id ? e : x));
  }
  add(e: SkEntity) {
    this.entities.push(e);
  }
}

/** Keeps a new end point on the curve that cut it. */
function stickTo(b: Builder, point: string, cutter: SkCurve | undefined) {
  if (!cutter) return;
  if (cutter.kind === "line") b.constrain({ kind: "pointOnLine", point, line: cutter.id });
  else if (cutter.kind === "circle" || cutter.kind === "arc") b.constrain({ kind: "pointOnCircle", point, circle: cutter.id });
}

/** Removes points no curve uses anymore (and constraints on them). */
const tidy = (s: SketchData) => removeEntities(s, []);

// ---- trim -----------------------------------------------------------------------

export type TrimResult = { sketch: SketchData; removed: Pt[] } | { error: string };

/**
 * Removes the part of `curveId` around (x, y) that lies between its nearest
 * intersections with other curves (or its ends). A curve that nothing crosses
 * is deleted whole. New end points stay on the curve that cut them.
 */
export function trimCurve(s: SketchData, curveId: string, x: number, y: number): TrimResult {
  const m = entityMap(s);
  const target = m.get(curveId);
  if (!target || target.kind === "point") return { error: "Nothing to trim" };
  const g = geomOf(m, target);

  // Cuts along the target, each with the curve that made it.
  const cuts: { p: Pt; by: SkCurve }[] = [];
  const full: Geom = g.kind === "circ" ? { ...g, a0: 0, span: TWO_PI } : g;
  for (const e of s.entities) {
    if (e.kind === "point" || e.id === curveId) continue;
    for (const p of intersect(full, geomOf(m, e))) if (g.kind !== "circ" || onArc(g, p)) cuts.push({ p, by: e });
  }

  const deleteWhole = (): TrimResult => ({ sketch: removeEntities(s, [curveId]), removed: curvePolyline(m, target) });
  if (target.kind === "ellipse" || target.kind === "spline") {
    return cuts.length ? { error: "Trim works on lines, arcs and circles; delete the curve instead." } : deleteWhole();
  }

  const b = new Builder(s);
  // Equal radii still hold for a trimmed arc; equal lengths don't for a trimmed line.
  const drop = new Set(target.kind === "line" ? ["length", "midpoint", "equal"] : []);
  // Dimensions of the trimmed curve no longer describe it.
  const keepConstraint = (c: SkConstraint) => !(drop.has(c.kind) && (("line" in c && c.line === curveId) || ("a" in c && (c.a === curveId || c.b === curveId))));

  if (target.kind === "line") {
    const seg = g as Extract<Geom, { kind: "seg" }>;
    const dx = seg.b[0] - seg.a[0], dy = seg.b[1] - seg.a[1];
    const len2 = dx * dx + dy * dy || 1;
    const tOf = (p: Pt) => ((p[0] - seg.a[0]) * dx + (p[1] - seg.a[1]) * dy) / len2;
    const tc = tOf([x, y]);
    const inner = cuts.map((c) => ({ ...c, t: tOf(c.p) })).filter((c) => c.t > 1e-7 && c.t < 1 - 1e-7);
    const lo = inner.filter((c) => c.t < tc).sort((a, z) => z.t - a.t)[0];
    const hi = inner.filter((c) => c.t > tc).sort((a, z) => a.t - z.t)[0];
    if (!lo && !hi) return deleteWhole();
    const at = (t: number): Pt => [seg.a[0] + t * dx, seg.a[1] + t * dy];
    const removed = [at(lo?.t ?? 0), at(hi?.t ?? 1)];
    b.constraints = b.constraints.filter(keepConstraint);
    if (lo && hi) {
      const A = b.pointAt(lo.p), B = b.pointAt(hi.p);
      if (A.fresh) stickTo(b, A.id, lo.by);
      if (B.fresh) stickTo(b, B.id, hi.by);
      b.replace({ ...target, p2: A.id });
      const id = skId("l");
      b.add({ id, kind: "line", p1: B.id, p2: target.p2, construction: target.construction });
      // The two halves stay on one line.
      const hv = s.constraints.find((c) => (c.kind === "horizontal" || c.kind === "vertical") && c.line === curveId);
      if (hv) b.constrain({ kind: hv.kind as "horizontal", line: id });
      else b.constrain({ kind: "parallel", a: curveId, b: id });
      b.constrain({ kind: "pointOnLine", point: B.id, line: curveId });
    } else if (hi) {
      const B = b.pointAt(hi.p);
      if (B.fresh) stickTo(b, B.id, hi.by);
      b.replace({ ...target, p1: B.id });
    } else {
      const A = b.pointAt(lo!.p);
      if (A.fresh) stickTo(b, A.id, lo!.by);
      b.replace({ ...target, p2: A.id });
    }
    return { sketch: tidy(b.sketch), removed };
  }

  // Arcs and circles: work with angles counter-clockwise from the start (0 for circles).
  const circ = g as Extract<Geom, { kind: "circ" }>;
  const tOf = (p: Pt) => norm(Math.atan2(p[1] - circ.c[1], p[0] - circ.c[0]) - circ.a0);
  const tc = tOf([x, y]);
  const arcPts = (t0: number, t1: number): Pt[] =>
    Array.from({ length: 25 }, (_, i) => {
      const t = circ.a0 + t0 + ((t1 - t0) * i) / 24;
      return [circ.c[0] + circ.r * Math.cos(t), circ.c[1] + circ.r * Math.sin(t)] as Pt;
    });
  const ts = cuts.map((c) => ({ ...c, t: tOf(c.p) }));
  b.constraints = b.constraints.filter(keepConstraint);

  if (target.kind === "circle") {
    // Unique cut angles; a circle needs two to leave an arc.
    const uniq = ts.sort((a, z) => a.t - z.t).filter((c, i, all) => i === 0 || c.t - all[i - 1].t > 1e-7);
    if (uniq.length < 2) return deleteWhole();
    const hi = uniq.find((c) => c.t > tc) ?? uniq[0];
    const lo = [...uniq].reverse().find((c) => c.t < tc) ?? uniq[uniq.length - 1];
    const removed = arcPts(lo.t, hi.t > lo.t ? hi.t : hi.t + TWO_PI);
    // What remains runs counter-clockwise from the upper cut back to the lower one.
    const S = b.pointAt(hi.p), E = b.pointAt(lo.p);
    if (S.fresh) stickTo(b, S.id, hi.by);
    if (E.fresh) stickTo(b, E.id, lo.by);
    const c = target as SkCircle;
    b.replace({ id: c.id, kind: "arc", center: c.center, start: S.id, end: E.id, radius: c.radius, construction: c.construction } as SkArc);
    return { sketch: tidy(b.sketch), removed };
  }

  const arc = target as SkArc;
  const inner = ts.filter((c) => c.t > 1e-7 && c.t < circ.span - 1e-7);
  const lo = inner.filter((c) => c.t < tc).sort((a, z) => z.t - a.t)[0];
  const hi = inner.filter((c) => c.t > tc).sort((a, z) => a.t - z.t)[0];
  if (!lo && !hi) return deleteWhole();
  const removed = arcPts(lo?.t ?? 0, hi?.t ?? circ.span);
  if (lo && hi) {
    const A = b.pointAt(lo.p), B = b.pointAt(hi.p);
    if (A.fresh) stickTo(b, A.id, lo.by);
    if (B.fresh) stickTo(b, B.id, hi.by);
    b.replace({ ...arc, end: A.id });
    const id = skId("a");
    b.add({ id, kind: "arc", center: arc.center, start: B.id, end: arc.end, radius: arc.radius, construction: arc.construction });
    b.constrain({ kind: "equal", a: arc.id, b: id });
  } else if (hi) {
    const B = b.pointAt(hi.p);
    if (B.fresh) stickTo(b, B.id, hi.by);
    b.replace({ ...arc, start: B.id });
  } else {
    const A = b.pointAt(lo!.p);
    if (A.fresh) stickTo(b, A.id, lo!.by);
    b.replace({ ...arc, end: A.id });
  }
  return { sketch: tidy(b.sketch), removed };
}

// ---- offset -----------------------------------------------------------------------

export type OffsetResult = { sketch: SketchData; ids: string[] } | { error: string };

interface Step {
  curve: SkLine | SkArc;
  forward: boolean; // lines p1 -> p2, arcs start -> end (counter-clockwise)
}

/** Orders connected lines/arcs into chains, following shared end points. */
function chains(curves: (SkLine | SkArc)[]): { steps: Step[]; closed: boolean }[] {
  const ends = (c: SkLine | SkArc) => curveEnds(c)!;
  const byPoint = new Map<string, (SkLine | SkArc)[]>();
  for (const c of curves) for (const p of ends(c)) byPoint.set(p, [...(byPoint.get(p) ?? []), c]);
  const used = new Set<string>();
  const out: { steps: Step[]; closed: boolean }[] = [];
  const startOf = (c: SkLine | SkArc) => ends(c).find((p) => byPoint.get(p)!.length === 1);
  // Open chains first (start at a free end), then closed ones.
  const order = [...curves.filter((c) => startOf(c)), ...curves];
  for (const first of order) {
    if (used.has(first.id)) continue;
    let at = startOf(first) ?? ends(first)[0];
    const steps: Step[] = [];
    let cur: SkLine | SkArc | undefined = first;
    while (cur && !used.has(cur.id)) {
      used.add(cur.id);
      const [a, b] = ends(cur);
      const forward = a === at;
      steps.push({ curve: cur, forward });
      at = forward ? b : a;
      cur = byPoint.get(at)!.find((c) => !used.has(c.id));
    }
    const firstPt = steps[0].forward ? ends(steps[0].curve)[0] : ends(steps[0].curve)[1];
    out.push({ steps, closed: steps.length > 1 && at === firstPt });
  }
  return out;
}

/**
 * Offsets the selected curves by `distance`. Closed chains and circles grow
 * outward for positive values; open chains move to the left of their drawing
 * direction. Lines stay parallel to their source, arcs share its center.
 */
export function offsetCurves(s: SketchData, ids: Iterable<string>, distance: number): OffsetResult {
  if (Math.abs(distance) < 1e-9) return { error: "Offset distance must not be zero" };
  const m = entityMap(s);
  const selected = [...ids].map((id) => m.get(id)).filter((e): e is SkCurve => !!e && e.kind !== "point");
  if (!selected.length) return { error: "Select lines, arcs or circles to offset" };
  if (selected.some((c) => c.kind === "ellipse" || c.kind === "spline")) return { error: "Offset works on lines, arcs and circles" };
  const b = new Builder(s);
  const created: string[] = [];
  const P = (id: string): Pt => {
    const p = pointOf(m, id);
    return [p.x, p.y];
  };

  for (const c of selected) {
    if (c.kind !== "circle") continue;
    const r = c.radius + distance;
    if (r <= 1e-9) return { error: "The offset would shrink a circle to nothing" };
    const id = skId("k");
    b.add({ id, kind: "circle", center: c.center, radius: r });
    created.push(id);
  }

  for (const { steps, closed } of chains(selected.filter((c): c is SkLine | SkArc => c.kind === "line" || c.kind === "arc"))) {
    // Walk direction: from -> to of each step.
    const from = (st: Step) => (st.forward ? curveEnds(st.curve)![0] : curveEnds(st.curve)![1]);
    const to = (st: Step) => (st.forward ? curveEnds(st.curve)![1] : curveEnds(st.curve)![0]);
    let d = distance;
    if (closed) {
      // Signed area of the chain: counter-clockwise chains have the inside on their left.
      const poly = steps.flatMap((st) => {
        const pts = curvePolyline(m, st.curve, 12);
        return st.forward ? pts : [...pts].reverse();
      });
      let area = 0;
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i], [x2, y2] = poly[(i + 1) % poly.length];
        area += x1 * y2 - x2 * y1;
      }
      if (area > 0) d = -d;
    }
    // Offset each step to its left by d.
    type Off = { kind: "line"; a: Pt; b: Pt } | { kind: "arc"; c: Pt; r: number; a: Pt; b: Pt };
    const offs: Off[] = [];
    for (const st of steps) {
      const A = P(from(st)), B = P(to(st));
      if (st.curve.kind === "line") {
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
        const n: Pt = [-(B[1] - A[1]) / len, (B[0] - A[0]) / len];
        offs.push({ kind: "line", a: [A[0] + n[0] * d, A[1] + n[1] * d], b: [B[0] + n[0] * d, B[1] + n[1] * d] });
      } else {
        const C = P(st.curve.center);
        const r0 = Math.hypot(A[0] - C[0], A[1] - C[1]);
        // Left of a counter-clockwise walk is the center side.
        const r = st.forward ? r0 - d : r0 + d;
        if (r <= 1e-9) return { error: "The offset is larger than an arc's radius" };
        const scale = (p: Pt): Pt => [C[0] + ((p[0] - C[0]) * r) / r0, C[1] + ((p[1] - C[1]) * r) / r0];
        offs.push({ kind: "arc", c: C, r, a: scale(A), b: scale(B) });
      }
    }
    // Joints between consecutive offsets: where the extended curves meet, nearest the old corner.
    const joint = (x: Off, y: Off, corner: Pt): Pt => {
      if (Math.hypot(x.b[0] - y.a[0], x.b[1] - y.a[1]) < 1e-7) return x.b;
      let cands: Pt[] = [];
      if (x.kind === "line" && y.kind === "line") {
        const p = lineLine(x.a, x.b, y.a, y.b);
        cands = p ? [p] : [];
      } else if (x.kind === "arc" && y.kind === "arc") cands = circleCircle(x.c, x.r, y.c, y.r);
      else {
        const [l, a] = x.kind === "line" ? [x, y as Extract<Off, { kind: "arc" }>] : [y as Extract<Off, { kind: "line" }>, x as Extract<Off, { kind: "arc" }>];
        cands = lineCircle(l.a, l.b, a.c, a.r);
      }
      if (!cands.length) return [(x.b[0] + y.a[0]) / 2, (x.b[1] + y.a[1]) / 2];
      return cands.sort((p, q) => Math.hypot(p[0] - corner[0], p[1] - corner[1]) - Math.hypot(q[0] - corner[0], q[1] - corner[1]))[0];
    };
    const n = steps.length;
    const startPts: string[] = new Array(n);
    for (let i = 0; i < n; i++) {
      if (i === 0 && !closed) startPts[0] = b.pointAt(offs[0].a, false).id;
      else {
        const prev = (i - 1 + n) % n;
        startPts[i] = b.pointAt(joint(offs[prev], offs[i], P(from(steps[i]))), false).id;
      }
    }
    for (let i = 0; i < n; i++) {
      const st = steps[i];
      const sa = startPts[i];
      const sb = i + 1 < n ? startPts[i + 1] : closed ? startPts[0] : b.pointAt(offs[i].b, false).id;
      if (st.curve.kind === "line") {
        const id = skId("l");
        b.add({ id, kind: "line", p1: st.forward ? sa : sb, p2: st.forward ? sb : sa });
        b.constrain({ kind: "parallel", a: st.curve.id, b: id });
        created.push(id);
      } else {
        const o = offs[i] as Extract<Off, { kind: "arc" }>;
        const id = skId("a");
        b.add({ id, kind: "arc", center: st.curve.center, start: st.forward ? sa : sb, end: st.forward ? sb : sa, radius: o.r });
        created.push(id);
      }
    }
  }
  return { sketch: b.sketch, ids: created };
}

/**
 * Copies of the curves `ids`, `count - 1` of them, the k-th with every point
 * moved by `place(x, y, k)`. Points the curves share stay shared within each
 * copy. Copies are free geometry: the originals' constraints aren't repeated.
 */
export function patternCurves(s: SketchData, ids: Iterable<string>, count: number, place: (x: number, y: number, k: number) => Pt): { sketch: SketchData; ids: string[] } {
  const m = entityMap(s);
  const curves = [...ids].map((id) => m.get(id)).filter((e): e is SkCurve => !!e && e.kind !== "point");
  const entities: SkEntity[] = [...s.entities];
  const added: string[] = [];
  for (let k = 1; k < Math.round(count); k++) {
    const copyOf = new Map<string, string>();
    const pt = (id: string) => {
      let to = copyOf.get(id);
      if (!to) {
        const p = pointOf(m, id);
        const [x, y] = place(p.x, p.y, k);
        to = skId("p");
        entities.push({ id: to, kind: "point", x, y });
        copyOf.set(id, to);
      }
      return to;
    };
    for (const c of curves) {
      const id = skId({ line: "l", circle: "k", arc: "a", ellipse: "e", spline: "s" }[c.kind]);
      let copy: SkCurve;
      switch (c.kind) {
        case "line":
          copy = { ...c, id, p1: pt(c.p1), p2: pt(c.p2) };
          break;
        case "circle":
          copy = { ...c, id, center: pt(c.center) };
          break;
        case "arc":
          copy = { ...c, id, center: pt(c.center), start: pt(c.start), end: pt(c.end) };
          break;
        case "ellipse":
          copy = { ...c, id, center: pt(c.center), major: pt(c.major), minor: pt(c.minor) };
          break;
        case "spline":
          copy = { ...c, id, points: c.points.map(pt) };
          break;
      }
      entities.push(copy);
      added.push(id);
    }
  }
  return { sketch: { ...s, entities }, ids: added };
}

/** Moves for a linear pattern: `dx`, `dy` between copies. */
export const linearPlace = (dx: number, dy: number) => (x: number, y: number, k: number): Pt => [x + dx * k, y + dy * k];

/** Moves for a circular pattern of `count` copies over `angle` degrees about (cx, cy); a full turn spaces them evenly. */
export function circularPlace(cx: number, cy: number, count: number, angle = 360) {
  const step = (Math.abs(angle) >= 360 ? 360 / count : angle / Math.max(1, count - 1)) * (Math.PI / 180);
  return (x: number, y: number, k: number): Pt => {
    const c = Math.cos(step * k), s = Math.sin(step * k);
    return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c];
  };
}

// ---- corner fillet ----------------------------------------------------------

/** Direction a line (p1 → p2) or arc (counter-clockwise) runs at one of its points. */
function runDir(m: Map<string, SkEntity>, c: SkLine | SkArc, at: { x: number; y: number }): Pt {
  if (c.kind === "line") {
    const a = pointOf(m, c.p1), b = pointOf(m, c.p2);
    return [b.x - a.x, b.y - a.y];
  }
  const ctr = pointOf(m, c.center);
  return [-(at.y - ctr.y), at.x - ctr.x];
}

/** The tangency constraint between a line or arc and an arc meeting at `point`. */
function tangentAtPoint(m: Map<string, SkEntity>, a: SkLine | SkArc, b: SkArc, point: string): NewConstraint {
  const p = pointOf(m, point);
  const da = runDir(m, a, p), db = runDir(m, b, p);
  return { kind: "tangentAt", a: a.id, b: b.id, point, reversed: da[0] * db[0] + da[1] * db[1] < 0 };
}

export type FilletResult = { sketch: SketchData; ids: string[]; dropped: number } | { error: string };

/**
 * Rounds the corner where two lines meet at `pointId` with an arc of radius
 * `r` tangent to both. The lines are shortened to where the arc starts; the
 * arc gets a radius dimension. Constraints on the corner point (and lengths
 * of the two lines, which no longer reach the corner) are dropped.
 */
export function filletCorner(s: SketchData, pointId: string, r: number): FilletResult {
  const m = entityMap(s);
  const at = (l: SkLine) => l.p1 === pointId || l.p2 === pointId;
  const lines = s.entities.filter((e): e is SkLine => e.kind === "line" && !e.construction && at(e));
  const others = s.entities.filter((e) => e.kind !== "point" && e.kind !== "line" && !e.construction && curvePoints(e).includes(pointId));
  if (lines.length !== 2 || others.length) return { error: "Fillet: click a corner where exactly two lines meet." };
  if (!(r > 0)) return { error: "The fillet radius must be positive." };
  const P = pointOf(m, pointId);
  const far = lines.map((l) => pointOf(m, l.p1 === pointId ? l.p2 : l.p1));
  const len = far.map((q) => Math.hypot(q.x - P.x, q.y - P.y));
  if (Math.min(...len) < EPS) return { error: "One of the lines has no length." };
  const u = far.map((q, i) => [(q.x - P.x) / len[i], (q.y - P.y) / len[i]] as Pt);
  const theta = Math.acos(Math.max(-1, Math.min(1, u[0][0] * u[1][0] + u[0][1] * u[1][1])));
  if (theta < 1e-3 || Math.PI - theta < 1e-3) return { error: "The lines are in line: there is no corner to round." };
  const t = r / Math.tan(theta / 2);
  if (t >= Math.min(...len) - 1e-9) {
    const max = Math.min(...len) * Math.tan(theta / 2);
    return { error: `Radius too big for these lines (at most ${Math.floor(max * 100) / 100}).` };
  }
  const T = u.map(([ux, uy]) => ({ id: skId("p"), kind: "point" as const, x: P.x + ux * t, y: P.y + uy * t }));
  const bl = Math.hypot(u[0][0] + u[1][0], u[0][1] + u[1][1]);
  const k = r / Math.sin(theta / 2) / bl;
  const C = { id: skId("p"), kind: "point" as const, x: P.x + (u[0][0] + u[1][0]) * k, y: P.y + (u[0][1] + u[1][1]) * k };
  const ccw = (T[0].x - C.x) * (T[1].y - C.y) - (T[0].y - C.y) * (T[1].x - C.x) > 0;
  const arc: SkArc = { id: skId("a"), kind: "arc", center: C.id, start: ccw ? T[0].id : T[1].id, end: ccw ? T[1].id : T[0].id, radius: r };
  const moved = new Map(lines.map((l, i) => [l.id, { ...l, p1: l.p1 === pointId ? T[i].id : l.p1, p2: l.p2 === pointId ? T[i].id : l.p2 }]));
  // The corner point goes unless something else (a construction line) still uses it.
  const keep = s.entities.some((e) => e.kind !== "point" && !moved.has(e.id) && curvePoints(e).includes(pointId));
  const entities: SkEntity[] = [...s.entities.filter((e) => keep || e.id !== pointId).map((e) => moved.get(e.id) ?? e), ...T, C, arc];
  const m2 = new Map(entities.map((e) => [e.id, e]));
  const kept = s.constraints.filter((c) => {
    if (c.kind === "length" && moved.has(c.line)) return false;
    return keep || !constraintRefs(c).includes(pointId);
  });
  const added = [
    ...lines.map((_, i) => tangentAtPoint(m2, moved.get(lines[i].id)!, arc, T[i].id)),
    { kind: "radius", circle: arc.id, value: r } as NewConstraint,
  ].map((c) => ({ ...c, id: skId("c") }) as SkConstraint);
  return { sketch: { entities, constraints: [...kept, ...added] }, ids: [arc.id], dropped: s.constraints.length - kept.length };
}

// ---- slot -------------------------------------------------------------------

/**
 * Straight slot around the segment from `a` to `b` (its two arc centres),
 * `r` wide on each side: two half circles joined by two lines, tangent where
 * they meet, with equal radii. A construction line joins the centres.
 */
export function addSlot(s: SketchData, a: Pt, b: Pt, r: number): { sketch: SketchData; ids: string[] } | null {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len < EPS || !(r > EPS)) return null;
  const nx = -(b[1] - a[1]) / len, ny = (b[0] - a[0]) / len; // left of a → b
  const pt = (x: number, y: number) => ({ id: skId("p"), kind: "point" as const, x, y });
  const A = pt(a[0], a[1]), B = pt(b[0], b[1]);
  const aL = pt(a[0] + nx * r, a[1] + ny * r), aR = pt(a[0] - nx * r, a[1] - ny * r);
  const bL = pt(b[0] + nx * r, b[1] + ny * r), bR = pt(b[0] - nx * r, b[1] - ny * r);
  const right: SkLine = { id: skId("l"), kind: "line", p1: aR.id, p2: bR.id };
  const left: SkLine = { id: skId("l"), kind: "line", p1: bL.id, p2: aL.id };
  const capB: SkArc = { id: skId("a"), kind: "arc", center: B.id, start: bR.id, end: bL.id, radius: r };
  const capA: SkArc = { id: skId("a"), kind: "arc", center: A.id, start: aL.id, end: aR.id, radius: r };
  const axis: SkLine = { id: skId("l"), kind: "line", p1: A.id, p2: B.id, construction: true };
  const entities: SkEntity[] = [...s.entities, A, B, aL, aR, bL, bR, right, left, capB, capA, axis];
  const m = new Map(entities.map((e) => [e.id, e]));
  const cs: NewConstraint[] = [
    tangentAtPoint(m, right, capB, bR.id),
    tangentAtPoint(m, left, capB, bL.id),
    tangentAtPoint(m, left, capA, aL.id),
    tangentAtPoint(m, right, capA, aR.id),
    { kind: "equal", a: capA.id, b: capB.id },
  ];
  return {
    sketch: { entities, constraints: [...s.constraints, ...cs.map((c) => ({ ...c, id: skId("c") }) as SkConstraint)] },
    ids: [right.id, capB.id, left.id, capA.id],
  };
}
