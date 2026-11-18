import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { addRectangle } from "../sketch/builders";
import { emptySketch } from "../sketch/model";
import { makeExtrude, makePlane, makeSketch, makeSketchOnPlane } from "../model/doc";
import type { Document, PlaneFeature } from "../model/types";
import { evaluate } from "./evaluate";
import { nameEdges } from "./naming";
import { validateDocument } from "../io/fileFormat";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

/** 40 x 30 x 20 block: x -20..20, y -15..15, z 0..20. */
async function block() {
  const doc: Document = { variables: [], features: [] };
  const rect = addRectangle(emptySketch(), -20, -15, 20, 15);
  const s = makeSketch(doc, "XY", 0, rect.sketch);
  const ex = { ...makeExtrude(doc, s.id, "new"), distance: 20 };
  doc.features.push(s, ex);
  const r = await evaluate(doc);
  const edges = [...nameEdges(r.body!.shape, r.body!.names).byName];
  return { doc, ex, rect, edges };
}

async function plane(doc: Document, init: Partial<PlaneFeature>) {
  const p = makePlane(doc, init);
  const r = await evaluate({ ...doc, features: [...doc.features, p] });
  return { p, r, plane: r.planes.find((x) => x.id === p.id), error: r.status.at(-1)!.error };
}

describe("construction planes", () => {
  it("offsets from a face, and a sketch on it extrudes from there", async () => {
    const { doc, ex } = await block();
    const { p, plane: pl } = await plane(doc, { mode: "offset", face: `${ex.id}:end`, distance: 5 });
    expect(pl!.center[2]).toBeCloseTo(25, 6);
    expect(Math.abs(pl!.frame.n[2])).toBeCloseTo(1, 9);
    const sk = { ...makeSketchOnPlane(doc, p.id), sketch: addRectangle(emptySketch(), -5, -5, 5, 5).sketch };
    const box = { ...makeExtrude(doc, sk.id, "new"), distance: 3 };
    const r = await evaluate({ ...doc, features: [...doc.features, p, sk, box] });
    expect(r.status.every((s) => s.ok)).toBe(true);
    const lid = r.bodies.find((b) => b.id === box.id)!.shape.shape.boundingBox.bounds;
    expect(lid[0][2]).toBeCloseTo(25, 4);
    expect(lid[1][2]).toBeCloseTo(28, 4);
  });

  it("offsets a standard plane", async () => {
    const { doc } = await block();
    const { plane: pl } = await plane(doc, { mode: "offset", base: "XZ", distance: 7 });
    expect(pl!.frame.n).toEqual([0, -1, 0]);
    expect(pl!.center[1]).toBeCloseTo(-7, 9);
  });

  it("finds the midplane of two parallel faces", async () => {
    const { doc, ex, rect } = await block();
    const { plane: pl } = await plane(doc, { mode: "midplane", face: `${ex.id}:start`, face2: `${ex.id}:end` });
    expect(pl!.center[2]).toBeCloseTo(10, 6);
    const { error } = await plane(doc, { mode: "midplane", face: `${ex.id}:start`, face2: `${ex.id}:side:${rect.ids[0]}` });
    expect(error).toMatch(/aren't parallel/);
  });

  it("turns about a straight edge of a face", async () => {
    const { doc, ex, edges } = await block();
    // The top edge along X at y = 15.
    const [hinge] = edges.find(([n, x]) => n.includes(`${ex.id}:end`) && Math.abs(x.startPoint.y - 15) < 1e-6 && Math.abs(x.endPoint.y - 15) < 1e-6)!;
    const { plane: pl } = await plane(doc, { mode: "angle", face: `${ex.id}:end`, edge: hinge, angle: 90 });
    // Turned a quarter: vertical, through the hinge.
    expect(Math.abs(pl!.frame.n[2])).toBeLessThan(1e-9);
    expect(Math.abs(pl!.frame.n[1])).toBeCloseTo(1, 9);
    expect(pl!.center[1]).toBeCloseTo(15, 6);
    expect(pl!.center[2]).toBeCloseTo(20, 6);
  });

  it("cuts across an edge, at a position along it", async () => {
    const { doc, ex, edges } = await block();
    const [vertical] = edges.find(([n, x]) => n.includes(":side:") && !n.includes(`${ex.id}:end`) && !n.includes(`${ex.id}:start`) && Math.abs(x.startPoint.z - x.endPoint.z) > 1)!;
    const { plane: pl } = await plane(doc, { mode: "normal", edge: vertical, position: 0.5 });
    expect(Math.abs(pl!.frame.n[2])).toBeCloseTo(1, 9);
    expect(pl!.center[2]).toBeCloseTo(10, 6);
  });

  it("fails clearly, and sketches on a missing plane fail too", async () => {
    const { doc } = await block();
    expect((await plane(doc, { mode: "angle" })).error).toMatch(/planar face and a straight edge/);
    const p = { ...makePlane(doc, { mode: "offset", distance: 5 }), suppressed: true };
    const sk = makeSketchOnPlane(doc, p.id);
    const r = await evaluate({ ...doc, features: [...doc.features, p, sk] });
    expect(r.status.at(-1)!.error).toMatch(/construction plane/);
  });

  it("is valid in the file format", async () => {
    const { doc, ex } = await block();
    const p = makePlane(doc, { mode: "offset", face: `${ex.id}:end`, distance: 5 });
    const sk = makeSketchOnPlane(doc, p.id);
    const parsed = validateDocument(JSON.parse(JSON.stringify({ ...doc, features: [...doc.features, p, sk] })));
    expect(parsed.features.at(-1)).toMatchObject({ type: "sketch", planeId: p.id });
    expect(() => validateDocument({ ...doc, features: [...doc.features, sk] })).toThrow(/plane that doesn't precede/);
  });
});
