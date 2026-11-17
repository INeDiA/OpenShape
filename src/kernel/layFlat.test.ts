import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { addCircle, addRectangle } from "../sketch/builders";
import { emptySketch } from "../sketch/model";
import { makeExtrude, makeLayFlat, makeSketch } from "../model/doc";
import type { Document } from "../model/types";
import { evaluate } from "./evaluate";
import { faceSamples } from "./naming";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

/** 40 x 30 x 20 block (x -20..20, y -15..15) with a blind hole r8, 12 deep, in the top. */
function block() {
  const doc: Document = { variables: [], features: [] };
  const rect = addRectangle(emptySketch(), -20, -15, 20, 15);
  const s = makeSketch(doc, "XY", 0, rect.sketch);
  const ex = { ...makeExtrude(doc, s.id, "new"), distance: 20 };
  const h = makeSketch(doc, "XY", 20, addCircle(emptySketch(), 0, 0, 8).sketch);
  const hole = { ...makeExtrude(doc, h.id, "cut"), distance: -12 };
  doc.features.push(s, ex, h, hole);
  return { doc, ex, hole, rect };
}

async function layOn(doc: Document, face: string) {
  const r = await evaluate({ ...doc, features: [...doc.features, makeLayFlat(doc, face)] });
  const shape = r.body!.shape;
  const [lo, hi] = shape.boundingBox.bounds;
  const f = shape.faces.find((x) => r.body!.names.get(x.hashCode) === face)!;
  const sample = faceSamples(shape).get(f.hashCode)!;
  return { r, lo, hi, sample, volume: measureVolume(shape) };
}

describe("lay flat", () => {
  it("puts a side face on the bed, facing down", async () => {
    const { doc, ex, rect } = block();
    const before = measureVolume((await evaluate(doc)).body!.shape);
    // The side at y = 15 (rectangle line 3).
    const { r, lo, hi, sample, volume } = await layOn(doc, `${ex.id}:side:${rect.ids[2]}`);
    expect(r.status.every((s) => s.ok)).toBe(true);
    expect(lo[2]).toBeCloseTo(0, 5);
    expect(hi[2] - lo[2]).toBeCloseTo(30, 5); // the 30 mm depth is now the height
    expect(sample.n[2]).toBeCloseTo(-1, 6);
    expect(sample.p[2]).toBeCloseTo(0, 5);
    expect(volume).toBeCloseTo(before, 4);
  });

  it("turns an upward face over", async () => {
    const { doc, ex } = block();
    const { lo, hi, sample } = await layOn(doc, `${ex.id}:end`);
    expect(hi[2] - lo[2]).toBeCloseTo(20, 5);
    expect(sample.n[2]).toBeCloseTo(-1, 6);
    expect(sample.p[2]).toBeCloseTo(0, 5);
  });

  it("warns when the face can't touch the bed", async () => {
    const { doc, hole } = block();
    // The hole's floor faces up; turned down it sits 12 mm up inside the hole.
    const { r } = await layOn(doc, `${hole.id}:end`);
    expect(r.status.at(-1)!.error).toMatch(/12\.00 mm above/);
  });
});
