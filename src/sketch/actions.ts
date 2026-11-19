// Which constraints can be applied to the current selection.

import type { DimensionConstraint, DistributiveOmit, NewConstraint, SkArc, SkCircle, SkEllipse, SkLine, SketchData } from "./model";
import { entityMap, measure, pointOf } from "./model";

export interface ConstraintAction {
  key: string;
  label: string;
  glyph: string;
  shortcut?: string;
  build: () => NewConstraint[];
}

interface Selected {
  points: string[];
  lines: string[];
  circles: string[];
  ellipses: string[];
}

export function classify(s: SketchData, ids: Iterable<string>): Selected {
  const m = entityMap(s);
  const out: Selected = { points: [], lines: [], circles: [], ellipses: [] };
  for (const id of ids) {
    const e = m.get(id);
    if (e?.kind === "point") out.points.push(id);
    if (e?.kind === "line") out.lines.push(id);
    // Arcs behave like circles for constraints (radius, equal, tangent, point on).
    if (e?.kind === "circle" || e?.kind === "arc") out.circles.push(id);
    if (e?.kind === "ellipse") out.ellipses.push(id);
  }
  return out;
}

const pairs = (ids: string[]) => ids.slice(1).map((b, i) => [ids[i], b] as const);

export function constraintActions(s: SketchData, selection: Iterable<string>): ConstraintAction[] {
  const { points: P, lines: L, circles: C, ellipses: E } = classify(s, selection);
  const only = (p: number, l: number, c: number) => P.length === p && L.length === l && C.length === c && E.length === 0;
  const acts: ConstraintAction[] = [];
  const m = entityMap(s);
  const centre = (id: string) => (m.get(id) as SkCircle | SkArc | SkEllipse).center;

  if (only(2, 0, 0)) acts.push({ key: "coincident", label: "Coincident", glyph: "●", build: () => [{ kind: "coincident", a: P[0], b: P[1] }] });
  if (L.length >= 1 && P.length === 0 && C.length === 0) {
    acts.push({ key: "horizontal", label: "Horizontal", glyph: "H", shortcut: "h", build: () => L.map((line) => ({ kind: "horizontal", line })) });
    acts.push({ key: "vertical", label: "Vertical", glyph: "V", shortcut: "v", build: () => L.map((line) => ({ kind: "vertical", line })) });
  }
  if (only(0, 2, 0)) {
    acts.push({ key: "parallel", label: "Parallel", glyph: "∥", build: () => [{ kind: "parallel", a: L[0], b: L[1] }] });
    acts.push({ key: "perpendicular", label: "Perpendicular", glyph: "⊥", build: () => [{ kind: "perpendicular", a: L[0], b: L[1] }] });
  }
  if (L.length >= 2 && P.length === 0 && C.length === 0)
    acts.push({ key: "equal", label: "Equal", glyph: "=", shortcut: "e", build: () => pairs(L).map(([a, b]) => ({ kind: "equal", a, b })) });
  if (C.length >= 2 && P.length === 0 && L.length === 0)
    acts.push({ key: "equal", label: "Equal", glyph: "=", shortcut: "e", build: () => pairs(C).map(([a, b]) => ({ kind: "equal", a, b })) });
  if (only(0, 1, 1)) acts.push({ key: "tangent", label: "Tangent", glyph: "T", shortcut: "t", build: () => [{ kind: "tangent", line: L[0], circle: C[0] }] });
  if (only(1, 1, 0)) {
    acts.push({ key: "pointOnLine", label: "On line", glyph: "⋯", build: () => [{ kind: "pointOnLine", point: P[0], line: L[0] }] });
    acts.push({ key: "midpoint", label: "Midpoint", glyph: "M", build: () => [{ kind: "midpoint", point: P[0], line: L[0] }] });
  }
  if (only(1, 0, 1)) acts.push({ key: "pointOnCircle", label: "On curve", glyph: "◌", build: () => [{ kind: "pointOnCircle", point: P[0], circle: C[0] }] });
  // Concentric: circles, arcs and ellipses share their centre.
  if (C.length + E.length >= 2 && P.length === 0 && L.length === 0) {
    const round = [...C, ...E];
    acts.push({ key: "concentric", label: "Concentric", glyph: "◎", build: () => round.slice(1).map((id) => ({ kind: "coincident", a: centre(round[0]), b: centre(id) })) });
  }
  // Symmetric about the line picked last: two points, two lines (their ends) or two circles (centres, equal radii).
  const axis = L[L.length - 1];
  if (only(2, 1, 0)) acts.push({ key: "symmetric", label: "Symmetric", glyph: "⇋", build: () => [{ kind: "symmetric", a: P[0], b: P[1], line: axis }] });
  if (only(0, 3, 0))
    acts.push({
      key: "symmetric",
      label: "Symmetric",
      glyph: "⇋",
      build: () => {
        const a = m.get(L[0]) as SkLine, b = m.get(L[1]) as SkLine;
        const pairs = mirrorPairs(s, [a.p1, a.p2], [b.p1, b.p2], m.get(axis) as SkLine);
        return pairs.map(([x, y]) => ({ kind: "symmetric", a: x, b: y, line: axis }));
      },
    });
  if (P.length === 0 && L.length === 1 && C.length === 2 && E.length === 0)
    acts.push({
      key: "symmetric",
      label: "Symmetric",
      glyph: "⇋",
      build: () => [
        { kind: "symmetric", a: centre(C[0]), b: centre(C[1]), line: axis },
        { kind: "equal", a: C[0], b: C[1] },
      ],
    });
  if (P.length >= 1 && L.length === 0 && C.length === 0 && E.length === 0) acts.push({ key: "fixed", label: "Fix", glyph: "⚓", shortcut: "f", build: () => P.map((point) => ({ kind: "fixed", point })) });

  return acts;
}

/** Pairs the ends of two lines so each end faces its mirror image (the closest after reflecting across `axis`). */
function mirrorPairs(s: SketchData, a: [string, string], b: [string, string], axis: SkLine): [string, string][] {
  const p = (id: string) => pointOf(s, id);
  const o = p(axis.p1), e = p(axis.p2);
  const len = Math.hypot(e.x - o.x, e.y - o.y) || 1;
  const ux = (e.x - o.x) / len, uy = (e.y - o.y) / len;
  const mirror = (id: string) => {
    const q = p(id);
    const t = (q.x - o.x) * ux + (q.y - o.y) * uy;
    const fx = o.x + ux * t, fy = o.y + uy * t;
    return { x: 2 * fx - q.x, y: 2 * fy - q.y };
  };
  const d = (id: string, q: { x: number; y: number }) => Math.hypot(p(id).x - q.x, p(id).y - q.y);
  const straight = d(b[0], mirror(a[0])) + d(b[1], mirror(a[1]));
  const crossed = d(b[1], mirror(a[0])) + d(b[0], mirror(a[1]));
  return straight <= crossed ? [[a[0], b[0]], [a[1], b[1]]] : [[a[0], b[1]], [a[1], b[0]]];
}

/** The dimension implied by the selection (with its current measured value), if any. */
export function dimensionFor(s: SketchData, selection: Iterable<string>): NewConstraint | null {
  const { points: P, lines: L, circles: C, ellipses: E } = classify(s, selection);
  const m = entityMap(s);
  let d: DistributiveOmit<DimensionConstraint, "id" | "value"> | null = null;
  const none = (...xs: string[][]) => xs.every((x) => x.length === 0);
  if (P.length === 2 && none(L, C, E)) d = { kind: "distance", a: P[0], b: P[1] };
  else if (L.length === 1 && none(P, C, E)) d = { kind: "length", line: L[0] };
  else if (C.length === 1 && none(P, L, E)) d = { kind: "radius", circle: C[0] };
  else if (P.length === 1 && L.length === 1 && none(C, E)) d = { kind: "pointLine", point: P[0], line: L[0] };
  else if (L.length === 2 && none(P, C, E)) {
    // Parallel lines: the distance between them; otherwise the angle.
    const a = m.get(L[0]) as SkLine;
    const deg = measure(s, { kind: "angle", a: L[0], b: L[1] }) % 180;
    d = Math.min(deg, 180 - deg) < 0.5 ? { kind: "pointLine", point: a.p1, line: L[1] } : { kind: "angle", a: L[0], b: L[1] };
  } else if (E.length === 1 && none(P, L, C)) {
    // An ellipse: its major semi-axis, then the minor one once the major is set.
    const e = m.get(E[0]) as SkEllipse;
    const has = (q: string) => s.constraints.some((c) => c.kind === "distance" && ((c.a === e.center && c.b === q) || (c.b === e.center && c.a === q)));
    d = { kind: "distance", a: e.center, b: has(e.major) ? e.minor : e.major };
    if (has(e.major) && has(e.minor)) return null;
  }
  if (!d) return null;
  const value = Math.round(measure(s, d) * 100) / 100;
  return { ...d, value } as NewConstraint;
}

export const CONSTRAINT_GLYPH: Record<string, string> = {
  coincident: "●",
  fixed: "⚓",
  horizontal: "H",
  vertical: "V",
  parallel: "∥",
  perpendicular: "⊥",
  equal: "=",
  tangent: "T",
  tangentAt: "T",
  pointOnLine: "⋯",
  pointOnCircle: "◌",
  midpoint: "M",
  symmetric: "⇋",
};
