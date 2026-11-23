import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { addRectangle } from "./builders";
import { addSlot, filletCorner } from "./edit";
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
const solved = (s: SketchData) => {
  const r = solve(s);
  expect(r.ok).toBe(true);
  expect(r.conflicting).toEqual([]);
  return r.sketch;
};

describe("corner fillet", () => {
  it("rounds a rectangle corner tangent to both sides", () => {
    const rect = addRectangle(emptySketch(), 0, 0, 20, 10).sketch;
    const corner = rect.entities.find((e) => e.kind === "point" && e.x === 20 && e.y === 10)!.id;
    const r = ok(filletCorner(rect, corner, 3));
    const s = solved(r.sketch);
    const m = entityMap(s);
    const arc = m.get(r.ids[0]) as SkArc;
    const c = pointOf(m, arc.center);
    expect(c.x).toBeCloseTo(17, 6);
    expect(c.y).toBeCloseTo(7, 6);
    expect(m.has(corner)).toBe(false);
    // Area: the square corner minus the quarter disc.
    const { loops } = findLoops(s);
    expect(loops).toHaveLength(1);
    expect(loopArea(loops[0])).toBeCloseTo(200 - (9 - (Math.PI * 9) / 4), 0);
    // Radius is a dimension the user can change.
    expect(s.constraints.some((k) => k.kind === "radius" && k.circle === arc.id && k.value === 3)).toBe(true);
  });

  it("follows a new radius through the solver", () => {
    const rect = addRectangle(emptySketch(), 0, 0, 20, 10).sketch;
    const corner = rect.entities.find((e) => e.kind === "point" && e.x === 0 && e.y === 0)!.id;
    const r = ok(filletCorner(rect, corner, 2));
    // Pin the other three corners so only the fillet can move.
    const pins = rect.entities.filter((e) => e.kind === "point" && e.id !== corner).map((e, i) => ({ id: `pin${i}`, kind: "fixed" as const, point: e.id }));
    const constraints = [...r.sketch.constraints.map((k) => (k.kind === "radius" ? { ...k, value: 4 } : k)), ...pins];
    const s = solved({ ...r.sketch, constraints });
    const m = entityMap(s);
    const arc = m.get(r.ids[0]) as SkArc;
    const st = pointOf(m, arc.start), en = pointOf(m, arc.end);
    // Tangent points on the bottom (y=0) and left (x=0) sides, 4 from the corner.
    const pts = [st, en].sort((a, b) => a.x - b.x);
    expect(pts[0].x).toBeCloseTo(0, 4);
    expect(pts[0].y).toBeCloseTo(4, 4);
    expect(pts[1].x).toBeCloseTo(4, 4);
    expect(pts[1].y).toBeCloseTo(0, 4);
  });

  it("refuses a radius the lines can't hold, and non-corners", () => {
    const rect = addRectangle(emptySketch(), 0, 0, 20, 10).sketch;
    const corner = rect.entities.find((e) => e.kind === "point")!.id;
    expect("error" in filletCorner(rect, corner, 11)).toBe(true);
    const lone = rect.entities.find((e) => e.kind === "line") as SkLine;
    expect("error" in filletCorner(rect, lone.id, 1)).toBe(true);
  });
});

describe("slot", () => {
  it("is a closed loop of two half circles and two lines", () => {
    const r = addSlot(emptySketch(), [0, 0], [10, 0], 2)!;
    const s = solved(r.sketch);
    const { loops } = findLoops(s);
    expect(loops).toHaveLength(1);
    expect(loopArea(loops[0])).toBeCloseTo(10 * 4 + Math.PI * 4, 0);
  });

  it("keeps its shape when the width changes", () => {
    const r = addSlot(emptySketch(), [0, 0], [10, 5], 2)!;
    const capA = r.ids[3];
    const constraints = [...r.sketch.constraints, { id: "cr", kind: "radius" as const, circle: capA, value: 3 }];
    const s = solved({ ...r.sketch, constraints });
    const m = entityMap(s);
    const caps = r.ids.filter((id) => m.get(id)!.kind === "arc").map((id) => m.get(id) as SkArc);
    expect(caps.map((a) => a.radius)).toEqual([expect.closeTo(3, 6), expect.closeTo(3, 6)]);
    const lines = r.ids.filter((id) => m.get(id)!.kind === "line").map((id) => m.get(id) as SkLine);
    // Lines 2r apart, parallel to the axis.
    const [l0, l1] = lines.map((l) => [pointOf(m, l.p1), pointOf(m, l.p2)]);
    const ca = pointOf(m, caps[0].center), cb = pointOf(m, caps[1].center);
    const d = Math.hypot(cb.x - ca.x, cb.y - ca.y), ux = (cb.x - ca.x) / d, uy = (cb.y - ca.y) / d;
    const off = (p: { x: number; y: number }) => -(p.x - ca.x) * uy + (p.y - ca.y) * ux;
    expect(Math.abs(off(l0[0]) - off(l1[0]))).toBeCloseTo(6, 4);
    expect(off(l0[0])).toBeCloseTo(off(l0[1]), 4);
  });
});
