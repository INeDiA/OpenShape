import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { addConstraint, addEllipse, addLineBetween, addPoint, addSpline, addTangentArc } from "./builders";
import { ellipseGeom, splineBeziers } from "./curves";
import { emptySketch, entityMap, pointOf, type SkArc, type SkEllipse, type SketchData } from "./model";
import { findLoops, loopArea } from "./profiles";
import { loadSolver, solve } from "./solver";

const wasm = fileURLToPath(new URL("../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm", import.meta.url));
beforeAll(async () => {
  await loadSolver(wasm);
});

const pts = (s: SketchData, ...xy: [number, number][]) => {
  const ids: string[] = [];
  for (const [x, y] of xy) {
    const r = addPoint(s, x, y);
    s = r.sketch;
    ids.push(r.ids[0]);
  }
  return { s, ids };
};

describe("ellipse", () => {
  it("solves and keeps its axes when dimensioned", () => {
    const r = addEllipse(emptySketch(), 0, 0, 20, 0, 8)!;
    const e = r.sketch.entities.find((x) => x.id === r.ids[0]) as SkEllipse;
    let s = r.sketch;
    s = addConstraint(s, { kind: "distance", a: e.center, b: e.major, value: 30 }).sketch;
    s = addConstraint(s, { kind: "distance", a: e.center, b: e.minor, value: 10 }).sketch;
    const res = solve(s);
    expect(res.ok).toBe(true);
    const g = ellipseGeom(entityMap(res.sketch), e);
    expect(g.a).toBeCloseTo(30, 5);
    expect(g.b).toBeCloseTo(10, 5);
    // The minor axis point stays perpendicular to the major one.
    const m = entityMap(res.sketch);
    const c = pointOf(m, e.center), ma = pointOf(m, e.major), mi = pointOf(m, e.minor);
    expect((ma.x - c.x) * (mi.x - c.x) + (ma.y - c.y) * (mi.y - c.y)).toBeCloseTo(0, 5);
  });

  it("is a closed profile with the right area", () => {
    const { loops } = findLoops(addEllipse(emptySketch(), 5, 5, 25, 5, 10)!.sketch);
    expect(loops).toHaveLength(1);
    expect(loopArea(loops[0])).toBeCloseTo(Math.PI * 20 * 10, -1);
  });
});

describe("spline", () => {
  it("passes through its points", () => {
    const b = splineBeziers([
      [0, 0],
      [10, 5],
      [20, 0],
    ]);
    expect(b).toHaveLength(2);
    expect(b[0].to).toEqual([10, 5]);
    expect(b[1].to).toEqual([20, 0]);
  });

  it("closes a profile with a line, and alone when closed", () => {
    let { s, ids } = pts(emptySketch(), [0, 0], [10, 8], [20, 0]);
    s = addSpline(s, ids)!.sketch;
    s = addLineBetween(s, ids[2], ids[0]).sketch;
    const { loops, openCurves } = findLoops(s);
    expect(openCurves).toEqual([]);
    expect(loops).toHaveLength(1);
    expect(loopArea(loops[0])).toBeGreaterThan(50);

    const c = pts(emptySketch(), [0, 0], [10, 0], [10, 10], [0, 10]);
    const closed = findLoops(addSpline(c.s, c.ids, true)!.sketch);
    expect(closed.loops).toHaveLength(1);
  });
});

describe("tangent arc", () => {
  it("leaves a line tangentially and stays tangent after solving", () => {
    let { s, ids } = pts(emptySketch(), [0, 0], [10, 0]);
    const line = addLineBetween(s, ids[0], ids[1]);
    s = line.sketch;
    const r = addTangentArc(s, line.ids[0], ids[1], { x: 20, y: 10 })!;
    expect(r).not.toBeNull();
    const arc = r.sketch.entities.find((e) => e.id === r.ids[0]) as SkArc;
    const m = entityMap(r.sketch);
    // Turning left from +X: center straight above the line's end.
    expect(pointOf(m, arc.center).x).toBeCloseTo(10, 6);
    expect(arc.radius).toBeCloseTo(10, 6);
    const res = solve(r.sketch);
    expect(res.ok).toBe(true);
    expect(res.conflicting).toEqual([]);
    expect(res.redundant).toEqual([]);
    // Driving the radius keeps the arc tangent to the (horizontal) line at the shared point.
    let s2 = addConstraint(res.sketch, { kind: "horizontal", line: line.ids[0] }).sketch;
    s2 = addConstraint(s2, { kind: "radius", circle: arc.id, value: 25 }).sketch;
    const res2 = solve(s2);
    expect(res2.ok && res2.redundant.length === 0).toBe(true);
    const m2 = entityMap(res2.sketch);
    const c2 = pointOf(m2, arc.center), joint = pointOf(m2, ids[1]);
    expect(c2.x - joint.x).toBeCloseTo(0, 6); // center straight above the joint
    expect(c2.y - joint.y).toBeCloseTo(25, 6);
  });

  it("continues from an arc, and refuses a straight continuation", () => {
    let { s, ids } = pts(emptySketch(), [0, 0], [10, 0]);
    const line = addLineBetween(s, ids[0], ids[1]);
    const a1 = addTangentArc(line.sketch, line.ids[0], ids[1], { x: 20, y: 10 })!;
    const end = (a1.sketch.entities.find((e) => e.id === a1.ids[0]) as SkArc).end; // ccw: ends at (20, 10)
    const a2 = addTangentArc(a1.sketch, a1.ids[0], end, { x: 30, y: 20 });
    expect(a2).not.toBeNull();
    expect(solve(a2!.sketch).ok).toBe(true);
    expect(addTangentArc(line.sketch, line.ids[0], ids[1], { x: 30, y: 0 })).toBeNull();
  });
});
