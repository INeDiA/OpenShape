// Helpers that add geometry (plus the implied constraints) to a sketch.
// All functions are pure: they return a new SketchData.

import type { NewConstraint, SkConstraint, SkEntity, SketchData } from "./model";
import { skId } from "./model";

export interface Added {
  sketch: SketchData;
  ids: string[];
}

function push(s: SketchData, entities: SkEntity[], constraints: SkConstraint[] = []): SketchData {
  return { entities: [...s.entities, ...entities], constraints: [...s.constraints, ...constraints] };
}

export function addPoint(s: SketchData, x: number, y: number): Added {
  const id = skId("p");
  return { sketch: push(s, [{ id, kind: "point", x, y }]), ids: [id] };
}

/** Adds a line between existing point ids. */
export function addLineBetween(s: SketchData, p1: string, p2: string, construction = false): Added {
  const id = skId("l");
  return { sketch: push(s, [{ id, kind: "line", p1, p2, construction }]), ids: [id] };
}

/** Axis-aligned rectangle: 4 shared corners, 4 lines, horizontal/vertical constraints. */
export function addRectangle(s: SketchData, x0: number, y0: number, x1: number, y1: number): Added {
  const corners = [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ].map(([x, y]) => ({ id: skId("p"), kind: "point" as const, x, y }));
  const lines = corners.map((c, i) => ({
    id: skId("l"),
    kind: "line" as const,
    p1: c.id,
    p2: corners[(i + 1) % 4].id,
  }));
  const constraints: SkConstraint[] = [
    { id: skId("c"), kind: "horizontal", line: lines[0].id },
    { id: skId("c"), kind: "vertical", line: lines[1].id },
    { id: skId("c"), kind: "horizontal", line: lines[2].id },
    { id: skId("c"), kind: "vertical", line: lines[3].id },
  ];
  return { sketch: push(s, [...corners, ...lines], constraints), ids: lines.map((l) => l.id) };
}

export function addCircle(s: SketchData, cx: number, cy: number, radius: number): Added {
  const c = { id: skId("p"), kind: "point" as const, x: cx, y: cy };
  const id = skId("k");
  return { sketch: push(s, [c, { id, kind: "circle", center: c.id, radius }]), ids: [id] };
}

export function addConstraint(s: SketchData, c: NewConstraint): Added {
  const id = skId("c");
  return { sketch: push(s, [], [{ ...c, id } as SkConstraint]), ids: [id] };
}

/**
 * Arc through three points: from `start` to `end` passing near `through`.
 * Start/end may be existing point ids or coordinates. Arcs are stored
 * counter-clockwise, so the ends are swapped when the pick runs clockwise.
 */
export function addArcThrough(
  s: SketchData,
  start: string | { x: number; y: number },
  end: string | { x: number; y: number },
  through: { x: number; y: number },
): Added | null {
  let sk = s;
  const pid = (p: string | { x: number; y: number }) => {
    if (typeof p === "string") return p;
    const r = addPoint(sk, p.x, p.y);
    sk = r.sketch;
    return r.ids[0];
  };
  const pos = (p: string | { x: number; y: number }) => (typeof p === "string" ? (s.entities.find((e) => e.id === p) as { x: number; y: number }) : p);
  const a = pos(start), b = pos(end), t = through;
  const d = 2 * (a.x * (b.y - t.y) + b.x * (t.y - a.y) + t.x * (a.y - b.y));
  if (Math.abs(d) < 1e-9) return null; // collinear: no arc
  const a2 = a.x ** 2 + a.y ** 2, b2 = b.x ** 2 + b.y ** 2, t2 = t.x ** 2 + t.y ** 2;
  const cx = (a2 * (b.y - t.y) + b2 * (t.y - a.y) + t2 * (a.y - b.y)) / d;
  const cy = (a2 * (t.x - b.x) + b2 * (a.x - t.x) + t2 * (b.x - a.x)) / d;
  // Counter-clockwise from a to b passes through t when the triangle (a, t, b) turns clockwise.
  const ccw = (t.x - a.x) * (b.y - a.y) - (t.y - a.y) * (b.x - a.x) > 0;
  const startId = pid(start), endId = pid(end);
  const c = addPoint(sk, cx, cy);
  sk = c.sketch;
  const id = skId("a");
  const arc = { id, kind: "arc" as const, center: c.ids[0], start: ccw ? startId : endId, end: ccw ? endId : startId, radius: Math.hypot(a.x - cx, a.y - cy) };
  return { sketch: push(sk, [arc]), ids: [id] };
}

/** Ellipse from its center, the end of the major axis and the minor radius. */
export function addEllipse(s: SketchData, cx: number, cy: number, mx: number, my: number, minor: number): Added | null {
  const a = Math.hypot(mx - cx, my - cy);
  if (a < 1e-6 || minor < 1e-6) return null;
  // The longer axis is the major one.
  const ux = (mx - cx) / a, uy = (my - cy) / a;
  const [major, minorR, dir] = minor > a ? [minor, a, [-uy, ux]] : [a, minor, [ux, uy]];
  const pts = [
    { id: skId("p"), kind: "point" as const, x: cx, y: cy },
    { id: skId("p"), kind: "point" as const, x: cx + dir[0] * major, y: cy + dir[1] * major },
    { id: skId("p"), kind: "point" as const, x: cx - dir[1] * minorR, y: cy + dir[0] * minorR },
  ];
  const id = skId("e");
  return { sketch: push(s, [...pts, { id, kind: "ellipse", center: pts[0].id, major: pts[1].id, minor: pts[2].id }]), ids: [id] };
}

/** Spline through existing point ids (at least two). */
export function addSpline(s: SketchData, points: string[], closed = false): Added | null {
  if (points.length < (closed ? 3 : 2)) return null;
  const id = skId("s");
  return { sketch: push(s, [{ id, kind: "spline", points, closed }]), ids: [id] };
}

/** Outgoing direction at end point `at` of a line or arc (continuing away from the curve). */
export function exitDirection(s: SketchData, curveId: string, at: string): { x: number; y: number } | null {
  const m = new Map(s.entities.map((e) => [e.id, e]));
  const c = m.get(curveId);
  const P = m.get(at);
  if (!c || !P || P.kind !== "point") return null;
  const unit = (x: number, y: number) => {
    const l = Math.hypot(x, y);
    return l < 1e-12 ? null : { x: x / l, y: y / l };
  };
  if (c.kind === "line") {
    const other = m.get(c.p1 === at ? c.p2 : c.p1);
    if (!other || other.kind !== "point" || (c.p1 !== at && c.p2 !== at)) return null;
    return unit(P.x - other.x, P.y - other.y);
  }
  if (c.kind === "arc" && (c.start === at || c.end === at)) {
    const C = m.get(c.center);
    if (!C || C.kind !== "point") return null;
    // Counter-clockwise tangent; at the start the curve is left going backwards.
    const t = unit(-(P.y - C.y), P.x - C.x);
    return t && (c.end === at ? t : { x: -t.x, y: -t.y });
  }
  return null;
}

/**
 * Arc leaving point `from` along direction `dir` and ending at `end`
 * (an existing point id or coordinates). Returns null when the end is
 * straight ahead (no arc can be tangent there).
 */
export function tangentArcGeom(from: { x: number; y: number }, dir: { x: number; y: number }, end: { x: number; y: number }) {
  const dx = end.x - from.x, dy = end.y - from.y;
  const nx = -dir.y, ny = dir.x; // left normal
  const dn = dx * nx + dy * ny;
  const d2 = dx * dx + dy * dy;
  if (Math.abs(dn) < 1e-9 * Math.max(1, Math.sqrt(d2)) || d2 < 1e-12) return null;
  const r = d2 / (2 * dn); // signed: > 0 turns left (counter-clockwise)
  return { cx: from.x + nx * r, cy: from.y + ny * r, radius: Math.abs(r), ccw: r > 0 };
}

/** Adds an arc tangent to `curveId` at its end point `from`, plus the tangency constraint. */
export function addTangentArc(s: SketchData, curveId: string, from: string, end: string | { x: number; y: number }): Added | null {
  const dir = exitDirection(s, curveId, from);
  const P = s.entities.find((e) => e.id === from);
  if (!dir || !P || P.kind !== "point") return null;
  let sk = s;
  let endId: string;
  if (typeof end === "string") endId = end;
  else {
    const r = addPoint(sk, end.x, end.y);
    sk = r.sketch;
    endId = r.ids[0];
  }
  const E = sk.entities.find((e) => e.id === endId) as { x: number; y: number };
  const g = tangentArcGeom(P, dir, E);
  if (!g || endId === from) return null;
  const c = addPoint(sk, g.cx, g.cy);
  sk = c.sketch;
  const id = skId("a");
  const arc = { id, kind: "arc" as const, center: c.ids[0], start: g.ccw ? from : endId, end: g.ccw ? endId : from, radius: g.radius };
  // Tangency at the shared point. Lines run p1 -> p2 and arcs counter-clockwise; compare those directions.
  const prev = sk.entities.find((e) => e.id === curveId)!;
  const prevParam = prev.kind === "line" ? (prev.p2 === from ? dir : { x: -dir.x, y: -dir.y }) : (prev as { end: string }).end === from ? dir : { x: -dir.x, y: -dir.y };
  const arcParam = g.ccw ? dir : { x: -dir.x, y: -dir.y }; // leaving `from` along dir is the arc's ccw direction when it turns left
  const reversed = prevParam.x * arcParam.x + prevParam.y * arcParam.y < 0;
  sk = push(sk, [arc], [{ id: skId("c"), kind: "tangentAt", a: curveId, b: id, point: from, reversed }]);
  return { sketch: sk, ids: [id] };
}
