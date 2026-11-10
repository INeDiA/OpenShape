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
