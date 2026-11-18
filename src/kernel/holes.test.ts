import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { addCircle, addRectangle } from "../sketch/builders";
import { emptySketch } from "../sketch/model";
import { makeExtrude, makeHoleFit, makeInsert, makeSketch, makeTeardrop } from "../model/doc";
import type { Document, Feature } from "../model/types";
import { evaluate } from "./evaluate";
import { validateDocument } from "../io/fileFormat";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

/** 40 x 30 x 20 block (y -15..15) with a horizontal hole r4 along Y at x = 0, z = 10, and a vertical one r3 at x = 12. */
async function block() {
  const doc: Document = { variables: [], features: [] };
  const s = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), -20, -15, 20, 15).sketch);
  const ex = { ...makeExtrude(doc, s.id, "new"), distance: 20 };
  const h = addCircle(emptySketch(), 0, 10, 4);
  const hs = makeSketch(doc, "XZ", 15, h.sketch); // the plane y = -15
  const hx = { ...makeExtrude(doc, hs.id, "cut"), distance: -30 };
  const v = addCircle(emptySketch(), 12, 0, 3);
  const vs = makeSketch(doc, "XY", 20, v.sketch);
  const vx = { ...makeExtrude(doc, vs.id, "cut"), distance: -20 };
  doc.features.push(s, ex, hs, hx, vs, vx);
  // Hole faces by their names in the model (a cylinder may carry a "#k").
  const names = [...(await evaluate(doc)).body!.names.values()];
  const named = (prefix: string) => names.find((n) => n.startsWith(prefix))!;
  return { doc, horizontal: named(`${hx.id}:side:${h.ids[0]}`), vertical: named(`${vx.id}:side:${v.ids[0]}`) };
}

async function run(doc: Document, f: Feature) {
  const before = measureVolume((await evaluate(doc)).body!.shape);
  const r = await evaluate({ ...doc, features: [...doc.features, f] });
  return { r, removed: before - measureVolume(r.body!.shape), error: r.status.at(-1)!.error };
}

describe("teardrop holes", () => {
  it("adds a pointed 45° roof over a horizontal hole", async () => {
    const { doc, horizontal } = await block();
    const f = makeTeardrop(doc, [horizontal]);
    const { r, removed, error } = await run(doc, f);
    expect(error).toBeUndefined();
    // The kite (r²) minus the quarter circle it covers, along the 30 mm hole.
    expect(removed).toBeCloseTo(16 * (1 - Math.PI / 4) * 30, 2);
    expect([...r.body!.names.values()].filter((n) => n.startsWith(`${f.id}:roof:${horizontal}`)).length).toBe(2);
  });

  it("or a flat one, cut at the top of the hole", async () => {
    const { doc, horizontal } = await block();
    const { removed } = await run(doc, { ...makeTeardrop(doc, [horizontal]), flat: true });
    expect(removed).toBeCloseTo(16 * (1 - Math.PI / 4 - (Math.SQRT2 - 1) ** 2) * 30, 2);
  });

  it("refuses vertical holes", async () => {
    const { doc, vertical } = await block();
    expect((await run(doc, makeTeardrop(doc, [vertical]))).error).toMatch(/vertical/);
  });
});

describe("hole compensation", () => {
  it("widens holes by the amount, along their whole length", async () => {
    const { doc, horizontal, vertical } = await block();
    const { removed, error } = await run(doc, makeHoleFit(doc, [horizontal, vertical], 0.2));
    expect(error).toBeUndefined();
    const ring = (r: number, len: number) => Math.PI * ((r + 0.2) ** 2 - r ** 2) * len;
    expect(removed).toBeCloseTo(ring(4, 30) + ring(3, 20), 2);
  });

  it("refuses pins and planar faces", async () => {
    const doc: Document = { variables: [], features: [] };
    const s = makeSketch(doc, "XY", 0, addCircle(emptySketch(), 0, 0, 5).sketch);
    const ex = { ...makeExtrude(doc, s.id, "new"), distance: 10 };
    doc.features.push(s, ex);
    const side = [...(await evaluate(doc)).body!.names.values()].find((n) => n.includes(":side:"))!;
    expect((await run(doc, makeHoleFit(doc, [side]))).error).toMatch(/pin/);
    expect((await run(doc, makeHoleFit(doc, [`${ex.id}:end`]))).error).toMatch(/cylindrical/);
  });

  it("is valid in the file format", async () => {
    const { doc, horizontal } = await block();
    const parsed = validateDocument(JSON.parse(JSON.stringify({ ...doc, features: [...doc.features, makeTeardrop(doc, [horizontal]), makeHoleFit(doc, [horizontal])] })));
    expect(parsed.features.slice(-2).map((f) => f.type)).toEqual(["teardrop", "holefit"]);
  });
});

/** 30 × 30 × 15 block with a blind Ø 2.5 pilot hole 12 deep from the top, at the centre. */
async function blind() {
  const doc: Document = { variables: [], features: [] };
  const s = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), -15, -15, 15, 15).sketch);
  const ex = { ...makeExtrude(doc, s.id, "new"), distance: 15 };
  const h = addCircle(emptySketch(), 0, 0, 1.25);
  const hs = makeSketch(doc, "XY", 15, h.sketch);
  const hx = { ...makeExtrude(doc, hs.id, "cut"), distance: -12 };
  doc.features.push(s, ex, hs, hx);
  const names = [...(await evaluate(doc)).body!.names.values()];
  return { doc, hole: names.find((n) => n.startsWith(`${hx.id}:side:${h.ids[0]}`))! };
}

describe("insert seats", () => {
  it("widens a blind hole from its opening to the insert size", async () => {
    const { doc, hole } = await blind();
    const { r, removed, error } = await run(doc, makeInsert(doc, [hole]));
    expect(error).toBeUndefined();
    // M3: Ø 4 × 5.7 deep, minus the Ø 2.5 pilot already there.
    expect(removed).toBeCloseTo(Math.PI * (2 * 2 - 1.25 * 1.25) * 5.7, 0);
    expect([...r.body!.names.values()].some((n) => n.includes(":seat:"))).toBe(true);
  });

  it("takes the upper opening of a through hole, or the lower one flipped", async () => {
    const { doc, vertical } = await block(); // Ø 6 through, z 0..20
    const f = { ...makeInsert(doc, [vertical]), size: "custom" as const, diameter: 8, depth: 5 };
    const top = await run(doc, f);
    const bottom = await run(doc, { ...f, flip: true });
    expect(top.error).toBeUndefined();
    expect(top.removed).toBeCloseTo(Math.PI * (16 - 9) * 5, 0);
    expect(bottom.removed).toBeCloseTo(top.removed, 1);
    const zTop = Math.max(...[...top.r.body!.shape.faces].filter((x) => x.geomType === "CYLINDRE" && Math.abs(x.center.x - 12) < 1e-3 && x.center.z > 10).map((x) => x.center.z));
    expect(zTop).toBeCloseTo(17.5, 1);
    expect([...bottom.r.body!.shape.faces].some((x) => x.geomType === "CYLINDRE" && Math.abs(x.center.x - 12) < 1e-3 && Math.abs(x.center.z - 2.5) < 0.1)).toBe(true);
  });

  it("refuses pins, and holes already wider than the seat", async () => {
    const { doc, vertical } = await block();
    expect((await run(doc, { ...makeInsert(doc, [vertical]), size: "custom", diameter: 5 })).error).toMatch(/already wider/);
    const pin: Document = { variables: [], features: [] };
    const s = makeSketch(pin, "XY", 0, addCircle(emptySketch(), 0, 0, 5).sketch);
    const ex = { ...makeExtrude(pin, s.id, "new"), distance: 10 };
    pin.features.push(s, ex);
    const side = [...(await evaluate(pin)).body!.names.values()].find((n) => n.includes(":side:"))!;
    expect((await run(pin, makeInsert(pin, [side]))).error).toMatch(/pin/);
  });

  it("round-trips through the file format", () => {
    const doc: Document = { variables: [], features: [] };
    const parsed = validateDocument(JSON.parse(JSON.stringify({ ...doc, features: [makeInsert(doc, ["a"])] })));
    expect(parsed.features[0]).toMatchObject({ type: "insert", size: "M3", diameter: 4, depth: 5.7, flip: false });
  });
});
