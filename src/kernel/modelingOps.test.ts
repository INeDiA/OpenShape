import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { measureVolume, setOC } from "replicad";
import { addCircle, addLineBetween, addPoint, addRectangle } from "../sketch/builders";
import { emptySketch, type SketchData } from "../sketch/model";
import { makeAlign, makeExtrude, makeFaceOffset, makeReplaceFace, makeSketch, makeSketchOnFace, makeSplit, makeSplitFace, makeSymmetry } from "../model/doc";
import type { Document, Feature, TransformFeature } from "../model/types";
import { evaluate } from "./evaluate";
import { validateDocument } from "../io/fileFormat";

beforeAll(async () => {
  const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

/** A free line from (x0, y0) to (x1, y1). */
function addLine(s: SketchData, x0: number, y0: number, x1: number, y1: number) {
  const a = addPoint(s, x0, y0);
  const b = addPoint(a.sketch, x1, y1);
  return addLineBetween(b.sketch, a.ids[0], b.ids[0]);
}

/** A box from (x0, y0, 0) to (x1, y1, h) as a sketch + extrude; returns the extrude (= body) id. */
function box(doc: Document, x0: number, y0: number, x1: number, y1: number, h: number): string {
  const s = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), x0, y0, x1, y1).sketch);
  doc.features.push(s);
  const e = { ...makeExtrude(doc, s.id, "new"), distance: h };
  doc.features.push(e);
  return e.id;
}

async function run(doc: Document, ...more: Feature[]) {
  const r = await evaluate({ ...doc, features: [...doc.features, ...more] });
  const failed = r.status.filter((s) => !s.ok);
  return { ...r, failed };
}

const volumeOf = (r: Awaited<ReturnType<typeof run>>, id: string) => measureVolume(r.bodies.find((b) => b.id === id)!.shape.shape);
const boundsOf = (r: Awaited<ReturnType<typeof run>>, id: string) => r.bodies.find((b) => b.id === id)!.shape.shape.boundingBox.bounds;
const namesOf = (r: Awaited<ReturnType<typeof run>>, id: string) => [...r.bodies.find((b) => b.id === id)!.shape.names.values()];

describe("Split", () => {
  it("cuts a body in two with a plane: the front piece keeps the id", async () => {
    const doc: Document = { variables: [], features: [] };
    const cube = box(doc, 0, 0, 20, 20, 20);
    const split = { ...makeSplit(doc, cube), plane: "YZ" as const, offset: 5 };
    const r = await run(doc, split);
    expect(r.failed).toEqual([]);
    expect(r.bodies.map((b) => b.id).sort()).toEqual([cube, split.id].sort());
    expect(volumeOf(r, cube)).toBeCloseTo(15 * 400, 3);
    expect(volumeOf(r, split.id)).toBeCloseTo(5 * 400, 3);
    expect(namesOf(r, cube)).toContain(`${split.id}:cut`);
    // The pieces never share a face name.
    expect(namesOf(r, split.id)).toContain(`${split.id}:${cube}:end`);
    expect(namesOf(r, split.id).filter((n) => namesOf(r, cube).includes(n))).toEqual([]);
  });

  it("splits with a planar face of the model", async () => {
    const doc: Document = { variables: [], features: [] };
    const cube = box(doc, 0, 0, 20, 20, 20);
    const slab = box(doc, 30, 0, 40, 20, 8);
    const r = await run(doc, makeSplit(doc, cube, `${slab}:end`));
    expect(r.failed).toEqual([]);
    expect(volumeOf(r, cube)).toBeCloseTo(12 * 400, 3);
  });

  it("splits with another body, which stays", async () => {
    const doc: Document = { variables: [], features: [] };
    const a = box(doc, 0, 0, 20, 20, 20);
    const b = box(doc, 10, 0, 30, 20, 20);
    const split = { ...makeSplit(doc, a), toolBody: b };
    const r = await run(doc, split);
    expect(r.failed).toEqual([]);
    expect(r.bodies.length).toBe(3);
    expect(volumeOf(r, a)).toBeCloseTo(10 * 400, 3);
    expect(volumeOf(r, split.id)).toBeCloseTo(10 * 400, 3);
    expect(volumeOf(r, b)).toBeCloseTo(20 * 400, 3);
  });

  it("reports a plane that misses the body", async () => {
    const doc: Document = { variables: [], features: [] };
    const cube = box(doc, 0, 0, 20, 20, 20);
    const r = await run(doc, { ...makeSplit(doc, cube), plane: "YZ", offset: 50 });
    expect(r.failed[0]?.error).toMatch(/doesn't cross/);
  });
});

describe("Split faces", () => {
  it("imprints a sketch line on the face it lies on", async () => {
    const doc: Document = { variables: [], features: [] };
    const cube = box(doc, 0, 0, 20, 20, 20);
    const sk = { ...makeSketchOnFace(doc, `${cube}:end`), sketch: addLine(emptySketch(), -2, 8, 22, 8).sketch };
    doc.features.push(sk);
    const before = await run(doc);
    const r = await run(doc, makeSplitFace(doc, sk.id));
    expect(r.failed).toEqual([]);
    expect(r.bodies[0].shape.shape.faces.length).toBe(before.bodies[0].shape.shape.faces.length + 1);
    expect(volumeOf(r, cube)).toBeCloseTo(8000, 3);
    // The two pieces are told apart by position.
    expect(namesOf(r, cube)).toEqual(expect.arrayContaining([`${cube}:end#1`, `${cube}:end#2`]));
  });

  it("fails when the curves miss every face", async () => {
    const doc: Document = { variables: [], features: [] };
    box(doc, 0, 0, 20, 20, 20);
    const sk = makeSketch(doc, "XY", 50, addLine(emptySketch(), 0, 0, 10, 10).sketch);
    doc.features.push(sk);
    const r = await run(doc, makeSplitFace(doc, sk.id));
    expect(r.failed[0]?.error).toMatch(/don't lie on any face/);
  });
});

describe("Face offset", () => {
  /** 40 x 30 x 10 plate with a through hole of radius 5. */
  function plate() {
    const doc: Document = { variables: [], features: [] };
    const body = box(doc, -20, -15, 20, 15, 10);
    const s = makeSketch(doc, "XY", 10, addCircle(emptySketch(), 0, 0, 5).sketch);
    doc.features.push(s, { ...makeExtrude(doc, s.id, "cut"), distance: -10 });
    return { doc, body };
  }

  it("shrinks a hole by offsetting its wall, and the wall keeps its name", async () => {
    const { doc, body } = plate();
    const base = await run(doc);
    const b = base.bodies[0].shape;
    const wall = b.shape.faces.find((f) => f.geomType === "CYLINDRE")!;
    const name = b.names.get(wall.hashCode)!;
    const r = await run(doc, makeFaceOffset(doc, [name], 1));
    expect(r.failed).toEqual([]);
    expect(volumeOf(r, body)).toBeCloseTo(40 * 30 * 10 - Math.PI * 16 * 10, 1);
    const shape = r.bodies[0].shape;
    const moved = shape.shape.faces.find((f) => f.geomType === "CYLINDRE")!;
    expect(shape.names.get(moved.hashCode)).toBe(name);
  });

  it("moves a planar face inward with a negative distance", async () => {
    const { doc, body } = plate();
    const r = await run(doc, makeFaceOffset(doc, [`${body}:end`], -2));
    expect(r.failed).toEqual([]);
    expect(volumeOf(r, body)).toBeCloseTo((40 * 30 - Math.PI * 25) * 8, 1);
    expect(namesOf(r, body)).toContain(`${body}:end`);
  });
});

describe("Replace face", () => {
  it("extends a face up to a plane, and trims it down to one", async () => {
    const doc: Document = { variables: [], features: [] };
    const cube = box(doc, 0, 0, 20, 20, 20);
    const up = await run(doc, { ...makeReplaceFace(doc, [`${cube}:end`]), plane: "XY", offset: 30 });
    expect(up.failed).toEqual([]);
    expect(volumeOf(up, cube)).toBeCloseTo(20 * 20 * 30, 3);
    expect(namesOf(up, cube)).toContain(`${cube}:end`);
    const down = await run(doc, { ...makeReplaceFace(doc, [`${cube}:end`]), plane: "XY", offset: 12 });
    expect(volumeOf(down, cube)).toBeCloseTo(20 * 20 * 12, 3);
  });

  it("goes up to a face of another body", async () => {
    const doc: Document = { variables: [], features: [] };
    const cube = box(doc, 0, 0, 20, 20, 20);
    const tower = box(doc, 30, 0, 40, 10, 45);
    const r = await run(doc, makeReplaceFace(doc, [`${cube}:end`], `${tower}:end`));
    expect(r.failed).toEqual([]);
    expect(boundsOf(r, cube)[1][2]).toBeCloseTo(45, 4);
  });

  it("follows a tilted target, and refuses a perpendicular one", async () => {
    const doc: Document = { variables: [], features: [] };
    const cube = box(doc, 0, 0, 20, 20, 20);
    // A slab whose top (z = 5) is turned -45° about Y through (0, 0, 5): the plane z = x + 5.
    const slab = box(doc, 30, 0, 60, 20, 5);
    const turn: TransformFeature = { type: "transform", id: "tr1", name: "Turn", suppressed: false, body: slab, dx: 0, dy: 0, dz: 0, axis: "Y", angle: -45, pivotX: 0, pivotY: 0, pivotZ: 5 };
    doc.features.push(turn);
    const r = await run(doc, makeReplaceFace(doc, [`${cube}:end`], `${slab}:end`));
    expect(r.failed).toEqual([]);
    expect(volumeOf(r, cube)).toBeCloseTo(20 * (200 + 100), 2);
    expect(boundsOf(r, cube)[1][2]).toBeCloseTo(25, 3);
    const perp = await run(doc, { ...makeReplaceFace(doc, [`${cube}:end`]), plane: "YZ", offset: 10 });
    expect(perp.failed[0]?.error).toMatch(/perpendicular/);
  });
});

describe("Align", () => {
  it("lines up bounding boxes with a reference body", async () => {
    const doc: Document = { variables: [], features: [] };
    const a = box(doc, 0, 0, 20, 20, 20);
    const b = box(doc, 30, 5, 50, 15, 40);
    const r = await run(doc, { ...makeAlign(doc, [a], b), x: "max", y: "center", z: "none" });
    expect(r.failed).toEqual([]);
    const [lo, hi] = boundsOf(r, a);
    expect(hi[0]).toBeCloseTo(50, 4);
    expect((lo[1] + hi[1]) / 2).toBeCloseTo(10, 4);
    expect(lo[2]).toBeCloseTo(0, 4);
  });

  it("aligns to the origin without a reference", async () => {
    const doc: Document = { variables: [], features: [] };
    const a = box(doc, 10, 10, 30, 30, 20);
    const r = await run(doc, { ...makeAlign(doc, [a]), x: "center", y: "min", z: "max" });
    const [lo, hi] = boundsOf(r, a);
    expect((lo[0] + hi[0]) / 2).toBeCloseTo(0, 4);
    expect(lo[1]).toBeCloseTo(0, 4);
    expect(hi[2]).toBeCloseTo(0, 4);
  });
});

describe("Symmetry", () => {
  it("keeps the front half and mirrors it", async () => {
    const doc: Document = { variables: [], features: [] };
    const cube = box(doc, 0, 0, 20, 20, 20);
    const front = await run(doc, { ...makeSymmetry(doc, cube), plane: "YZ", offset: 5 });
    expect(front.failed).toEqual([]);
    expect(volumeOf(front, cube)).toBeCloseTo(30 * 400, 3);
    expect(boundsOf(front, cube)[0][0]).toBeCloseTo(-10, 4);
    const back = await run(doc, { ...makeSymmetry(doc, cube), plane: "YZ", offset: 5, flip: true });
    expect(volumeOf(back, cube)).toBeCloseTo(10 * 400, 3);
  });
});

describe("Transform scale", () => {
  it("scales uniformly about the pivot", async () => {
    const doc: Document = { variables: [], features: [] };
    const cube = box(doc, 0, 0, 20, 20, 20);
    const t: TransformFeature = { type: "transform", id: "tr1", name: "Move", suppressed: false, body: cube, dx: 0, dy: 0, dz: 0, axis: "Z", angle: 0, pivotX: 0, pivotY: 0, pivotZ: 0, scale: 1.5 };
    const r = await run(doc, t);
    expect(r.failed).toEqual([]);
    expect(volumeOf(r, cube)).toBeCloseTo(30 * 30 * 30, 2);
    expect(boundsOf(r, cube)[1][0]).toBeCloseTo(30, 4);
    expect(namesOf(r, cube)).toContain(`${cube}:end`);
  });
});

describe("file format", () => {
  it("accepts the new features", () => {
    const doc: Document = { variables: [], features: [] };
    const cube = box(doc, 0, 0, 20, 20, 20);
    const sk = { ...makeSketchOnFace(doc, `${cube}:end`), sketch: addLine(emptySketch(), 0, 5, 20, 5).sketch };
    doc.features.push(sk);
    doc.features.push(
      makeSplit(doc, cube),
      makeSplitFace(doc, sk.id),
      makeFaceOffset(doc, [`${cube}:end`]),
      makeReplaceFace(doc, [`${cube}:end`], `${cube}:start`),
      makeAlign(doc, [cube]),
      makeSymmetry(doc, cube),
    );
    expect(validateDocument(JSON.parse(JSON.stringify(doc))).features.length).toBe(doc.features.length);
    const bad = JSON.parse(JSON.stringify(doc));
    bad.features.find((f: Feature) => f.type === "align").x = "left";
    expect(() => validateDocument(bad)).toThrow(/align|x/);
  });
});
