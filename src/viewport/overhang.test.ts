import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { addRectangle } from "../sketch/builders";
import { emptySketch } from "../sketch/model";
import { makeExtrude, makeLoft, makeSketch } from "../model/doc";
import type { Document } from "../model/types";
import { evaluate, meshBody } from "../kernel/evaluate";
import { findOverhangs } from "./overhang";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

/** A 20 x 20 x 10 post with a 40 x 20 x 4 plate on top, sticking out 10 mm on each side. */
async function tee() {
  const doc: Document = { variables: [], features: [] };
  const post = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), 0, 0, 20, 20).sketch);
  doc.features.push(post, { ...makeExtrude(doc, post.id, "new"), distance: 10 });
  const plate = makeSketch(doc, "XY", 10, addRectangle(emptySketch(), -10, 0, 30, 20).sketch);
  doc.features.push(plate, { ...makeExtrude(doc, plate.id, "join"), distance: 4 });
  const r = await evaluate(doc);
  return meshBody(r.body!, r.faceBody);
}

describe("overhangs", () => {
  it("finds the plate's underside but not the bottom on the bed", async () => {
    const o = findOverhangs(await tee(), 45);
    // Two 10 x 20 undersides; the post's bottom (on the bed) doesn't count.
    expect(o.area).toBeCloseTo(400, 3);
    for (let i = 2; i < o.positions.length; i += 3) expect(o.positions[i]).toBeCloseTo(10, 6);
  });

  it("ignores vertical walls whatever the angle, and finds nothing on a plain block", async () => {
    const doc: Document = { variables: [], features: [] };
    const s = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), 0, 0, 20, 20).sketch);
    doc.features.push(s, { ...makeExtrude(doc, s.id, "new"), distance: 10 });
    const r = await evaluate(doc);
    expect(findOverhangs(meshBody(r.body!, r.faceBody), 80).area).toBe(0);
  });

  it("judges sloped faces by the printer's limit", async () => {
    // Upside-down frustum: 20 x 20 on the bed, 30 x 30 at z = 10; the sides lean 26.6° out.
    const doc: Document = { variables: [], features: [] };
    const a = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), -10, -10, 10, 10).sketch);
    const b = makeSketch(doc, "XY", 10, addRectangle(emptySketch(), -15, -15, 15, 15).sketch);
    doc.features.push(a, b, { ...makeLoft(doc, [a.id, b.id], "new"), ruled: true });
    const r = await evaluate(doc);
    const m = meshBody(r.body!, r.faceBody);
    expect(findOverhangs(m, 45).area).toBe(0);
    const side = Math.hypot(10, 5) * 25;
    expect(findOverhangs(m, 20).area).toBeCloseTo(4 * side, 2);
    // Horizontal undersides need support at any limit.
    expect(findOverhangs(await tee(), 80).area).toBeCloseTo(400, 3);
  });
});
