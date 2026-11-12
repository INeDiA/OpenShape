import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { getOC, measureVolume, setOC, type Shape3D } from "replicad";
import { addLineBetween, addPoint } from "../sketch/builders";
import { emptySketch } from "../sketch/model";
import { makeEdgeTreatment, makeExtrude, makeSketch } from "../model/doc";
import type { Document, ExtrudeFeature } from "../model/types";
import { evaluate } from "./evaluate";
import { nameEdges } from "./naming";

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

/** A polygon (sketch on XY) extruded by 20. */
async function prism(pts: [number, number][]) {
  const doc: Document = { variables: [], features: [] };
  let sk = emptySketch();
  const ids: string[] = [];
  for (const [x, y] of pts) {
    const a = addPoint(sk, x, y);
    sk = a.sketch;
    ids.push(a.ids[0]);
  }
  for (let i = 0; i < ids.length; i++) sk = addLineBetween(sk, ids[i], ids[(i + 1) % ids.length]).sketch;
  const s = makeSketch(doc, "XY", 0, sk);
  const ex: ExtrudeFeature = { ...makeExtrude(doc, s.id, "new"), distance: 20 };
  doc.features.push(s, ex);
  const r = await evaluate(doc);
  const naming = nameEdges(r.body!.shape, r.body!.names);
  return { doc, naming };
}

/** Names of the edges with an end at `v`. */
function edgesAt(naming: ReturnType<typeof nameEdges>, v: [number, number, number]) {
  const near = (p: { x: number; y: number; z: number }) => Math.hypot(p.x - v[0], p.y - v[1], p.z - v[2]) < 1e-6;
  return [...naming.byName].filter(([, e]) => near(e.startPoint) || near(e.endPoint)).map(([n]) => n);
}

async function filletCorner(pts: [number, number][], v: [number, number, number], radii: number[]) {
  const { doc, naming } = await prism(pts);
  const edges = edgesAt(naming, v);
  expect(edges.length).toBe(3);
  const fi = { ...makeEdgeTreatment(doc, "fillet"), size: radii[0], edges, overrides: Object.fromEntries(edges.map((n, i) => [n, radii[i]])) };
  const r = await evaluate({ ...doc, features: [...doc.features, fi] });
  return { fi, r };
}

const box: [number, number][] = [[0, 0], [40, 0], [40, 40], [0, 40]];

describe("vertex blends", () => {
  it("replaces the corner of three different fillets with one smooth patch", async () => {
    const { fi, r } = await filletCorner(box, [40, 40, 20], [4, 3.5, 1]);
    expect(r.status.every((s) => s.ok)).toBe(true);
    const shape = r.body!.shape;
    expect(valid(shape)).toBe(true);
    // 6 planes, 3 fillets, 1 corner patch; nothing left of OCCT's own corner.
    expect(shape.faces.length).toBe(10);
    expect(shape.faces.filter((f) => f.geomType === "BSPLINE_SURFACE").length).toBe(1);
    // Every face keeps a name, the fillets and the patch are named after the selected edges.
    const names = [...r.body!.names.values()];
    expect(names.some((n) => n.startsWith("?"))).toBe(false);
    expect(names.filter((n) => n.startsWith(`${fi.id}:blend:`)).length).toBe(4);
    // Rounding only removes material from the 40 x 40 x 20 block, a few mm³ around the corner.
    const v = measureVolume(shape);
    expect(v).toBeLessThan(40 * 40 * 20);
    expect(40 * 40 * 20 - v).toBeLessThan(200);
  });

  it("leaves OCCT's sphere (equal radii) and torus (two equal radii) alone", async () => {
    const { r } = await filletCorner(box, [40, 40, 20], [3, 3, 3]);
    expect(r.body!.shape.faces.some((f) => f.geomType === "SPHERE")).toBe(true);
    const { r: t } = await filletCorner(box, [40, 40, 20], [1, 6, 1]);
    const types = t.body!.shape.faces.map((f) => f.geomType);
    expect(types).toContain("TORUS");
    expect(types).not.toContain("BSPLINE_SURFACE");
  });

  it("blends every corner of a block filleted with a different radius on each edge", async () => {
    const { doc, naming } = await prism(box);
    const edges = [...naming.byName.keys()];
    expect(edges.length).toBe(12);
    const overrides = Object.fromEntries(edges.map((n, i) => [n, 1 + i * 0.4]));
    const fi = { ...makeEdgeTreatment(doc, "fillet"), size: 1, edges, overrides };
    const r = await evaluate({ ...doc, features: [...doc.features, fi] });
    expect(r.status.every((s) => s.ok)).toBe(true);
    const shape = r.body!.shape;
    expect(valid(shape)).toBe(true);
    // 6 planes, 12 fillets, 8 corners: one patch each.
    expect(shape.faces.length).toBe(26);
    expect([...r.body!.names.values()].some((n) => n.startsWith("?"))).toBe(false);
  });

  it("blends a corner where a concave edge meets two convex ones", async () => {
    // L-shaped block: the inner vertical edge at (20, 20) is concave.
    const L: [number, number][] = [[0, 0], [40, 0], [40, 20], [20, 20], [20, 40], [0, 40]];
    const { r } = await filletCorner(L, [20, 20, 20], [3, 2, 5]);
    expect(r.status.every((s) => s.ok)).toBe(true);
    expect(valid(r.body!.shape)).toBe(true);
  });
});
