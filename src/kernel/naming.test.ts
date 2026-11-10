import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { addCircle, addConstraint, addRectangle } from "../sketch/builders";
import { emptySketch } from "../sketch/model";
import { makeEdgeTreatment, makeExtrude, makeSketch } from "../model/doc";
import type { Document, EdgeTreatmentFeature, ExtrudeFeature, SketchFeature } from "../model/types";
import { evaluate, meshBody } from "./evaluate";
import { nameEdges } from "./naming";

const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));

beforeAll(async () => {
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

/** 40 x 30 plate extruded 20, returning ids we need. */
function plate(): { doc: Document; sketch: SketchFeature; extrude: ExtrudeFeature; bottomLine: string; rightLine: string } {
  const doc: Document = { variables: [], features: [] };
  let r = addRectangle(emptySketch(), -20, -15, 20, 15);
  const [bottomLine, rightLine] = r.ids;
  r = addConstraint(r.sketch, { kind: "length", line: bottomLine, value: 40 });
  const sketch = makeSketch(doc, "XY", 0, r.sketch);
  doc.features.push(sketch);
  const extrude = { ...makeExtrude(doc, sketch.id, "new"), distance: 20 };
  doc.features.push(extrude);
  return { doc, sketch, extrude, bottomLine, rightLine };
}

async function faceNames(doc: Document) {
  const { body } = await evaluate(doc);
  return new Set(body!.names.values());
}

describe("topological naming", () => {
  it("names extrusion faces from the sketch", async () => {
    const { doc, extrude, bottomLine } = plate();
    const names = await faceNames(doc);
    expect(names).toEqual(
      new Set([`${extrude.id}:start`, `${extrude.id}:end`, ...[...doc.features[0].type === "sketch" ? (doc.features[0] as SketchFeature).sketch.entities.filter((e) => e.kind === "line").map((l) => `${extrude.id}:side:${l.id}`) : []]]),
    );
    expect(names.has(`${extrude.id}:side:${bottomLine}`)).toBe(true);
  });

  it("names are identical after changing upstream parameters", async () => {
    const { doc, extrude } = plate();
    const before = await faceNames(doc);
    const taller = { ...doc, features: doc.features.map((f) => (f.id === extrude.id ? { ...f, distance: 35 } : f)) };
    expect(await faceNames(taller)).toEqual(before);
  });

  it("keeps the top face name through a cut", async () => {
    const { doc, extrude } = plate();
    const hole = makeSketch(doc, "XY", 20, addCircle(emptySketch(), 0, 0, 5).sketch);
    doc.features.push(hole, { ...makeExtrude(doc, hole.id, "cut"), distance: -8 });
    const { body } = await evaluate(doc);
    const names = [...body!.names.values()];
    expect(names).toContain(`${extrude.id}:end`); // top face, now with a hole
    expect(names.filter((n) => n.startsWith(`${hole.id}`))).toHaveLength(0); // sketch id is not a solid
    expect(names.some((n) => n.includes(":side:") && !n.startsWith(extrude.id))).toBe(true); // the hole wall
  });

  it("fillets a named edge and keeps finding it after upstream edits", async () => {
    const { doc, extrude, bottomLine } = plate();
    const edgeName = `[${extrude.id}:end|${extrude.id}:side:${bottomLine}]`;
    const { body } = await evaluate(doc);
    expect(nameEdges(body!.shape, body!.names).byName.has(edgeName)).toBe(true);

    const fillet: EdgeTreatmentFeature = { ...makeEdgeTreatment(doc, "fillet"), size: 3, edges: [edgeName] };
    doc.features.push(fillet);
    const r1 = await evaluate(doc);
    expect(r1.status.find((s) => s.id === fillet.id)).toEqual({ id: fillet.id, ok: true });
    expect(r1.body!.shape.faces).toHaveLength(7); // 6 + one blend
    expect([...r1.body!.names.values()]).toContain(`${fillet.id}:blend:${edgeName}`);

    // Taller and wider: the same edge must still be found.
    const sketch = doc.features[0] as SketchFeature;
    const wider: Document = {
      ...doc,
      features: doc.features.map((f) => {
        if (f.id === extrude.id) return { ...f, distance: 50 };
        if (f.id === sketch.id)
          return { ...sketch, sketch: { ...sketch.sketch, entities: sketch.sketch.entities.map((e) => (e.kind === "point" ? { ...e, x: e.x * 1.5 } : e)) } };
        return f;
      }),
    };
    const r2 = await evaluate(wider);
    expect(r2.status.find((s) => s.id === fillet.id)?.ok).toBe(true);
    expect(r2.body!.shape.faces).toHaveLength(7);
  });

  it("reports lost references instead of failing silently", async () => {
    const { doc } = plate();
    const fillet = { ...makeEdgeTreatment(doc, "fillet"), edges: ["[nope|nada]"] };
    doc.features.push(fillet);
    const r = await evaluate(doc);
    expect(r.status.find((s) => s.id === fillet.id)?.error).toMatch(/exist anymore/);
  });

  it("rolls back the history with stopBefore", async () => {
    const { doc, extrude } = plate();
    const r = await evaluate(doc, { stopBefore: extrude.id });
    expect(r.body).toBeNull();
    expect(r.sketches).toHaveLength(1);
  });

  it("ships face and edge names with the mesh", async () => {
    const { doc } = plate();
    const m = meshBody((await evaluate(doc)).body!);
    expect(m.faceNames).toHaveLength(m.faceGroups.length);
    expect(m.edgeNames).toHaveLength(m.edgeGroups.length);
    expect(m.edgeNames.every((n) => n.startsWith("["))).toBe(true);
    expect(new Set(m.edgeNames).size).toBe(12);
  });
});
