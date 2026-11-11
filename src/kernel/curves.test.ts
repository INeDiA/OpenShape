import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { addCircle, addEllipse, addLineBetween, addPoint, addRectangle, addSpline, addTangentArc } from "../sketch/builders";
import { trimCurve } from "../sketch/edit";
import { emptySketch, type SketchData } from "../sketch/model";
import { makeExtrude, makeSketch } from "../model/doc";
import type { Document } from "../model/types";
import { evaluate } from "./evaluate";

const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
beforeAll(async () => {
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

async function extruded(sketch: SketchData, distance = 10) {
  const doc: Document = { variables: [], features: [] };
  const s = makeSketch(doc, "XY", 0, sketch);
  doc.features.push(s, { ...makeExtrude(doc, s.id, "new"), distance });
  const r = await evaluate(doc);
  const bad = r.status.filter((x) => !x.ok);
  if (bad.length) throw new Error(bad.map((b) => b.error).join("; "));
  return r;
}

const points = (xy: [number, number][]) => {
  let s = emptySketch();
  const ids = xy.map(([x, y]) => {
    const r = addPoint(s, x, y);
    s = r.sketch;
    return r.ids[0];
  });
  return { s, ids };
};

describe("new sketch curves in solids", () => {
  it("extrudes a rotated ellipse", async () => {
    // Major axis along 45°, a = 20, b = 8.
    const el = addEllipse(emptySketch(), 0, 0, 20 / Math.SQRT2, 20 / Math.SQRT2, 8)!;
    const r = await extruded(el.sketch);
    expect(measureVolume(r.body!.shape)).toBeCloseTo(Math.PI * 20 * 8 * 10, 0);
    // The lateral surface may come in two halves; both are named after the ellipse.
    const sides = [...r.body!.names.values()].filter((n) => n.includes(":side:"));
    expect(sides.length).toBeGreaterThan(0);
    expect(sides.every((n) => n.includes(`:side:${el.ids[0]}`))).toBe(true);
  });

  it("extrudes a spline closed by a line, naming the spline's side faces", async () => {
    let { s, ids } = points([
      [0, 0],
      [10, 8],
      [20, 3],
      [30, 0],
    ]);
    const sp = addSpline(s, ids)!;
    s = addLineBetween(sp.sketch, ids[3], ids[0]).sketch;
    const r = await extruded(s);
    expect(measureVolume(r.body!.shape)).toBeGreaterThan(500);
    const names = [...r.body!.names.values()];
    expect(names.some((n) => n.includes(`:side:${sp.ids[0]}`))).toBe(true);
  });

  it("extrudes a slot made of lines and tangent arcs", async () => {
    let { s, ids } = points([
      [0, 0],
      [30, 0],
    ]);
    const bottom = addLineBetween(s, ids[0], ids[1]);
    const arc1 = addTangentArc(bottom.sketch, bottom.ids[0], ids[1], { x: 30, y: 10 })!;
    s = arc1.sketch;
    const top = addPoint(s, 0, 10);
    const endOfArc = s.entities.find((e) => e.kind === "point" && Math.abs(e.x - 30) < 1e-9 && Math.abs(e.y - 10) < 1e-9)!.id;
    const topLine = addLineBetween(top.sketch, endOfArc, top.ids[0]);
    const arc2 = addTangentArc(topLine.sketch, topLine.ids[0], top.ids[0], { x: 0, y: 0 });
    // The second arc must end on the first point: use its id.
    const closing = addTangentArc(topLine.sketch, topLine.ids[0], top.ids[0], ids[0])!;
    expect(arc2).not.toBeNull();
    const r = await extruded(closing.sketch);
    // 30 x 10 rectangle plus two half discs of radius 5.
    expect(measureVolume(r.body!.shape)).toBeCloseTo((30 * 10 + Math.PI * 25) * 10, 0);
  });

  it("extrudes an outline made by trimming a rectangle and a circle", async () => {
    const rect = addRectangle(emptySketch(), 0, 0, 20, 10);
    const circle = addCircle(rect.sketch, 20, 5, 5);
    const t1 = trimCurve(circle.sketch, circle.ids[0], 16, 5);
    if ("error" in t1) throw new Error(t1.error);
    const t2 = trimCurve(t1.sketch, rect.ids[1], 20, 5);
    if ("error" in t2) throw new Error(t2.error);
    const r = await extruded(t2.sketch);
    expect(measureVolume(r.body!.shape)).toBeCloseTo((200 + (Math.PI * 25) / 2) * 10, 0);
  });

  it("fuses regions side by side and still cuts holes", async () => {
    let s = addRectangle(emptySketch(), 0, 0, 20, 10).sketch;
    const a = addPoint(s, 10, 0), b = addPoint(a.sketch, 10, 10);
    s = addLineBetween(b.sketch, a.ids[0], b.ids[0]).sketch;
    s = addCircle(s, 5, 5, 2).sketch;
    const r = await extruded(s);
    expect(measureVolume(r.body!.shape)).toBeCloseTo((200 - Math.PI * 4) * 10, 0);
  });

  it("extrudes a rectangle with an arc bump ending on two edges", async () => {
    const rect = addRectangle(emptySketch(), -10, -3, 3, 7);
    const circle = addCircle(rect.sketch, 3, 0, 3.2766);
    const t = trimCurve(circle.sketch, circle.ids[0], 1, 0);
    if ("error" in t) throw new Error(t.error);
    const r = await extruded(t.sketch);
    expect(measureVolume(r.body!.shape)).toBeGreaterThan(1300);
  });
});
