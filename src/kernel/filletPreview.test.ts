import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { addRectangle } from "../sketch/builders";
import { emptySketch } from "../sketch/model";
import { makeEdgeTreatment, makeExtrude, makeSketch } from "../model/doc";
import type { Document } from "../model/types";
import { evaluate, meshBody } from "./evaluate";
import { bodyContaining, faceAnchor, filletPreview, refilletPreview, splitPair } from "../viewport/meshGeom";

const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
beforeAll(async () => {
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

describe("fillet preview", () => {
  it("draws the rounding arc inside a convex edge", async () => {
    // 40 x 30 x 20 block; its top edges are convex 90° edges.
    const doc: Document = { variables: [], features: [] };
    const s = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), -20, -15, 20, 15).sketch);
    doc.features.push(s, { ...makeExtrude(doc, s.id, "new"), distance: 20 });
    const r = await evaluate(doc);
    const mesh = meshBody(r.body!, r.faceBody);
    // The top edge along X at y = 15.
    const edge = mesh.edgeNames.find((n, i) => {
      if (!n.includes(":end")) return false;
      const g = mesh.edgeGroups[i];
      const ys = [], zs = [];
      for (let k = g.start; k < g.start + g.count; k++) {
        ys.push(mesh.edges[k * 3 + 1]);
        zs.push(mesh.edges[k * 3 + 2]);
      }
      return ys.every((y) => Math.abs(y - 15) < 1e-6) && zs.every((z) => Math.abs(z - 20) < 1e-6);
    })!;
    expect(edge).toBeDefined();
    const R = 4;
    const pos = filletPreview(mesh, [edge], R).arc;
    expect(pos.length).toBeGreaterThan(0);
    let maxDist = 0;
    for (let i = 0; i < pos.length; i += 3) {
      const y = pos[i + 1], z = pos[i + 2];
      // Inside the block, within R of the edge.
      expect(y).toBeLessThanOrEqual(15 + 1e-6);
      expect(z).toBeLessThanOrEqual(20 + 1e-6);
      maxDist = Math.max(maxDist, Math.hypot(15 - y, 20 - z));
    }
    // Arc ends lie on the faces at distance R from the edge; its middle is R(√2 − 1) from it.
    expect(maxDist).toBeCloseTo(R, 6);
    let minDist = Infinity;
    for (let i = 0; i < pos.length; i += 3) minDist = Math.min(minDist, Math.hypot(15 - pos[i + 1], 20 - pos[i + 2]));
    expect(minDist).toBeCloseTo(R * (Math.SQRT2 - 1), 1);
  });

  it("rebuilds the edge under an existing fillet and previews a new radius", async () => {
    const doc: Document = { variables: [], features: [] };
    const rect = addRectangle(emptySketch(), -20, -15, 20, 15);
    const s = makeSketch(doc, "XY", 0, rect.sketch);
    const ex = { ...makeExtrude(doc, s.id, "new"), distance: 20 };
    doc.features.push(s, ex);
    const fi = { ...makeEdgeTreatment(doc, "fillet"), size: 2 };
    doc.features.push(fi);
    const r = await evaluate(doc);
    const mesh = meshBody(r.body!, r.faceBody);
    // The blend on the top edge at y = 15 (rectangle line 3), and the edge it came from.
    const side = `${ex.id}:side:${rect.ids[2]}`;
    const blend = mesh.faceNames.find((n) => n.startsWith(`${fi.id}:blend:`) && n.includes(`${ex.id}:end`) && n.includes(side))!;
    expect(blend).toBeDefined();
    const edge = blend.slice(`${fi.id}:blend:`.length);
    const R = 4;
    const p = refilletPreview(mesh, blend, edge, R)!;
    expect(p).not.toBeNull();
    let maxDist = 0, minDist = Infinity;
    for (let i = 0; i < p.arc.length; i += 3) {
      const y = p.arc[i + 1], z = p.arc[i + 2];
      expect(y).toBeLessThanOrEqual(15 + 1e-6);
      expect(z).toBeLessThanOrEqual(20 + 1e-6);
      const dist = Math.hypot(15 - y, 20 - z);
      maxDist = Math.max(maxDist, dist);
      minDist = Math.min(minDist, dist);
    }
    // Measured from the rebuilt sharp edge (y = 15, z = 20), as for a fresh fillet.
    expect(maxDist).toBeCloseTo(R, 6);
    expect(minDist).toBeCloseTo(R * (Math.SQRT2 - 1), 1);
  });

  it("rounds every edge of a pushed-and-pulled block the right way", async () => {
    // A 40 x 30 x 20 block with a blind hole, two faces pushed out several times (a real user model).
    const rect = addRectangle(emptySketch(), -20, -15, 20, 15);
    const [bottom, right] = rect.ids;
    const doc: Document = { variables: [], features: [] };
    const s1 = makeSketch(doc, "XY", 0, rect.sketch);
    const ex = { ...makeExtrude(doc, s1.id, "new"), distance: 20 };
    doc.features.push(s1, ex);
    const pp = (id: string, face: string, distance: number) => ({ type: "pushpull" as const, id, name: id, suppressed: false, face, distance });
    doc.features.push(pp("pp1", `${ex.id}:side:${bottom}`, 1), pp("pp2", "pp1:end", 17), pp("pp3", "pp2:end", 11), pp("pp4", `${ex.id}:side:${right}`, 14));
    const r = await evaluate(doc);
    expect(r.status.every((x) => x.ok)).toBe(true);
    const mesh = meshBody(r.body!, r.faceBody);
    let checked = 0;
    for (const edge of mesh.edgeNames) {
      const [fa, fb] = splitPair(edge.replace(/#\d+$/, "").replace(/^\[|\]$/g, ""));
      const ia = mesh.faceNames.indexOf(fa), ib = mesh.faceNames.indexOf(fb);
      if (ia < 0 || ib < 0 || !mesh.facePlanar[ia] || !mesh.facePlanar[ib]) continue;
      const A = faceAnchor(mesh, fa)!, B = faceAnchor(mesh, fb)!;
      if (Math.abs(A.n[0] * B.n[0] + A.n[1] * B.n[1] + A.n[2] * B.n[2]) > 0.999) continue;
      const p = filletPreview(mesh, [edge], 1, 2);
      // With 2 steps, the arc's middle point at both ends of the first segment is a0[1] (floats 18..20)
      // and a1[1] (floats 6..8): halfway between them is mid-arc, mid-segment. Inside the solid on a
      // convex edge (all of them here).
      const mid = [0, 1, 2].map((k) => (p.arc[18 + k] + p.arc[6 + k]) / 2) as [number, number, number];
      expect(bodyContaining(mesh, mid), edge).not.toBeNull();
      checked++;
    }
    expect(checked).toBeGreaterThanOrEqual(12);
  });
});
