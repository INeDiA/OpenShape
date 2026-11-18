import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { addRectangle } from "../sketch/builders";
import { emptySketch } from "../sketch/model";
import { makeExtrude, makeSketch } from "../model/doc";
import type { Document } from "../model/types";
import { evaluate, meshBody } from "../kernel/evaluate";
import { findThinWalls } from "./thinwalls";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

/** A 40 x 20 x 5 base with a 0.6 mm thick, 10 mm tall fin on top along X. */
async function finned(fin = 0.6) {
  const doc: Document = { variables: [], features: [] };
  const base = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), 0, 0, 40, 20).sketch);
  doc.features.push(base, { ...makeExtrude(doc, base.id, "new"), distance: 5 });
  const f = makeSketch(doc, "XY", 5, addRectangle(emptySketch(), 5, 10, 35, 10 + fin).sketch);
  doc.features.push(f, { ...makeExtrude(doc, f.id, "join"), distance: 10 });
  const r = await evaluate(doc);
  return meshBody(r.body!, r.faceBody);
}

describe("thin walls", () => {
  it("marks both sides of a fin thinner than the limit, and nothing else", async () => {
    const t = findThinWalls(await finned(0.6), 0.8);
    expect(t.min).toBeCloseTo(0.6, 3);
    // Two 30 x 10 sides, plus the fin's 0.6-wide top and ends (thin across too).
    expect(t.area).toBeGreaterThan(600 - 1);
    expect(t.area).toBeLessThan(600 + 2 * 0.6 * 10 + 30 * 0.6 + 1);
    for (let i = 2; i < t.positions.length; i += 3) expect(t.positions[i]).toBeGreaterThanOrEqual(5 - 1e-6);
  });

  it("finds nothing when every wall is thick enough", async () => {
    const t = findThinWalls(await finned(2), 0.8);
    expect(t.area).toBe(0);
    expect(t.min).toBe(Infinity);
  });

  it("is quick on a real mesh", async () => {
    const m = await finned(0.6);
    const start = performance.now();
    findThinWalls(m, 0.8);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
