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
