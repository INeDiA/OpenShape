import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { addCircle, addRectangle } from "../sketch/builders";
import { emptySketch, skId, type SketchData } from "../sketch/model";
import { findLoops } from "../sketch/profiles";
import { makeExtrude, makeSketch, newId } from "../model/doc";
import type { Document, ExtrudeFeature, Feature } from "../model/types";
import { evaluate } from "./evaluate";

const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));

beforeAll(async () => {
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

const base = { name: "f", suppressed: false } as const;

/** 40 x 30 x 20 block; returns the doc and the extrude id. */
function block(): { doc: Document; ex: ExtrudeFeature } {
  const doc: Document = { variables: [], features: [] };
  const s = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), -20, -15, 20, 15).sketch);
  const ex = { ...makeExtrude(doc, s.id, "new"), distance: 20 };
  doc.features.push(s, ex);
  return { doc, ex };
}

const volumeOf = async (doc: Document) => {
  const r = await evaluate(doc);
  const bad = r.status.filter((s) => !s.ok);
  if (bad.length) throw new Error(bad.map((b) => b.error).join("; "));
  const bb = r.body!.shape.boundingBox.bounds;
  return { faces: r.body!.shape.faces.length, size: [0, 1, 2].map((k) => Math.round((bb[1][k] - bb[0][k]) * 1000) / 1000), body: r.body! };
};

describe("modeling features", () => {
  it("sketches on a face and extrudes from it", async () => {
    const { doc, ex } = block();
    const onTop = makeSketch(doc, "XY", 0, addCircle(emptySketch(), 0, 0, 5).sketch);
    doc.features.push({ ...onTop, face: `${ex.id}:end` }, { ...makeExtrude(doc, onTop.id, "join"), distance: 10 });
    const r = await volumeOf(doc);
    expect(r.size).toEqual([40, 30, 30]); // boss on top: 20 + 10
  });

  it("follows the face when the block gets taller", async () => {
    const { doc, ex } = block();
    const onTop = makeSketch(doc, "XY", 0, addCircle(emptySketch(), 0, 0, 5).sketch);
    doc.features.push({ ...onTop, face: `${ex.id}:end` }, { ...makeExtrude(doc, onTop.id, "join"), distance: 10 });
    doc.features[1] = { ...ex, distance: 50 };
    expect((await volumeOf(doc)).size).toEqual([40, 30, 60]);
  });

  it("pushes and pulls faces", async () => {
    const { doc, ex } = block();
    const pull: Feature = { ...base, id: newId("pp"), type: "pushpull", face: `${ex.id}:end`, distance: 7 };
    expect((await volumeOf({ ...doc, features: [...doc.features, pull] })).size).toEqual([40, 30, 27]);
    const push: Feature = { ...base, id: newId("pp"), type: "pushpull", face: `${ex.id}:end`, distance: -5 };
    expect((await volumeOf({ ...doc, features: [...doc.features, push] })).size).toEqual([40, 30, 15]);
  });

  it("push/pull keeps names usable downstream", async () => {
    const { doc, ex } = block();
    const pull = { ...base, id: newId("pp"), type: "pushpull" as const, face: `${ex.id}:end`, distance: 7 };
    const again = { ...base, id: newId("pp"), type: "pushpull" as const, face: `${pull.id}:end`, distance: 3 };
    expect((await volumeOf({ ...doc, features: [...doc.features, pull, again] })).size).toEqual([40, 30, 30]);
  });

  it("shells with an open face", async () => {
    const { doc, ex } = block();
    const shell: Feature = { ...base, id: newId("sh"), type: "shell", faces: [`${ex.id}:end`], thickness: 2 };
    const r = await volumeOf({ ...doc, features: [...doc.features, shell] });
    expect(r.size).toEqual([40, 30, 20]); // outer size unchanged
    expect(r.faces).toBe(11); // 5 outer + 5 inner + rim
  });

  it("mirrors and patterns the body", async () => {
    const { doc } = block();
    const mirror: Feature = { ...base, id: newId("mi"), type: "mirror", plane: "YZ", offset: 30 };
    expect((await volumeOf({ ...doc, features: [...doc.features, mirror] })).size).toEqual([100, 30, 20]);
    const lin: Feature = { ...base, id: newId("pa"), type: "pattern", mode: "linear", axis: "X", count: 3, spacing: 50, angle: 360 };
    expect((await volumeOf({ ...doc, features: [...doc.features, lin] })).size).toEqual([140, 30, 20]);
  });

  it("builds profiles with arcs (slot)", async () => {
    // Slot: two lines joined by two half circles.
    const p = (x: number, y: number) => ({ id: skId("p"), kind: "point" as const, x, y });
    const a = p(-10, -5), b = p(10, -5), c = p(10, 5), d = p(-10, 5), c1 = p(10, 0), c2 = p(-10, 0);
    const sketch: SketchData = {
      entities: [
        a, b, c, d, c1, c2,
        { id: skId("l"), kind: "line", p1: a.id, p2: b.id },
        { id: skId("a"), kind: "arc", center: c1.id, start: b.id, end: c.id, radius: 5 },
        { id: skId("l"), kind: "line", p1: c.id, p2: d.id },
        { id: skId("a"), kind: "arc", center: c2.id, start: d.id, end: a.id, radius: 5 },
      ],
      constraints: [],
    };
    expect(findLoops(sketch).loops).toHaveLength(1);
    const doc: Document = { variables: [], features: [] };
    const s = makeSketch(doc, "XY", 0, sketch);
    doc.features.push(s, { ...makeExtrude(doc, s.id, "new"), distance: 4 });
    const r = await volumeOf(doc);
    expect(r.size).toEqual([30, 10, 4]);
    const names = [...r.body.names.values()];
    expect(names.filter((n) => n.includes(":side:a")).length).toBe(2); // both arc walls named from their arcs
  });
});

describe("import", () => {
  it("round-trips STEP and STL through the import feature", async () => {
    const { doc } = block();
    const { body } = await evaluate(doc);
    const toB64 = async (b: Blob) => Buffer.from(await b.arrayBuffer()).toString("base64");
    for (const [format, blob] of [["step", body!.shape.blobSTEP()], ["stl", body!.shape.blobSTL({ binary: true })]] as const) {
      const imp: Feature = { ...base, id: newId("im"), type: "import", fileName: `block.${format}`, format, data: await toB64(blob), op: "new" };
      const r = await volumeOf({ variables: [], features: [imp] });
      expect(r.size).toEqual([40, 30, 20]);
    }
  });
});
