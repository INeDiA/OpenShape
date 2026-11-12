import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { addCircle, addRectangle } from "../sketch/builders";
import { emptySketch } from "../sketch/model";
import { makeExtrude, makeSketch } from "../model/doc";
import type { Document } from "../model/types";
import { evaluate } from "./evaluate";
import { projectView } from "./projection";

const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
beforeAll(async () => {
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

/** 40 x 30 x 20 block with a blind hole r8, 12 deep, in the top. */
async function block() {
  const doc: Document = { variables: [], features: [] };
  const s = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), -20, -15, 20, 15).sketch);
  doc.features.push(s, { ...makeExtrude(doc, s.id, "new"), distance: 20 });
  const h = makeSketch(doc, "XY", 20, addCircle(emptySketch(), 0, 0, 8).sketch);
  doc.features.push(h, { ...makeExtrude(doc, h.id, "cut"), distance: -12 });
  return (await evaluate(doc)).body!.shape;
}

describe("view projection", () => {
  it("front view: the block's outline, the hole hidden", async () => {
    const v = projectView(await block(), "front");
    expect(v.bounds!.minX).toBeCloseTo(-20, 4);
    expect(v.bounds!.maxX).toBeCloseTo(20, 4);
    expect(v.bounds!.minY).toBeCloseTo(0, 4);
    expect(v.bounds!.maxY).toBeCloseTo(20, 4);
    expect(v.visible.length).toBeGreaterThan(0);
    // The hole's walls (x = ±8) and bottom (y = 8) are behind the front face.
    expect(v.hidden.length).toBeGreaterThan(0);
    const hx: number[] = [];
    for (let i = 0; i < v.hidden.length; i += 2) hx.push(v.hidden[i]);
    expect(hx.some((x) => Math.abs(Math.abs(x) - 8) < 1e-3)).toBe(true);
    // Corners of the outline are snap points.
    expect(v.points.some(([x, y]) => Math.abs(x - 20) < 1e-4 && Math.abs(y - 20) < 1e-4)).toBe(true);
  });

  it("top view: the hole is a circle with its centre as a snap point", async () => {
    const v = projectView(await block(), "top");
    expect(v.bounds!.minY).toBeCloseTo(-15, 4);
    expect(v.bounds!.maxY).toBeCloseTo(15, 4);
    expect(v.circles.some((c) => Math.abs(c.r - 8) < 1e-3 && Math.hypot(c.cx, c.cy) < 1e-3)).toBe(true);
    expect(v.points.some(([x, y]) => Math.hypot(x, y) < 1e-3)).toBe(true);
  });

  it("right view looks along -X with Y to the right", async () => {
    const v = projectView(await block(), "right");
    expect(v.bounds!.minX).toBeCloseTo(-15, 4);
    expect(v.bounds!.maxX).toBeCloseTo(15, 4);
    expect(v.bounds!.maxY).toBeCloseTo(20, 4);
  });
});
