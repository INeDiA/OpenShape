import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { addCircle, addRectangle } from "../sketch/builders";
import { emptySketch } from "../sketch/model";
import { makeCove, makeExtrude, makeSketch } from "../model/doc";
import type { Document, ExtrudeFeature } from "../model/types";
import { evaluate } from "./evaluate";
import { nameEdges } from "./naming";
import { meshBody } from "./evaluate";
import { covePreview, filletPreview } from "../viewport/meshGeom";

const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
beforeAll(async () => {
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

/** 40 x 30 x 20 block, optionally with a blind hole of radius 8 and depth 12 in the top. */
async function block(hole = false) {
  const doc: Document = { variables: [], features: [] };
  const rect = addRectangle(emptySketch(), -20, -15, 20, 15);
  const s = makeSketch(doc, "XY", 0, rect.sketch);
  const ex: ExtrudeFeature = { ...makeExtrude(doc, s.id, "new"), distance: 20 };
  doc.features.push(s, ex);
  if (hole) {
    const h = makeSketch(doc, "XY", 20, addCircle(emptySketch(), 0, 0, 8).sketch);
    doc.features.push(h, { ...makeExtrude(doc, h.id, "cut"), distance: -12 });
  }
  const r = await evaluate(doc);
  return { doc, ex, rect, r, names: [...nameEdges(r.body!.shape, r.body!.names).byName.keys()] };
}

describe("cove", () => {
  it("cuts a quarter-round groove along a straight edge", async () => {
    const { doc, ex, rect, r, names } = await block();
    const before = measureVolume(r.body!.shape);
    // The 40 mm top edge at y = 15 (rectangle line 3).
    const edge = names.find((n) => n.includes(`${ex.id}:end`) && n.includes(`${ex.id}:side:${rect.ids[2]}`))!;
    const cv = makeCove(doc, [edge], 4);
    const after = await evaluate({ ...doc, features: [...doc.features, cv] });
    expect(after.status.every((s) => s.ok)).toBe(true);
    expect(before - measureVolume(after.body!.shape)).toBeCloseTo((Math.PI * 16 / 4) * 40, 3);
    const coveFaces = [...after.body!.names.values()].filter((n) => n.startsWith(`${cv.id}:cove:`));
    expect(coveFaces.length).toBeGreaterThan(0);
    expect(coveFaces.every((n) => n === `${cv.id}:cove:${edge}`)).toBe(true);
  });

  it("follows a circular edge as a torus", async () => {
    const { doc, ex, r, names } = await block(true);
    const before = measureVolume(r.body!.shape);
    // The hole's rim on the block's top face (not the one at the bottom of the hole).
    const holeExtrude = doc.features[3].id;
    const rims = names.filter((n) => n.includes(`${holeExtrude}:side:`) && n.includes(`${ex.id}:end`));
    expect(rims.length).toBeGreaterThan(0);
    const cv = makeCove(doc, rims, 2);
    const after = await evaluate({ ...doc, features: [...doc.features, cv] });
    expect(after.status.every((s) => s.ok)).toBe(true);
    // Pappus: a quarter disc of radius 2 (area π) whose centroid sits 8 + 8/(3π) from the axis.
    const expected = 2 * Math.PI * (8 + 8 / (3 * Math.PI)) * Math.PI;
    expect(before - measureVolume(after.body!.shape)).toBeCloseTo(expected, 1);
  });

  it("fails clearly when its edges are gone", async () => {
    const { doc } = await block();
    const cv = makeCove(doc, ["[nope:end|nope:side:x]"], 2);
    const r = await evaluate({ ...doc, features: [...doc.features, cv] });
    expect(r.status.find((s) => s.id === cv.id)?.error).toMatch(/no longer exist|exist anymore/);
  });

  it("previews a new radius on the edge rebuilt under the groove", async () => {
    const { doc, ex, rect, names } = await block();
    const edge = names.find((n) => n.includes(`${ex.id}:end`) && n.includes(`${ex.id}:side:${rect.ids[2]}`))!;
    const cv = makeCove(doc, [edge], 2);
    const r = await evaluate({ ...doc, features: [...doc.features, cv] });
    const mesh = meshBody(r.body!, r.faceBody);
    const faces = mesh.faceNames.filter((n) => n.startsWith(`${cv.id}:cove:`));
    const p = covePreview(mesh, faces, edge, 4)!;
    expect(p).not.toBeNull();
    for (let i = 0; i < p.arc.length; i += 3) {
      const y = p.arc[i + 1], z = p.arc[i + 2];
      // On the circle of radius 4 around the original edge (y = 15, z = 20), inside the block.
      expect(Math.hypot(15 - y, 20 - z)).toBeCloseTo(4, 6);
      expect(y).toBeLessThanOrEqual(15 + 1e-6);
      expect(z).toBeLessThanOrEqual(20 + 1e-6);
    }
  });

  it("previews a new radius on a circular edge (the rim of a hole)", async () => {
    const { doc, ex, names } = await block(true);
    const holeExtrude = doc.features[3].id;
    const rim = names.find((n) => n.includes(`${holeExtrude}:side:`) && n.includes(`${ex.id}:end`))!;
    const cv = makeCove(doc, [rim], 2);
    const r = await evaluate({ ...doc, features: [...doc.features, cv] });
    const mesh = meshBody(r.body!, r.faceBody);
    const faces = mesh.faceNames.filter((n) => n.startsWith(`${cv.id}:cove:`));
    expect(covePreview(mesh, faces, rim, 3)).toBeNull(); // without the current radius it can't rebuild the rim
    const p = covePreview(mesh, faces, rim, 3, 8, 2)!;
    expect(p.arc.length).toBeGreaterThan(0);
    for (let i = 0; i < p.arc.length; i += 3) {
      const rho = Math.hypot(p.arc[i], p.arc[i + 1]), z = p.arc[i + 2];
      // On the tube of radius 3 around the rim (circle of radius 8 at z = 20), in the material.
      expect(Math.hypot(rho - 8, z - 20)).toBeCloseTo(3, 1);
      expect(rho).toBeGreaterThan(8 - 0.05);
      expect(z).toBeLessThan(20 + 0.05);
    }
  });

  it("previews a fillet on a circular edge with the local normals of the curved face", async () => {
    const { doc, ex, r, names } = await block(true);
    const holeExtrude = doc.features[3].id;
    const rim = names.find((n) => n.includes(`${holeExtrude}:side:`) && n.includes(`${ex.id}:end`))!;
    const mesh = meshBody(r.body!, r.faceBody);
    const p = filletPreview(mesh, [rim], 2);
    expect(p.arc.length).toBeGreaterThan(0);
    for (let i = 0; i < p.arc.length; i += 3) {
      const rho = Math.hypot(p.arc[i], p.arc[i + 1]), z = p.arc[i + 2];
      // Rolling-ball centre on the circle rho = 10, z = 18.
      expect(Math.hypot(rho - 10, z - 18)).toBeCloseTo(2, 1);
    }
  });
});
