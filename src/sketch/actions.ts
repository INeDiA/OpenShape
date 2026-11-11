// Which constraints can be applied to the current selection.

import type { DimensionConstraint, DistributiveOmit, NewConstraint, SketchData } from "./model";
import { entityMap, measure } from "./model";

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
}

export function classify(s: SketchData, ids: Iterable<string>): Selected {
  const m = entityMap(s);
  const out: Selected = { points: [], lines: [], circles: [] };
  for (const id of ids) {
    const e = m.get(id);
    if (e?.kind === "point") out.points.push(id);
    if (e?.kind === "line") out.lines.push(id);
    // Arcs behave like circles for constraints (radius, equal, tangent, point on).
    if (e?.kind === "circle" || e?.kind === "arc") out.circles.push(id);
  }
  return out;
}

const pairs = (ids: string[]) => ids.slice(1).map((b, i) => [ids[i], b] as const);

export function constraintActions(s: SketchData, selection: Iterable<string>): ConstraintAction[] {
  const { points: P, lines: L, circles: C } = classify(s, selection);
  const only = (p: number, l: number, c: number) => P.length === p && L.length === l && C.length === c;
  const acts: ConstraintAction[] = [];

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
  if (P.length >= 1 && L.length === 0 && C.length === 0) acts.push({ key: "fixed", label: "Fix", glyph: "⚓", shortcut: "f", build: () => P.map((point) => ({ kind: "fixed", point })) });

  return acts;
}

/** The dimension implied by the selection (with its current measured value), if any. */
export function dimensionFor(s: SketchData, selection: Iterable<string>): NewConstraint | null {
  const { points: P, lines: L, circles: C } = classify(s, selection);
  let d: DistributiveOmit<DimensionConstraint, "id" | "value"> | null = null;
  if (P.length === 2 && L.length === 0 && C.length === 0) d = { kind: "distance", a: P[0], b: P[1] };
  else if (L.length === 1 && P.length === 0 && C.length === 0) d = { kind: "length", line: L[0] };
  else if (C.length === 1 && P.length === 0 && L.length === 0) d = { kind: "radius", circle: C[0] };
  else if (L.length === 2 && P.length === 0 && C.length === 0) d = { kind: "angle", a: L[0], b: L[1] };
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
};
