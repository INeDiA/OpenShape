import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { addCircle, addLineBetween, addPoint, addRectangle } from "../sketch/builders";
import { emptySketch, type SketchData } from "../sketch/model";
import { sketchRegions } from "../sketch/profiles";
import { makeExtrude, makeRevolve, makeSketch } from "../model/doc";
import { defaultAxisLine } from "../sketch/model";
import type { Document } from "../model/types";
import { evaluate, meshBody } from "./evaluate";
import { autoOperation } from "../ui/useManipulation";

const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
beforeAll(async () => {
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

/** 40 x 20 rectangle with circles of radius 4 at (-10, 0) and (10, 0). */
function plate(): { sketch: SketchData; left: string; right: string; rectId: string } {
  const rect = addRectangle(emptySketch(), -20, -10, 20, 10);
  const a = addCircle(rect.sketch, -10, 0, 4);
  const b = addCircle(a.sketch, 10, 0, 4);
  return { sketch: b.sketch, left: a.ids[0], right: b.ids[0], rectId: [...rect.ids].sort().join("+") };
}

async function extrudeRegions(sketch: SketchData, regions?: string[]) {
  const doc: Document = { variables: [], features: [] };
  const s = makeSketch(doc, "XY", 0, sketch);
  doc.features.push(s, { ...makeExtrude(doc, s.id, "new"), distance: 10, regions });
  return evaluate(doc);
}

describe("sketch regions", () => {
  it("lists a ring and two discs with stable ids", () => {
    const p = plate();
    const regions = sketchRegions(p.sketch);
    expect(regions.map((r) => r.id).sort()).toEqual([p.left, p.right, p.rectId].sort());
    const ring = regions.find((r) => r.id === p.rectId)!;
    expect(ring.holes).toHaveLength(2);
  });

  it("extrudes only the chosen regions", async () => {
    const p = plate();
    const disc = Math.PI * 16 * 10;
    const one = await extrudeRegions(p.sketch, [p.left]);
    expect(measureVolume(one.body!.shape)).toBeCloseTo(disc, 0);
    const ring = await extrudeRegions(p.sketch, [p.rectId]);
    expect(measureVolume(ring.body!.shape)).toBeCloseTo(800 * 10 - 2 * disc, 0);
    const ringAndDisc = await extrudeRegions(p.sketch, [p.rectId, p.right]);
    expect(measureVolume(ringAndDisc.body!.shape)).toBeCloseTo(800 * 10 - disc, 0);
    // No regions: the old even-odd behaviour (the plate with two holes).
    const all = await extrudeRegions(p.sketch);
    expect(measureVolume(all.body!.shape)).toBeCloseTo(800 * 10 - 2 * disc, 0);
  });

  it("keeps region ids when geometry moves, and reports a region that's gone", async () => {
    const p = plate();
    // Split the rectangle with a vertical line: the ring is no longer one region.
    const top = addPoint(p.sketch, 0, 10), bottom = addPoint(top.sketch, 0, -10);
    const split = addLineBetween(bottom.sketch, top.ids[0], bottom.ids[0]).sketch;
    expect(sketchRegions(split).map((r) => r.id)).toContain(p.left);
    const r = await extrudeRegions(split, [p.rectId]);
    const bad = r.status.find((s) => !s.ok);
    expect(bad?.error).toMatch(/no longer exists/);
  });

  it("picks cut, join or new body from where the extrusion goes", async () => {
    const doc: Document = { variables: [], features: [] };
    const s = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), -20, -15, 20, 15).sketch);
    const ex = { ...makeExtrude(doc, s.id, "new"), distance: 20 };
    doc.features.push(s, ex);
    const r = await evaluate(doc);
    const mesh = meshBody(r.body!, r.faceBody);
    const up: [number, number, number] = [0, 0, 1];
    // A region on the top face: down into the block cuts, up out of it joins.
    expect(autoOperation(mesh, [5, 5, 20], up, -8)).toEqual({ op: "cut", target: ex.id });
    expect(autoOperation(mesh, [5, 5, 20], up, 8)).toEqual({ op: "join", target: ex.id });
    // Away from the block: a new body.
    expect(autoOperation(mesh, [60, 0, 0], up, 8)).toEqual({ op: "new" });
    // On the bottom plane (z = 0) going up: into the block.
    expect(autoOperation(mesh, [0, 0, 0], up, 5).op).toBe("cut");
  });

  it("revolves a region around a line of its sketch", async () => {
    // 10 x 20 rectangle (x 0..10, y 0..20) turned around its left side: a cylinder of radius 10.
    const rect = addRectangle(emptySketch(), 0, 0, 10, 20);
    const left = rect.ids[3]; // (0, 20) -> (0, 0)
    const doc: Document = { variables: [], features: [] };
    const sk = makeSketch(doc, "XY", 0, rect.sketch);
    const region = sketchRegions(rect.sketch)[0].id;
    const rv = { ...makeRevolve(doc, sk.id, "new"), regions: [region], axisLine: left, angle: 360 };
    doc.features.push(sk, rv);
    const full = await evaluate(doc);
    expect(full.status.every((x) => x.ok)).toBe(true);
    expect(measureVolume(full.body!.shape)).toBeCloseTo(Math.PI * 100 * 20, 0);
    doc.features[1] = { ...rv, angle: 90 };
    expect(measureVolume((await evaluate(doc)).body!.shape)).toBeCloseTo((Math.PI * 100 * 20) / 4, 0);
    // Without construction lines the default axis is the longest line (a 20 mm side).
    const axis = defaultAxisLine(rect.sketch)!;
    expect([rect.ids[1], rect.ids[3]]).toContain(axis);
  });
});
