import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { getOC, measureArea, measureVolume, setOC, type Shape3D } from "replicad";
import { addArcThrough, addCircle, addLineBetween, addPoint, addRectangle } from "../sketch/builders";
import { emptySketch, type SketchData } from "../sketch/model";
import { makeDraft, makeExtrude, makeLoft, makeSketch, makeSweep } from "../model/doc";
import type { Document, ExtrudeFeature, PlaneName } from "../model/types";
import { evaluate } from "./evaluate";

const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
beforeAll(async () => {
  setOC(await opencascade({ locateFile: () => wasm }));
}, 60_000);

function valid(s: Shape3D) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const a = new oc.BRepCheck_Analyzer((s as unknown as { wrapped: unknown }).wrapped, true);
  const ok = a.IsValid_2 ? a.IsValid_2() : a.IsValid();
  a.delete();
  return ok;
}

/** Open polyline through `pts` (sketch coordinates). */
function polyline(pts: [number, number][]): SketchData {
  let sk = emptySketch();
  const ids: string[] = [];
  for (const [x, y] of pts) {
    const a = addPoint(sk, x, y);
    sk = a.sketch;
    ids.push(a.ids[0]);
  }
  for (let i = 0; i + 1 < ids.length; i++) sk = addLineBetween(sk, ids[i], ids[i + 1]).sketch;
  return sk;
}

function sketchOn(doc: Document, plane: PlaneName, offset: number, data: SketchData) {
  const s = makeSketch(doc, plane, offset, data);
  doc.features.push(s);
  return s;
}

const okAll = (r: Awaited<ReturnType<typeof evaluate>>) => r.status.filter((s) => !s.ok).map((s) => s.error);

describe("through all", () => {
  it("cuts a hole through the whole block whatever the distance", async () => {
    const doc: Document = { variables: [], features: [] };
    const base = sketchOn(doc, "XY", 0, addRectangle(emptySketch(), -20, -15, 20, 15).sketch);
    doc.features.push({ ...makeExtrude(doc, base.id, "new"), distance: 20 });
    const hole = sketchOn(doc, "XY", 20, addCircle(emptySketch(), 0, 0, 5).sketch);
    const cut: ExtrudeFeature = { ...makeExtrude(doc, hole.id, "cut"), distance: -2, throughAll: true };
    doc.features.push(cut);
    const r = await evaluate(doc);
    expect(okAll(r)).toEqual([]);
    expect(measureVolume(r.body!.shape)).toBeCloseTo(40 * 30 * 20 - Math.PI * 25 * 20, 3);
    // Pointing away from the body there is nothing to cut.
    const away = await evaluate({ ...doc, features: [...doc.features.slice(0, -1), { ...cut, distance: 2 }] });
    expect(okAll(away)[0]).toMatch(/behind the sketch/);
  });
});

describe("sweep", () => {
  it("moves a circle along a straight path", async () => {
    const doc: Document = { variables: [], features: [] };
    // Circle on the XZ plane at the origin; path along +Y on the XY plane.
    const profile = sketchOn(doc, "XZ", 0, addCircle(emptySketch(), 0, 0, 2).sketch);
    const path = sketchOn(doc, "XY", 0, polyline([[0, 0], [0, 30]]));
    const sw = makeSweep(doc, profile.id, path.id, "new");
    doc.features.push(sw);
    const r = await evaluate(doc);
    expect(okAll(r)).toEqual([]);
    expect(measureVolume(r.body!.shape)).toBeCloseTo(Math.PI * 4 * 30, 2);
    const names = [...r.body!.names.values()];
    expect(names).toContain(`${sw.id}:start`);
    expect(names).toContain(`${sw.id}:end`);
  });

  it("follows a path with a bend (volume = profile area × path length)", async () => {
    const doc: Document = { variables: [], features: [] };
    const profile = sketchOn(doc, "XZ", 0, addCircle(emptySketch(), 0, 0, 2).sketch);
    // Up 20 along Y, a quarter arc of radius 10 turning towards +X, then 15 along X.
    let sk = polyline([[0, 0], [0, 20]]);
    const p2 = sk.entities.find((e) => e.kind === "point" && e.y === 20)!.id;
    const end = addPoint(sk, 10, 30);
    sk = end.sketch;
    sk = addArcThrough(sk, p2, end.ids[0], { x: 10 - 10 * Math.cos(Math.PI / 4), y: 20 + 10 * Math.sin(Math.PI / 4) })!.sketch;
    const far = addPoint(sk, 25, 30);
    sk = addLineBetween(far.sketch, end.ids[0], far.ids[0]).sketch;
    const path = sketchOn(doc, "XY", 0, sk);
    doc.features.push(makeSweep(doc, profile.id, path.id, "new"));
    const r = await evaluate(doc);
    expect(okAll(r)).toEqual([]);
    expect(valid(r.body!.shape)).toBe(true);
    const length = 20 + (Math.PI * 10) / 2 + 15;
    expect(measureVolume(r.body!.shape)).toBeCloseTo(Math.PI * 4 * length, 0);
  });

  it("rejects a path that branches", async () => {
    const doc: Document = { variables: [], features: [] };
    const profile = sketchOn(doc, "XZ", 0, addCircle(emptySketch(), 0, 0, 2).sketch);
    let sk = polyline([[0, 0], [0, 20]]);
    const mid = sk.entities.find((e) => e.kind === "point" && e.y === 20)!.id;
    const a = addPoint(sk, 10, 20);
    const b = addPoint(a.sketch, -10, 20);
    sk = addLineBetween(b.sketch, mid, a.ids[0]).sketch;
    sk = addLineBetween(sk, mid, b.ids[0]).sketch;
    const path = sketchOn(doc, "XY", 0, sk);
    doc.features.push(makeSweep(doc, profile.id, path.id, "new"));
    const r = await evaluate(doc);
    expect(okAll(r)[0]).toMatch(/branches/);
  });
});

describe("loft", () => {
  it("joins two squares with straight sides (a frustum)", async () => {
    const doc: Document = { variables: [], features: [] };
    const a = sketchOn(doc, "XY", 0, addRectangle(emptySketch(), -10, -10, 10, 10).sketch);
    const b = sketchOn(doc, "XY", 15, addRectangle(emptySketch(), -5, -5, 5, 5).sketch);
    const lo = { ...makeLoft(doc, [a.id, b.id], "new"), ruled: true };
    doc.features.push(lo);
    const r = await evaluate(doc);
    expect(okAll(r)).toEqual([]);
    const A1 = 400, A2 = 100;
    expect(measureVolume(r.body!.shape)).toBeCloseTo((15 / 3) * (A1 + A2 + Math.sqrt(A1 * A2)), 3);
    expect([...r.body!.names.values()]).toContain(`${lo.id}:end`);
  });

  it("blends a square into a circle", async () => {
    const doc: Document = { variables: [], features: [] };
    const a = sketchOn(doc, "XY", 0, addRectangle(emptySketch(), -10, -10, 10, 10).sketch);
    const b = sketchOn(doc, "XY", 20, addCircle(emptySketch(), 0, 0, 6).sketch);
    const c = sketchOn(doc, "XY", 40, addRectangle(emptySketch(), -8, -8, 8, 8).sketch);
    doc.features.push(makeLoft(doc, [a.id, b.id, c.id], "new"));
    const r = await evaluate(doc);
    expect(okAll(r)).toEqual([]);
    expect(valid(r.body!.shape)).toBe(true);
    const v = measureVolume(r.body!.shape);
    expect(v).toBeGreaterThan(Math.PI * 36 * 40 * 0.8);
    expect(v).toBeLessThan(400 * 40);
  });
});

describe("draft", () => {
  it("tilts the sides of a block, pivoting on the bottom face", async () => {
    const doc: Document = { variables: [], features: [] };
    const base = sketchOn(doc, "XY", 0, addRectangle(emptySketch(), -20, -15, 20, 15).sketch);
    const ex = { ...makeExtrude(doc, base.id, "new"), distance: 20 };
    doc.features.push(ex);
    const before = await evaluate(doc);
    const sides = [...before.body!.names.values()].filter((n) => n.includes(":side:"));
    expect(sides.length).toBe(4);
    const dr = { ...makeDraft(doc, sides, `${ex.id}:start`), angle: 5 };
    doc.features.push(dr);
    const r = await evaluate(doc);
    expect(okAll(r)).toEqual([]);
    expect(valid(r.body!.shape)).toBe(true);
    // The bottom stays 40 x 30; each side moves in by 20·tan 5° at the top.
    const t = 20 * Math.tan((5 * Math.PI) / 180);
    const top = r.body!.shape.faces.find((f) => r.body!.names.get(f.hashCode) === `${ex.id}:end`)!;
    expect(measureArea(top)).toBeCloseTo((40 - 2 * t) * (30 - 2 * t), 3);
    const bottom = r.body!.shape.faces.find((f) => r.body!.names.get(f.hashCode) === `${ex.id}:start`)!;
    expect(measureArea(bottom)).toBeCloseTo(40 * 30, 3);
    // The drafted faces keep their names.
    for (const n of sides) expect([...r.body!.names.values()]).toContain(n);
  });
});
