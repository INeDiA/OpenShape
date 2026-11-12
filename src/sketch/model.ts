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

/**
 * Ellipse given by its center and one end of each axis. The axis points are
 * ordinary sketch points, so distance dimensions set the radii.
 */
export interface SkEllipse {
  id: string;
  kind: "ellipse";
  center: string;
  /** End of the major axis (sets the size and the rotation). */
  major: string;
  /** End of the minor axis (kept perpendicular to the major one by the solver). */
  minor: string;
  construction?: boolean;
}

/** Smooth curve through its points (Catmull-Rom, drawn as cubic Béziers). */
export interface SkSpline {
  id: string;
  kind: "spline";
  points: string[];
  closed?: boolean;
  construction?: boolean;
}

export type SkCurve = SkLine | SkCircle | SkArc | SkEllipse | SkSpline;
export type SkEntity = SkPoint | SkCurve;

export type SkConstraint =
  | { id: string; kind: "coincident"; a: string; b: string }
  | { id: string; kind: "fixed"; point: string }
  | { id: string; kind: "horizontal" | "vertical"; line: string }
  | { id: string; kind: "parallel" | "perpendicular"; a: string; b: string }
  | { id: string; kind: "equal"; a: string; b: string } // two lines or two circles
  | { id: string; kind: "pointOnLine"; point: string; line: string }
  | { id: string; kind: "pointOnCircle"; point: string; circle: string }
  // `line` may also be an arc: then the two arcs are tangent.
  | { id: string; kind: "tangent"; line: string; circle: string }
  | { id: string; kind: "midpoint"; point: string; line: string }
  // Curves `a` and `b` (lines or arcs) meet at `point` with the same direction; `reversed` when their parametric directions are opposite.
  | { id: string; kind: "tangentAt"; a: string; b: string; point: string; reversed: boolean }
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
    case "tangentAt":
      return [c.a, c.b, c.point];
    case "radius":
      return [c.circle];
  }
}

/** Points owned by a curve. */
export function curvePoints(e: SkCurve): string[] {
  switch (e.kind) {
    case "line":
      return [e.p1, e.p2];
    case "arc":
      return [e.center, e.start, e.end];
    case "circle":
      return [e.center];
    case "ellipse":
      return [e.center, e.major, e.minor];
    case "spline":
      return [...e.points];
  }
}

/** End points of open curves (lines, arcs, open splines); closed curves have none. */
export function curveEnds(e: SkCurve): [string, string] | null {
  if (e.kind === "line") return [e.p1, e.p2];
  if (e.kind === "arc") return [e.start, e.end];
  if (e.kind === "spline" && !e.closed) return [e.points[0], e.points[e.points.length - 1]];
  return null;
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

/** Lines of a sketch with readable names ("Line 2", "Construction 1"), for choosing an axis. */
export function sketchLines(s: SketchData): { id: string; label: string; construction: boolean }[] {
  let n = 0, c = 0;
  return s.entities
    .filter((e): e is SkLine => e.kind === "line")
    .map((l) => ({ id: l.id, construction: !!l.construction, label: l.construction ? `Construction ${++c}` : `Line ${++n}` }));
}

/**
 * The line a revolve should turn around by default: a construction line if
 * there is one (that's what they're for), else the longest line.
 */
export function defaultAxisLine(s: SketchData): string | undefined {
  const m = entityMap(s);
  const lines = s.entities.filter((e): e is SkLine => e.kind === "line");
  const len = (l: SkLine) => {
    const a = pointOf(m, l.p1), b = pointOf(m, l.p2);
    return Math.hypot(b.x - a.x, b.y - a.y);
  };
  const pick = (ls: SkLine[]) => ls.sort((a, b) => len(b) - len(a))[0]?.id;
  return pick(lines.filter((l) => l.construction)) ?? pick(lines);
}

let seq = 0;
export const skId = (prefix: string) => `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}`;
