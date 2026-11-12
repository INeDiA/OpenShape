import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { addCircle, addRectangle } from "../sketch/builders";
import { emptySketch, type SketchData } from "../sketch/model";
import { makeExtrude, makeSketch } from "../model/doc";
import type { Document, MeasureRow } from "../model/types";
import { evaluate } from "./evaluate";
import { circle3, measureSelection } from "./measure";
import { nameEdges } from "./naming";

const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
beforeAll(async () => {
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

async function model(sketch: SketchData, distance: number) {
  const doc: Document = { variables: [], features: [] };
  const s = makeSketch(doc, "XY", 0, sketch);
  const ex = { ...makeExtrude(doc, s.id, "new"), distance };
  doc.features.push(s, ex);
  return { result: await evaluate(doc), ex };
}
const val = (rows: MeasureRow[], label: string) => {
  const r = rows.find((x) => x.label === label);
  if (!r) throw new Error(`no ${label} in ${JSON.stringify(rows)}`);
  return "value" in r ? r.value : r.text;
};
const none = { faces: [], edges: [], body: null };

describe("measure", () => {
  it("finds the circle through three points", () => {
    const c = circle3([5, 0, 1], [0, 5, 1], [-5, 0, 1])!;
    expect(c.r).toBeCloseTo(5, 9);
    expect(c.center.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([0, 0, 1]);
  });

  it("measures a body, a face, an edge and a pair of faces", async () => {
    const { result, ex } = await model(addRectangle(emptySketch(), -20, -15, 20, 15).sketch, 20);
    const body = measureSelection(result, { ...none, body: ex.id });
    expect(val(body.rows, "Volume")).toBeCloseTo(24000, 3);
    expect(val(body.rows, "Surface area")).toBeCloseTo(2 * (1200 + 800 + 600), 3);
    expect(val(body.rows, "Size")).toBe("40 × 30 × 20 mm");

    const top = measureSelection(result, { ...none, faces: [`${ex.id}:end`] });
    expect(val(top.rows, "Area")).toBeCloseTo(1200, 6);
    expect(val(top.rows, "Normal")).toBe("0, 0, 1");

    const pair = measureSelection(result, { ...none, faces: [`${ex.id}:start`, `${ex.id}:end`] });
    expect(val(pair.rows, "Distance")).toBeCloseTo(20, 6);
    expect(val(pair.rows, "Angle")).toBeCloseTo(0, 6);
    expect(val(pair.rows, "Gap along normal")).toBeCloseTo(20, 6);

    const names = [...nameEdges(result.body!.shape, result.body!.names).byName.keys()];
    const topEdges = names.filter((n) => n.includes(`${ex.id}:end`));
    expect(topEdges).toHaveLength(4);
    const lengths = topEdges.map((n) => val(measureSelection(result, { ...none, edges: [n] }).rows, "Length") as number).sort((a, b) => a - b);
    expect(lengths.map(Math.round)).toEqual([30, 30, 40, 40]);
    const total = measureSelection(result, { ...none, edges: topEdges });
    expect(val(total.rows, "Total length (4 edges)")).toBeCloseTo(140, 6);
  });

  it("gives radius and diameter of round faces and edges, and angles between faces", async () => {
    const { result, ex } = await model(addCircle(emptySketch(), 0, 0, 5).sketch, 10);
    const sides = [...result.body!.names.values()].filter((n) => n.includes(":side:"));
    const cyl = measureSelection(result, { ...none, faces: [sides[0]] });
    expect(cyl.title).toBe("Face (cylinder)");
    expect(val(cyl.rows, "Radius")).toBeCloseTo(5, 6);
    const rim = [...nameEdges(result.body!.shape, result.body!.names).byName.keys()].find((n) => n.includes(`${ex.id}:end`))!;
    const e = measureSelection(result, { ...none, edges: [rim] });
    expect(val(e.rows, "Diameter")).toBeCloseTo(10, 6);
    // The rim comes as two half circles: one edge is half the circumference.
    expect(val(e.rows, "Length")).toBeCloseTo(Math.PI * 5, 6);

    const { result: box, ex: bx } = await model(addRectangle(emptySketch(), 0, 0, 10, 10).sketch, 10);
    const side = [...box.body!.names.values()].find((n) => n.includes(":side:"))!;
    const perp = measureSelection(box, { ...none, faces: [`${bx.id}:end`, side] });
    expect(val(perp.rows, "Angle")).toBeCloseTo(90, 6);
    expect(val(perp.rows, "Distance")).toBeCloseTo(0, 6);
  });
});
