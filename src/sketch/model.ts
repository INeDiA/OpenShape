// Constraint-based 2D sketch model. Coordinates are in the sketch plane's local
// frame (mm). Entities reference points by id; lines sharing a point id are joined.

export interface SkPoint {
  id: string;
  kind: "point";
  x: number;
  y: number;
}

export interface SkLine {
  id: string;
  kind: "line";
  p1: string;
  p2: string;
  construction?: boolean;
}

export interface SkCircle {
  id: string;
  kind: "circle";
  center: string;
  radius: number;
  construction?: boolean;
}

/** Circular arc from `start` to `end`, counter-clockwise around `center`. */
export interface SkArc {
  id: string;
  kind: "arc";
  center: string;
  start: string;
  end: string;
  radius: number;
  construction?: boolean;
}

export type SkCurve = SkLine | SkCircle | SkArc;
export type SkEntity = SkPoint | SkCurve;

export type SkConstraint =
  | { id: string; kind: "coincident"; a: string; b: string }
  | { id: string; kind: "fixed"; point: string }
  | { id: string; kind: "horizontal" | "vertical"; line: string }
  | { id: string; kind: "parallel" | "perpendicular"; a: string; b: string }
  | { id: string; kind: "equal"; a: string; b: string } // two lines or two circles
  | { id: string; kind: "pointOnLine"; point: string; line: string }
  | { id: string; kind: "pointOnCircle"; point: string; circle: string }
  | { id: string; kind: "tangent"; line: string; circle: string }
  | { id: string; kind: "midpoint"; point: string; line: string }
  | { id: string; kind: "distance"; a: string; b: string; value: number; expr?: string } // point-point
  | { id: string; kind: "length"; line: string; value: number; expr?: string }
  | { id: string; kind: "radius"; circle: string; value: number; expr?: string }
  | { id: string; kind: "angle"; a: string; b: string; value: number; expr?: string }; // degrees, line-line

export type ConstraintKind = SkConstraint["kind"];
/** Omit that distributes over union members (plain Omit collapses them). */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type NewConstraint = DistributiveOmit<SkConstraint, "id">;
export type DimensionConstraint = Extract<SkConstraint, { value: number }>;

export interface SketchData {
  entities: SkEntity[];
  constraints: SkConstraint[];
}

export const emptySketch = (): SketchData => ({ entities: [], constraints: [] });

export function isDimension(c: SkConstraint): c is DimensionConstraint {
  return "value" in c;
}

// ---- lookup helpers --------------------------------------------------------

export function entityMap(s: SketchData) {
  return new Map(s.entities.map((e) => [e.id, e]));
}

export function pointOf(s: SketchData | Map<string, SkEntity>, id: string): SkPoint {
  const m = s instanceof Map ? s : entityMap(s);
  const p = m.get(id);
  if (!p || p.kind !== "point") throw new Error(`Point ${id} not found`);
  return p;
}

/** Ids referenced by a constraint (entities, not values). */
export function constraintRefs(c: SkConstraint): string[] {
  switch (c.kind) {
    case "coincident":
    case "parallel":
    case "perpendicular":
    case "equal":
    case "distance":
    case "angle":
      return [c.a, c.b];
    case "fixed":
      return [c.point];
    case "horizontal":
    case "vertical":
    case "length":
      return [c.line];
    case "pointOnLine":
    case "midpoint":
      return [c.point, c.line];
    case "pointOnCircle":
      return [c.point, c.circle];
    case "tangent":
      return [c.line, c.circle];
    case "radius":
      return [c.circle];
  }
}

/** Points owned by a curve. */
export function curvePoints(e: SkCurve): string[] {
  return e.kind === "line" ? [e.p1, e.p2] : e.kind === "arc" ? [e.center, e.start, e.end] : [e.center];
}

/** End points of open curves (lines, arcs); circles have none. */
export function curveEnds(e: SkCurve): [string, string] | null {
  return e.kind === "line" ? [e.p1, e.p2] : e.kind === "arc" ? [e.start, e.end] : null;
}

/**
 * Removes entities and everything that depends on them: curves using removed
 * points, constraints referencing removed ids, and points no curve uses anymore.
 */
export function removeEntities(s: SketchData, ids: Iterable<string>): SketchData {
  const removed = new Set(ids);
  // Removing a point removes the curves built on it.
  for (const e of s.entities) {
    if (e.kind !== "point" && curvePoints(e).some((p) => removed.has(p))) removed.add(e.id);
  }
  const curves = s.entities.filter((e): e is SkCurve => e.kind !== "point" && !removed.has(e.id));
  const usedPoints = new Set(curves.flatMap(curvePoints));
  const entities = s.entities.filter((e) => !removed.has(e.id) && (e.kind !== "point" || usedPoints.has(e.id)));
  const alive = new Set(entities.map((e) => e.id));
  const constraints = s.constraints.filter((c) => constraintRefs(c).every((r) => alive.has(r)));
  return { entities, constraints };
}

export function removeConstraints(s: SketchData, ids: Iterable<string>): SketchData {
  const removed = new Set(ids);
  return { ...s, constraints: s.constraints.filter((c) => !removed.has(c.id)) };
}

/** Current geometric value of a dimension, used as default when creating one. */
export function measure(s: SketchData, c: DistributiveOmit<DimensionConstraint, "id" | "value">): number {
  const m = entityMap(s);
  const pt = (id: string) => pointOf(m, id);
  const line = (id: string) => m.get(id) as SkLine;
  switch (c.kind) {
    case "distance": {
      const a = pt(c.a), b = pt(c.b);
      return Math.hypot(b.x - a.x, b.y - a.y);
    }
    case "length": {
      const l = line(c.line);
      const a = pt(l.p1), b = pt(l.p2);
      return Math.hypot(b.x - a.x, b.y - a.y);
    }
    case "radius":
      return (m.get(c.circle) as SkCircle).radius;
    case "angle": {
      const dir = (l: SkLine) => {
        const a = pt(l.p1), b = pt(l.p2);
        return Math.atan2(b.y - a.y, b.x - a.x);
      };
      let deg = ((dir(line(c.b)) - dir(line(c.a))) * 180) / Math.PI;
      deg = ((deg % 360) + 360) % 360;
      return deg;
    }
  }
}

let seq = 0;
export const skId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;
