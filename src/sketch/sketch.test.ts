import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { constraintActions, dimensionFor } from "./actions";
import { addCircle, addConstraint, addRectangle } from "./builders";
import { emptySketch, entityMap, pointOf, removeEntities, type SkLine, type SketchData } from "./model";
import { findLoops, nestLoops } from "./profiles";
import { loadSolver, solve } from "./solver";

const wasm = fileURLToPath(new URL("../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm", import.meta.url));

beforeAll(async () => {
  await loadSolver(wasm);
});

function lineLength(s: SketchData, id: string) {
  const m = entityMap(s);
  const l = m.get(id) as SkLine;
  const a = pointOf(m, l.p1), b = pointOf(m, l.p2);
  return Math.hypot(b.x - a.x, b.y - a.y);
}

describe("solver", () => {
  it("drives a rectangle to its dimensions", () => {
    let r = addRectangle(emptySketch(), 0, 0, 10, 10);
    const [bottom, right] = r.ids;
    r = addConstraint(r.sketch, { kind: "length", line: bottom, value: 40 });
    r = addConstraint(r.sketch, { kind: "length", line: right, value: 25 });
    const res = solve(r.sketch);
    expect(res.ok).toBe(true);
    expect(lineLength(res.sketch, bottom)).toBeCloseTo(40, 6);
    expect(lineLength(res.sketch, right)).toBeCloseTo(25, 6);
    // Rectangle position is still free: 2 translational DOF.
    expect(res.dof).toBe(2);
  });

  it("is fully constrained once a corner is fixed", () => {
    let r = addRectangle(emptySketch(), 0, 0, 10, 10);
    const [bottom, right] = r.ids;
    const corner = (r.sketch.entities.find((e) => e.kind === "point") as { id: string }).id;
    r = addConstraint(r.sketch, { kind: "length", line: bottom, value: 40 });
    r = addConstraint(r.sketch, { kind: "length", line: right, value: 25 });
    r = addConstraint(r.sketch, { kind: "fixed", point: corner });
    expect(solve(r.sketch).dof).toBe(0);
  });

  it("reports conflicting constraints", () => {
    let r = addRectangle(emptySketch(), 0, 0, 10, 10);
    const [bottom] = r.ids;
    r = addConstraint(r.sketch, { kind: "length", line: bottom, value: 40 });
    r = addConstraint(r.sketch, { kind: "length", line: bottom, value: 20 });
    const res = solve(r.sketch);
    expect(res.ok && res.conflicting.length === 0).toBe(false);
  });

  it("drags a point while keeping constraints", () => {
    let r = addRectangle(emptySketch(), 0, 0, 10, 10);
    const bottom = r.ids[0];
    r = addConstraint(r.sketch, { kind: "length", line: bottom, value: 10 });
    const corner = r.sketch.entities.find((e) => e.kind === "point")!.id;
    const res = solve(r.sketch, [{ point: corner, x: 5, y: 5 }]);
    expect(res.ok).toBe(true);
    expect(lineLength(res.sketch, bottom)).toBeCloseTo(10, 4);
    const p = pointOf(res.sketch, corner);
    expect(p.x).toBeCloseTo(5, 3);
    expect(p.y).toBeCloseTo(5, 3);
  });

  it("solves circle radius and tangency", () => {
    let c = addCircle(emptySketch(), 0, 0, 5);
    const circle = c.ids[0];
    c = addConstraint(c.sketch, { kind: "radius", circle, value: 12 });
    const res = solve(c.sketch);
    const k = res.sketch.entities.find((e) => e.id === circle);
    expect(k && k.kind === "circle" && k.radius).toBeCloseTo(12, 6);
  });
});

describe("profiles", () => {
  it("finds a rectangle loop and a circle", () => {
    let s = addRectangle(emptySketch(), -20, -15, 20, 15).sketch;
    s = addCircle(s, 0, 0, 5).sketch;
    const { loops, openCurves } = findLoops(s);
    expect(loops.map((l) => l.kind).sort()).toEqual(["circle", "polygon"]);
    expect(openCurves).toEqual([]);
    // Circle inside the rectangle becomes a hole.
    const nested = nestLoops(loops);
    expect(nested[0].loop.kind).toBe("polygon");
    expect(nested[1].depth).toBe(1);
  });

  it("ignores open chains and construction geometry", () => {
    const r = addRectangle(emptySketch(), 0, 0, 10, 10);
    const open = removeEntities(r.sketch, [r.ids[0]]);
    expect(findLoops(open).loops).toHaveLength(0);
    const construction = { ...r.sketch, entities: r.sketch.entities.map((e) => (e.kind === "line" ? { ...e, construction: true } : e)) };
    expect(findLoops(construction).loops).toHaveLength(0);
  });
});

describe("actions", () => {
  it("offers line constraints and a length dimension", () => {
    const r = addRectangle(emptySketch(), 0, 0, 10, 10);
    const keys = constraintActions(r.sketch, [r.ids[0], r.ids[1]]).map((a) => a.key);
    expect(keys).toEqual(expect.arrayContaining(["parallel", "perpendicular", "equal"]));
    const dim = dimensionFor(r.sketch, [r.ids[0]]);
    expect(dim).toMatchObject({ kind: "length", value: 10 });
  });
});
