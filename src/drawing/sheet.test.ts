import { beforeAll, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { addCircle, addRectangle } from "../sketch/builders";
import { emptySketch } from "../sketch/model";
import { makeExtrude, makeSketch } from "../model/doc";
import type { Document, DrawingSheet, ViewDir, ViewProjection } from "../model/types";
import { evaluate } from "../kernel/evaluate";
import { projectView } from "../kernel/projection";
import { defaultSheet, frame, resolveDimension, sheetPrims, toPaper, viewBox } from "./sheet";
import { sheetDXF, sheetPDF, sheetSVG } from "./export";
import { validateDocument } from "../io/fileFormat";

const wasm = fileURLToPath(new URL("../../node_modules/replicad-opencascadejs/dist/replicad_single.wasm", import.meta.url));
let projections: Map<ViewDir, ViewProjection>;
beforeAll(async () => {
  setOC(await opencascade({ locateFile: () => wasm }));
  // 40 x 30 x 20 block with a blind hole r8 in the top.
  const doc: Document = { variables: [], features: [] };
  const s = makeSketch(doc, "XY", 0, addRectangle(emptySketch(), -20, -15, 20, 15).sketch);
  doc.features.push(s, { ...makeExtrude(doc, s.id, "new"), distance: 20 });
  const h = makeSketch(doc, "XY", 20, addCircle(emptySketch(), 0, 0, 8).sketch);
  doc.features.push(h, { ...makeExtrude(doc, h.id, "cut"), distance: -12 });
  const body = (await evaluate(doc)).body!.shape;
  projections = new Map((["front", "top", "left", "right", "iso"] as ViewDir[]).map((d) => [d, projectView(body, d)]));
}, 60_000);

const sheet = (): DrawingSheet => defaultSheet(projections, "Block");

describe("drawing sheet", () => {
  it("lays out front, top (below, first angle), side and iso inside the frame", () => {
    const s = sheet();
    expect(s.views.map((v) => v.dir)).toEqual(["front", "top", "left", "iso"]);
    const { box } = frame(s);
    const front = s.views[0], top = s.views[1];
    expect(top.y).toBeLessThan(front.y);
    expect(top.x).toBeCloseTo(front.x, 6);
    for (const v of s.views) {
      const b = viewBox(v, projections.get(v.dir), s.scale);
      expect(b.x0).toBeGreaterThanOrEqual(box.x0);
      expect(b.x1).toBeLessThanOrEqual(box.x1);
      expect(b.y0).toBeGreaterThanOrEqual(box.y0);
      expect(b.y1).toBeLessThanOrEqual(box.y1);
    }
    // A small part gets enlarged.
    expect(s.scale).toBeGreaterThanOrEqual(2);
  });

  it("dimensions measure the model, whatever the scale", () => {
    const s = sheet();
    const front = s.views[0];
    const d = resolveDimension(s, { id: "d", view: front.id, kind: "horizontal", a: [-20, 20], b: [20, 20], offset: 8 }, projections)!;
    expect(d.value).toBeCloseTo(40, 6);
    expect(d.detached).toBe(false);
    const text = d.prims.find((p) => p.kind === "text");
    expect(text && text.kind === "text" && text.text).toBe("40");
    // The dimension line sits 8 mm (paper) above the measured edge.
    const top = toPaper(front, projections.get("front"), s.scale, [0, 20]);
    expect(text && text.kind === "text" && text.at[1]).toBeGreaterThan(top[1] + 8);
    const v = resolveDimension(s, { id: "v", view: front.id, kind: "vertical", a: [20, 0], b: [20, 20], offset: 10 }, projections)!;
    expect(v.value).toBeCloseTo(20, 6);
  });

  it("dimensions the hole's diameter on the top view", () => {
    const s = sheet();
    const d = resolveDimension(s, { id: "d", view: s.views[1].id, kind: "diameter", a: [0, 0], offset: 45 }, projections)!;
    expect(d.value).toBeCloseTo(16, 4);
    expect(d.prims.some((p) => p.kind === "text" && p.text === "Ø16")).toBe(true);
  });

  it("tells concentric circles apart by the radius picked", () => {
    const s = sheet();
    const top = projections.get("top")!;
    const rings = new Map(projections);
    rings.set("top", { ...top, circles: [7, 8, 9].map((r) => ({ cx: 0, cy: 0, r })) });
    const dim = (r: number) => resolveDimension(s, { id: "d", view: s.views[1].id, kind: "diameter", a: [0, 0], r, offset: 45 }, rings)!;
    expect(dim(8).value).toBeCloseTo(16, 6);
    expect(dim(9).value).toBeCloseTo(18, 6);
    // The picked circle is gone (a very different radius): detached.
    expect(dim(20).detached).toBe(true);
  });

  it("marks a dimension whose points no longer snap to the model", () => {
    const s = sheet();
    const d = resolveDimension(s, { id: "d", view: s.views[0].id, kind: "horizontal", a: [-25, 20], b: [20, 20], offset: 8 }, projections)!;
    expect(d.detached).toBe(true);
  });

  it("exports SVG, PDF and DXF", () => {
    const s = { ...sheet(), dimensions: [{ id: "d", view: sheet().views[1].id, kind: "diameter" as const, a: [0, 0] as [number, number], offset: 45 }] };
    s.dimensions[0].view = s.views[1].id;
    const { prims } = sheetPrims(s, projections);
    const svg = sheetSVG(s, prims);
    expect(svg).toContain('viewBox="0 0 420 297"');
    expect(svg).toContain("Ø16");
    expect(svg).toContain("stroke-dasharray");
    const pdf = new TextDecoder("latin1").decode(sheetPDF(s, prims));
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    // The cross-reference table points at each object.
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...pdf.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(pdf.slice(o, o + `${i + 1} 0 obj`.length)).toBe(`${i + 1} 0 obj`));
    expect(pdf).toContain("(\\33016) Tj");
    const dxf = sheetDXF(prims);
    expect(dxf).toContain("AC1009");
    expect(dxf).toContain("%%c16");
    expect(dxf.trim().endsWith("EOF")).toBe(true);
    expect(dxf.split("\r\n").filter((l) => l === "LINE").length).toBe(prims.filter((p) => p.kind === "line").length);
  });

  it("round-trips through the file format", () => {
    const s = sheet();
    const doc = validateDocument(JSON.parse(JSON.stringify({ variables: [], features: [], drawing: s })));
    expect(doc.drawing?.views.length).toBe(4);
    expect(() => validateDocument({ variables: [], features: [], drawing: { ...s, scale: 0 } })).toThrow(/scale/);
  });
});
