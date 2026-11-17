import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { addRectangle } from "../sketch/builders";
import { emptySketch } from "../sketch/model";
import { makeBoolean, makeExtrude, makeSketch } from "../model/doc";
import type { BooleanFeature, Document } from "../model/types";
import { evaluate } from "./evaluate";
import { validateDocument } from "../io/fileFormat";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

/** Two separate bodies: a 20 x 20 x 20 cube at the origin and the same cube moved 10 along X (half overlapping). */
function twoCubes() {
  const doc: Document = { variables: [], features: [] };
  const a = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), 0, 0, 20, 20).sketch);
  const ea = { ...makeExtrude(doc, a.id, "new"), distance: 20 };
  doc.features.push(a, ea);
  const b = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), 10, 0, 30, 20).sketch);
  const eb = { ...makeExtrude(doc, b.id, "new"), distance: 20 };
  doc.features.push(b, eb);
  return { doc, a: ea.id, b: eb.id };
}

async function run(doc: Document, f: BooleanFeature) {
  return evaluate({ ...doc, features: [...doc.features, f] });
}

describe("Boolean between bodies", () => {
  it("joins two bodies into the target", async () => {
    const { doc, a, b } = twoCubes();
    expect((await evaluate(doc)).bodies.length).toBe(2);
    const r = await run(doc, { ...makeBoolean(doc, a, "join"), tools: [b] });
    expect(r.status.every((s) => s.ok)).toBe(true);
    expect(r.bodies.map((x) => x.id)).toEqual([a]);
    expect(measureVolume(r.body!.shape)).toBeCloseTo(30 * 20 * 20, 3);
  });

  it("subtracts the tool, or intersects", async () => {
    const { doc, a, b } = twoCubes();
    const cut = await run(doc, { ...makeBoolean(doc, a, "cut"), tools: [b] });
    expect(measureVolume(cut.body!.shape)).toBeCloseTo(10 * 20 * 20, 3);
    const common = await run(doc, { ...makeBoolean(doc, a, "intersect"), tools: [b] });
    expect(measureVolume(common.body!.shape)).toBeCloseTo(10 * 20 * 20, 3);
    expect(common.bodies.length).toBe(1);
  });

  it("leaves a clearance around the tools when subtracting", async () => {
    const { doc, a, b } = twoCubes();
    const r = await run(doc, { ...makeBoolean(doc, a, "cut"), tools: [b], clearance: 0.5 });
    expect(r.status.every((s) => s.ok)).toBe(true);
    // The pocket is 0.5 wider on the cut side: 9.5 of the cube's 20 mm is left along X.
    // The tool grown by 0.5 also overhangs the cube's other faces, which removes nothing there.
    expect(measureVolume(r.body!.shape)).toBeCloseTo(9.5 * 20 * 20, 2);
    const [lo, hi] = r.body!.shape.boundingBox.bounds;
    expect(lo[0]).toBeCloseTo(0, 6);
    expect(hi[0]).toBeCloseTo(9.5, 4);
  });

  it("can keep the tool bodies", async () => {
    const { doc, a, b } = twoCubes();
    const r = await run(doc, { ...makeBoolean(doc, a, "cut"), tools: [b], keepTools: true });
    expect(r.bodies.map((x) => x.id).sort()).toEqual([a, b].sort());
  });

  it("names the faces after the bodies they come from", async () => {
    const { doc, a, b } = twoCubes();
    const r = await run(doc, { ...makeBoolean(doc, a, "join"), tools: [b] });
    const names = [...r.body!.names.values()];
    expect(names.some((n) => n.startsWith(`${a}:`))).toBe(true);
    expect(names.some((n) => n.startsWith(`${b}:`))).toBe(true);
  });

  it("reports what's missing", async () => {
    const { doc, a, b } = twoCubes();
    expect((await run(doc, makeBoolean(doc, a))).status.at(-1)!.error).toMatch(/tool bodies/);
    expect((await run(doc, { ...makeBoolean(doc, ""), tools: [b] })).status.at(-1)!.error).toMatch(/target/);
    const partly = await run(doc, { ...makeBoolean(doc, a, "join"), tools: [b, "gone"] });
    expect(partly.status.at(-1)!.error).toMatch(/1 of 2 tool bodies/);
    expect(measureVolume(partly.body!.shape)).toBeCloseTo(30 * 20 * 20, 3);
  });

  it("is valid in the file format", () => {
    const { doc, a, b } = twoCubes();
    const f = { ...makeBoolean(doc, a, "cut"), tools: [b] };
    expect(validateDocument(JSON.parse(JSON.stringify({ ...doc, features: [...doc.features, f] }))).features.at(-1)).toMatchObject({ type: "boolean", op: "cut", tools: [b] });
  });
});
