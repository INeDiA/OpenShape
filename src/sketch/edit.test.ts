import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { addCircle, addLineBetween, addPoint, addRectangle, addTangentArc } from "./builders";
import { offsetCurves, trimCurve } from "./edit";
import { emptySketch, entityMap, pointOf, type SkArc, type SkLine, type SketchData } from "./model";
import { findLoops, loopArea } from "./profiles";
import { loadSolver, solve } from "./solver";

const wasm = fileURLToPath(new URL("../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm", import.meta.url));
beforeAll(async () => {
  await loadSolver(wasm);
});

const ok = <T extends object>(r: T | { error: string }): T => {
  if ("error" in r) throw new Error(r.error);
  return r;
};
function line(s: SketchData, a: [number, number], b: [number, number]) {
  const p = addPoint(s, ...a);
  const q = addPoint(p.sketch, ...b);
  const l = addLineBetween(q.sketch, p.ids[0], q.ids[0]);
  return { sketch: l.sketch, id: l.ids[0] };
}
/** Within 1%: loop areas sample arcs as polygons. */
const near = (a: number, e: number) => expect(Math.abs(a - e) / e).toBeLessThan(0.01);
const areas = (s: SketchData) => findLoops(s).loops.map((l) => Math.round(loopArea(l) * 10) / 10).sort((a, b) => a - b);

describe("trim", () => {
  it("cuts a line back to the line crossing it", () => {
    let { sketch, id } = line(emptySketch(), [0, 0], [10, 0]);
    const cross = line(sketch, [5, -5], [5, 5]);
    sketch = ok(trimCurve(cross.sketch, id, 8, 0)).sketch;
    const m = entityMap(sketch);
    const l = m.get(id) as SkLine;
    expect(pointOf(m, l.p2).x).toBeCloseTo(5, 9);
    const r = solve(sketch);
    expect(r.ok && r.conflicting.length === 0).toBe(true);
  });

  it("splits a line crossed twice, keeping both ends", () => {
    let { sketch, id } = line(emptySketch(), [0, 0], [30, 0]);
    sketch = line(sketch, [10, -5], [10, 5]).sketch;
    sketch = line(sketch, [20, -5], [20, 5]).sketch;
    const r = ok(trimCurve(sketch, id, 15, 0));
    expect(r.removed[0][0]).toBeCloseTo(10);
    expect(r.removed[1][0]).toBeCloseTo(20);
    expect(r.sketch.entities.filter((e) => e.kind === "line")).toHaveLength(4);
    expect(solve(r.sketch).conflicting).toEqual([]);
  });

  it("deletes a curve nothing crosses", () => {
    const { sketch, id } = line(emptySketch(), [0, 0], [10, 0]);
    expect(ok(trimCurve(sketch, id, 5, 0)).sketch.entities).toHaveLength(0);
  });

  it("turns a rectangle and a circle into one outline", () => {
    // 20 x 10 rectangle; circle of radius 5 centered on its right edge.
    const rect = addRectangle(emptySketch(), 0, 0, 20, 10);
    const right = rect.ids[1];
    const circle = addCircle(rect.sketch, 20, 5, 5);
    let s = circle.sketch;
    s = ok(trimCurve(s, circle.ids[0], 16, 5)).sketch; // the half inside the rectangle
    expect(s.entities.find((e) => e.id === circle.ids[0])?.kind).toBe("arc");
    s = ok(trimCurve(s, right, 20, 5)).sketch; // the edge under the bump
    const a = areas(s);
    expect(a).toHaveLength(1);
    near(a[0], 200 + (Math.PI * 25) / 2);
    const r = solve(s);
    expect(r.ok && r.conflicting.length === 0).toBe(true);
  });

  it("shortens an arc at a crossing line", () => {
    const { sketch: s0, id } = line(emptySketch(), [0, 0], [10, 0]);
    const arc = addTangentArc(s0, id, (s0.entities.find((e) => e.kind === "line") as SkLine).p2, { x: 10, y: 10 })!;
    const cut = line(arc.sketch, [8, 5], [20, 5]);
    const r = ok(trimCurve(cut.sketch, arc.ids[0], 14, 8)); // upper part, beyond y = 5
    const m = entityMap(r.sketch);
    const a = m.get(arc.ids[0]) as SkArc;
    expect(pointOf(m, a.end).y).toBeCloseTo(5, 6);
  });
});

describe("regions", () => {
  it("keeps a rectangle a profile when an arc ends on two of its edges", () => {
    // Circle on the bottom-right corner, trimmed inside the rectangle: its ends sit on two edges.
    const rect = addRectangle(emptySketch(), -10, -3, 3, 7);
    const circle = addCircle(rect.sketch, 3, 0, 3.2766);
    const s = ok(trimCurve(circle.sketch, circle.ids[0], 1, 0)).sketch;
    const a = areas(s);
    // The rectangle and the bump outside it, side by side (fused when extruded).
    expect(a).toHaveLength(2);
    near(a[1], 130);
    expect(findLoops(s).openCurves).toEqual([]);
  });

  it("splits a rectangle crossed by a line into two regions, holes still cut", () => {
    // A line from the middle of the bottom edge to the middle of the top edge, and a hole on the left.
    let s = line(addRectangle(emptySketch(), 0, 0, 20, 10).sketch, [10, 0], [10, 10]).sketch;
    s = addCircle(s, 5, 5, 2).sketch;
    const regions = areas(s);
    expect(regions).toHaveLength(3);
    near(regions[1], 100);
    near(regions[2], 100);
  });
});

describe("offset", () => {
  it("grows and shrinks a closed rectangle", () => {
    const rect = addRectangle(emptySketch(), 0, 0, 20, 10);
    const out = ok(offsetCurves(rect.sketch, rect.ids, 2));
    expect(out.ids).toHaveLength(4);
    expect(areas(out.sketch)).toEqual([200, 24 * 14]);
    const inn = ok(offsetCurves(rect.sketch, rect.ids, -2));
    expect(areas(inn.sketch)).toEqual([16 * 6, 200]);
    expect(solve(out.sketch).conflicting).toEqual([]);
  });

  it("offsets a slot of lines and tangent arcs", () => {
    let { sketch, id } = line(emptySketch(), [0, 0], [30, 0]);
    const l1 = sketch.entities.find((e) => e.id === id) as SkLine;
    const a1 = addTangentArc(sketch, id, l1.p2, { x: 30, y: 10 })!;
    const a1e = a1.sketch.entities.find((e) => e.id === a1.ids[0]) as SkArc;
    const top = addPoint(a1.sketch, 0, 10);
    const l2 = addLineBetween(top.sketch, a1e.end, top.ids[0]);
    const a2 = addTangentArc(l2.sketch, l2.ids[0], top.ids[0], l1.p1)!;
    sketch = a2.sketch;
    const curves = sketch.entities.filter((e) => e.kind === "line" || e.kind === "arc").map((e) => e.id);
    const r = ok(offsetCurves(sketch, curves, 1));
    // Slot 30 long, radius 5 -> radius 6 after the offset.
    const expected = 30 * 12 + Math.PI * 36;
    near(areas(r.sketch)[1], expected);
  });

  it("offsets a circle and an open line", () => {
    const c = addCircle(emptySketch(), 0, 0, 5);
    const r = ok(offsetCurves(c.sketch, c.ids, 3));
    near(areas(r.sketch)[1], Math.PI * 64);
    const { sketch, id } = line(emptySketch(), [0, 0], [10, 0]);
    const o = ok(offsetCurves(sketch, [id], 2));
    const m = entityMap(o.sketch);
    const nl = m.get(o.ids[0]) as SkLine;
    expect(pointOf(m, nl.p1).y).toBeCloseTo(2); // left of the drawing direction
  });

  it("rejects curves it can't offset", () => {
    expect("error" in offsetCurves(emptySketch(), [], 1)).toBe(true);
    const c = addCircle(emptySketch(), 0, 0, 2);
    expect("error" in offsetCurves(c.sketch, c.ids, -3)).toBe(true);
  });
});
