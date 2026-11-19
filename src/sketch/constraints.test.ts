import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { constraintActions, dimensionFor } from "./actions";
import { addCircle, addConstraint, addEllipse, addLineBetween, addPoint, addRectangle } from "./builders";
import { circularPlace, linearPlace, patternCurves } from "./edit";
import { emptySketch, entityMap, pointOf, type SkCircle, type SkEllipse, type SkLine, type SketchData } from "./model";
import { findLoops } from "./profiles";
import { loadSolver, solve } from "./solver";
import { validateDocument } from "../io/fileFormat";

beforeAll(async () => {
  await loadSolver(fileURLToPath(new URL("../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm", import.meta.url)));
});

const apply = (s: SketchData, sel: string[], key: string) => {
  const a = constraintActions(s, sel).find((x) => x.key === key);
  if (!a) throw new Error(`no ${key} for this selection`);
  let out = s;
  for (const c of a.build()) out = addConstraint(out, c).sketch;
  const r = solve(out);
  expect(r.ok).toBe(true);
  expect(r.conflicting).toEqual([]);
  return r.sketch;
};

/** A vertical axis line along x = 0, from y = -20 to 20 (fixed). */
function withAxis() {
  let s = emptySketch();
  const a = addPoint(s, 0, -20), b = addPoint(a.sketch, 0, 20);
  s = b.sketch;
  const l = addLineBetween(s, a.ids[0], b.ids[0]);
  s = l.sketch;
  for (const p of [a.ids[0], b.ids[0]]) s = addConstraint(s, { kind: "fixed", point: p }).sketch;
  return { s, axis: l.ids[0] };
}

describe("concentric, symmetric, distances, patterns", () => {
  it("makes circles and an ellipse concentric", () => {
    let s = emptySketch();
    const c1 = addCircle(s, 0, 0, 5);
    const c2 = addCircle(c1.sketch, 3, 4, 2);
    const e = addEllipse(c2.sketch, -2, 1, 6, 1, 2)!;
    s = apply(e.sketch, [c1.ids[0], c2.ids[0], e.ids[0]], "concentric");
    const m = entityMap(s);
    const centre = (id: string) => pointOf(m, (m.get(id) as SkCircle | SkEllipse).center);
    expect(centre(c2.ids[0]).x).toBeCloseTo(centre(c1.ids[0]).x, 6);
    expect(centre(e.ids[0]).y).toBeCloseTo(centre(c1.ids[0]).y, 6);
  });

  it("mirrors two points across a line", () => {
    const { s: s0, axis } = withAxis();
    const p = addPoint(s0, 7, 3), q = addPoint(p.sketch, -4, 6);
    let s = addConstraint(q.sketch, { kind: "fixed", point: p.ids[0] }).sketch;
    s = apply(s, [p.ids[0], q.ids[0], axis], "symmetric");
    const Q = pointOf(s, q.ids[0]);
    expect(Q.x).toBeCloseTo(-7, 6);
    expect(Q.y).toBeCloseTo(3, 6);
  });

  it("mirrors two lines end to end, and two circles with equal radii", () => {
    const { s: s0, axis } = withAxis();
    const a = addRectangle(s0, 2, 2, 8, 6); // 4 lines; take the bottom one
    const b1 = addPoint(a.sketch, -9, 2.5), b2 = addPoint(b1.sketch, -1, 1);
    const lb = addLineBetween(b2.sketch, b1.ids[0], b2.ids[0]);
    const bottom = a.ids[0];
    let s = lb.sketch;
    for (const id of (s.entities.filter((e) => e.kind === "point").map((e) => e.id))) if (a.sketch.entities.some((e) => e.id === id) && !s0.entities.some((e) => e.id === id)) s = addConstraint(s, { kind: "fixed", point: id }).sketch;
    s = apply(s, [bottom, lb.ids[0], axis], "symmetric");
    const m = entityMap(s);
    const L = m.get(lb.ids[0]) as SkLine;
    const xs = [pointOf(m, L.p1).x, pointOf(m, L.p2).x].sort((x, y) => x - y);
    expect(xs[0]).toBeCloseTo(-8, 6);
    expect(xs[1]).toBeCloseTo(-2, 6);

    const c1 = addCircle(s0, 6, 1, 3), c2 = addCircle(c1.sketch, -5, 2, 1);
    let t = addConstraint(c2.sketch, { kind: "fixed", point: (c1.sketch.entities.find((e) => e.id === c1.ids[0]) as SkCircle).center }).sketch;
    t = addConstraint(t, { kind: "radius", circle: c1.ids[0], value: 3 }).sketch;
    t = apply(t, [c1.ids[0], c2.ids[0], axis], "symmetric");
    const k2 = entityMap(t).get(c2.ids[0]) as SkCircle;
    expect(k2.radius).toBeCloseTo(3, 6);
    expect(pointOf(t, k2.center).x).toBeCloseTo(-6, 6);
  });

  it("dimensions a point to a line, and parallel lines apart", () => {
    let r = addRectangle(emptySketch(), 0, 0, 20, 10);
    const [bottom, , top] = r.ids;
    const pt = addPoint(r.sketch, 5, 4);
    let d = dimensionFor(pt.sketch, [pt.ids[0], bottom])!;
    expect(d).toMatchObject({ kind: "pointLine", value: 4 });
    let s = addConstraint(pt.sketch, { ...d, value: 7 } as never).sketch;
    let res = solve(s);
    expect(res.ok).toBe(true);
    const P = pointOf(res.sketch, pt.ids[0]), B = entityMap(res.sketch).get(bottom) as SkLine;
    expect(Math.abs(P.y - pointOf(res.sketch, B.p1).y)).toBeCloseTo(7, 6);

    d = dimensionFor(r.sketch, [bottom, top])!;
    expect(d).toMatchObject({ kind: "pointLine", value: 10 });
    s = addConstraint(r.sketch, { kind: "horizontal", line: bottom }).sketch;
    s = addConstraint(s, { ...d, value: 15 } as never).sketch;
    res = solve(s);
    const T = entityMap(res.sketch).get(top) as SkLine;
    expect(pointOf(res.sketch, T.p1).y - pointOf(res.sketch, (entityMap(res.sketch).get(bottom) as SkLine).p1).y).toBeCloseTo(15, 6);
    // Lines at an angle still get an angle.
    r = addRectangle(emptySketch(), 0, 0, 20, 10);
    expect(dimensionFor(r.sketch, [r.ids[0], r.ids[1]])!.kind).toBe("angle");
  });

  it("dimensions an ellipse's semi-axes, major first", () => {
    const e = addEllipse(emptySketch(), 0, 0, 8, 0, 3)!;
    const el = entityMap(e.sketch).get(e.ids[0]) as SkEllipse;
    const d1 = dimensionFor(e.sketch, [e.ids[0]])!;
    expect(d1).toMatchObject({ kind: "distance", a: el.center, b: el.major, value: 8 });
    const s = addConstraint(e.sketch, d1).sketch;
    const d2 = dimensionFor(s, [e.ids[0]])!;
    expect(d2).toMatchObject({ kind: "distance", b: el.minor, value: 3 });
    expect(dimensionFor(addConstraint(s, { ...d2, value: 2 } as never).sketch, [e.ids[0]])).toBeNull();
  });

  it("patterns curves in a row and around a point", () => {
    const r = addRectangle(emptySketch(), 0, 0, 4, 2);
    const row = patternCurves(r.sketch, r.ids, 3, linearPlace(10, 0));
    expect(row.ids).toHaveLength(8);
    expect(findLoops(row.sketch).loops).toHaveLength(3);
    const c = addCircle(emptySketch(), 10, 0, 1);
    const ring = patternCurves(c.sketch, c.ids, 6, circularPlace(0, 0, 6));
    const centres = ring.ids.map((id) => pointOf(ring.sketch, (entityMap(ring.sketch).get(id) as SkCircle).center));
    expect(centres[2].x).toBeCloseTo(-10, 6); // 3 × 60°
    expect(Math.hypot(centres[0].x, centres[0].y)).toBeCloseTo(10, 6);
  });

  it("saves the new constraint kinds", () => {
    const { s: s0, axis } = withAxis();
    const p = addPoint(s0, 3, 1), q = addPoint(p.sketch, -3, 1);
    let s = addConstraint(q.sketch, { kind: "symmetric", a: p.ids[0], b: q.ids[0], line: axis }).sketch;
    s = addConstraint(s, { kind: "pointLine", point: p.ids[0], line: axis, value: 3 }).sketch;
    const doc = validateDocument({ variables: [], features: [{ type: "sketch", id: "sk1", name: "Sketch 1", suppressed: false, plane: "XY", offset: 0, sketch: s }] });
    expect((doc.features[0] as { sketch: SketchData }).sketch.constraints.map((c) => c.kind).slice(-2)).toEqual(["symmetric", "pointLine"]);
  });
});
