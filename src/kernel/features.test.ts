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

describe("multiple bodies", () => {
  function twoBlocks() {
    const { doc, ex } = block();
    const s2 = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), 50, -5, 60, 5).sketch);
    const ex2 = { ...makeExtrude(doc, s2.id, "new"), distance: 10 };
    doc.features.push(s2, ex2);
    return { doc, ex, ex2 };
  }

  it("keeps separate bodies", async () => {
    const { doc, ex, ex2 } = twoBlocks();
    const r = await evaluate(doc);
    expect(r.bodies.map((b) => b.id)).toEqual([ex.id, ex2.id]);
    expect(r.body!.shape.faces).toHaveLength(12);
    expect(new Set(r.faceBody.values())).toEqual(new Set([ex.id, ex2.id]));
  });

  it("modifies the body that owns the face", async () => {
    const { doc, ex2 } = twoBlocks();
    const pull: Feature = { ...base, id: newId("pp"), type: "pushpull", face: `${ex2.id}:end`, distance: 15 };
    const r = await evaluate({ ...doc, features: [...doc.features, pull] });
    const second = r.bodies.find((b) => b.id === ex2.id)!.shape.shape.boundingBox.bounds;
    expect(Math.round(second[1][2])).toBe(25);
    const first = r.bodies[0].shape.shape.boundingBox.bounds;
    expect(Math.round(first[1][2])).toBe(20); // untouched
  });

  it("moves and rotates a body keeping its face names", async () => {
    const { doc, ex2 } = twoBlocks();
    const before = new Set((await evaluate(doc)).bodies[1].shape.names.values());
    const move: Feature = { ...base, id: newId("tr"), type: "transform", body: ex2.id, dx: 0, dy: 0, dz: 30, axis: "Z", angle: 90, pivotX: 55, pivotY: 0, pivotZ: 0 };
    const r = await evaluate({ ...doc, features: [...doc.features, move] });
    const b = r.bodies[1].shape;
    expect(new Set(b.names.values())).toEqual(before);
    const bb = b.shape.boundingBox.bounds;
    expect(Math.round(bb[0][2])).toBe(30);
    // A downstream feature still finds the moved face by name.
    const pull: Feature = { ...base, id: newId("pp"), type: "pushpull", face: `${ex2.id}:end`, distance: 5 };
    const r2 = await evaluate({ ...doc, features: [...doc.features, move, pull] });
    expect(r2.status.every((s) => s.ok)).toBe(true);
    expect(Math.round(r2.bodies[1].shape.shape.boundingBox.bounds[1][2])).toBe(45);
  });

  it("cuts the targeted body", async () => {
    const { doc, ex } = twoBlocks();
    const hole = makeSketch(doc, "XY", 20, addCircle(emptySketch(), 0, 0, 4).sketch);
    doc.features.push(hole, { ...makeExtrude(doc, hole.id, "cut"), distance: -5, target: ex.id });
    const r = await evaluate(doc);
    expect(r.status.every((s) => s.ok)).toBe(true);
    expect(r.bodies[0].shape.shape.faces.length).toBe(8); // block + hole wall + hole floor
    expect(r.bodies[1].shape.shape.faces.length).toBe(6);
  });
});

describe("validity", () => {
  it("rejects a fillet radius too large for the edge instead of returning a broken solid", async () => {
    const { doc, ex } = block();
    const s = doc.features[0];
    const bottom = s.type === "sketch" ? s.sketch.entities.find((e) => e.kind === "line")!.id : "";
    const edge = `[${ex.id}:end|${ex.id}:side:${bottom}]`;
    const ok: Feature = { ...base, id: newId("fi"), type: "fillet", size: 3, edges: [edge] };
    expect((await evaluate({ ...doc, features: [...doc.features, ok] })).status.every((x) => x.ok)).toBe(true);
    const huge: Feature = { ...base, id: newId("fi"), type: "fillet", size: 40, edges: [edge] };
    const r = await evaluate({ ...doc, features: [...doc.features, huge] });
    expect(r.status.find((x) => x.id === huge.id)?.ok).toBe(false);
  });
});
