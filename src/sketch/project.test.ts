import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { addCircle, addRectangle } from "./builders";
import { emptySketch } from "./model";
import { makeEdgeTreatment, makeExtrude, makeSketch } from "../model/doc";
import type { Document } from "../model/types";
import { evaluate, meshBody } from "../kernel/evaluate";
import { standardFrame } from "../model/frame";
import { addProjected, classify, distanceTo, projectEdges } from "./project";
import { findLoops } from "./profiles";
import { loadSolver, solve } from "./solver";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
  setOC(await opencascade({ locateFile: () => wasm }));
  await loadSolver(fileURLToPath(new URL("../../node_modules/@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm", import.meta.url)));
}, 60_000);

/** 40 x 30 x 20 block (centred on the origin in XY) with a Ø 10 hole through it at (8, 0). */
async function block(fillet = false) {
  const doc: Document = { variables: [], features: [] };
  const r = addRectangle(emptySketch(), -20, -15, 20, 15);
  const s = makeSketch(doc, "XY", 0, addCircle(r.sketch, 8, 0, 5).sketch);
  const ex = { ...makeExtrude(doc, s.id, "new"), distance: 20 };
  doc.features.push(s, ex);
  if (fillet) {
    // A vertical corner of the outline: between two of its side faces.
    const res = await evaluate(doc);
    const m = meshBody(res.body!, res.faceBody);
    const corner = m.edgeNames.find((n) => n.split("|").length === 2 && n.split("|").every((f) => f.includes(":side:l")))!;
    doc.features.push({ ...makeEdgeTreatment(doc, "fillet"), edges: [corner], size: 4 });
  }
  const res = await evaluate(doc);
  return meshBody(res.body!, res.faceBody);
}

describe("project", () => {
  it("sees a block from above as its outline and the hole, once each", async () => {
    const p = projectEdges(await block(), standardFrame("XY"));
    expect(p.filter((c) => c.kind === "line")).toHaveLength(4);
    const circles = p.filter((c) => c.kind === "circle");
    expect(circles).toHaveLength(1);
    expect(circles[0]).toMatchObject({ kind: "circle", c: { x: expect.closeTo(8, 3), y: expect.closeTo(0, 3) }, r: expect.closeTo(5, 2) });
  });

  it("sees the hole's circles side-on as lines", async () => {
    const p = projectEdges(await block(), standardFrame("XZ"));
    expect(p.every((c) => c.kind === "line")).toBe(true);
    // Outline (4) plus the two hole circles seen edge-on.
    expect(p).toHaveLength(6);
  });

  it("recognises arcs and keeps their direction counter-clockwise", () => {
    const pts = Array.from({ length: 9 }, (_, i) => ({ x: 3 * Math.cos(Math.PI / 2 - (i * Math.PI) / 16), y: 3 * Math.sin(Math.PI / 2 - (i * Math.PI) / 16) }));
    const c = classify("e", pts, 1e-4)!; // drawn clockwise
    expect(c.kind).toBe("arc");
    if (c.kind !== "arc") return;
    expect(c.r).toBeCloseTo(3, 6);
    expect(c.a.y).toBeCloseTo(pts[8].y, 9); // starts where the clockwise samples ended
    expect(distanceTo(c, { x: 3 * Math.cos(1.3), y: 3 * Math.sin(1.3) })).toBeLessThan(1e-6);
  });

  it("adds a joined, fixed outline that the solver keeps and that makes a profile", async () => {
    const p = projectEdges(await block(true), standardFrame("XY"));
    expect(p.some((c) => c.kind === "arc")).toBe(true);
    const { sketch, ids } = addProjected(emptySketch(), p);
    expect(ids).toHaveLength(p.length);
    const r = solve(sketch);
    expect(r.ok).toBe(true);
    expect(r.dof).toBe(0);
    // Same positions after solving.
    for (const e of sketch.entities) {
      if (e.kind !== "point") continue;
      const after = r.sketch.entities.find((x) => x.id === e.id)!;
      if (after.kind === "point") expect(Math.hypot(after.x - e.x, after.y - e.y)).toBeLessThan(1e-6);
    }
    const loops = findLoops(r.sketch);
    expect(loops.loops.length).toBe(2); // outline and hole
    // Projecting again adds nothing.
    const again = addProjected(r.sketch, p);
    expect(again.ids).toHaveLength(0);
    expect(again.sketch.entities).toHaveLength(r.sketch.entities.length);
  });
});
