import { describe, expect, it } from "vitest";
import { addCircle, addLineBetween, addPoint, addRectangle } from "./builders";
import { emptySketch, entityMap, pointOf, type SketchData } from "./model";
import { findLoops, loopArea } from "./profiles";
import { bsplineSamples, DXFError, dxfToSketch, sketchToDXF, withImported } from "./dxf";

/** A minimal DXF with the given entity group codes (pairs of code, value). */
function dxf(entities: (string | number)[], insunits?: number): string {
  const g: (string | number)[] = [];
  if (insunits !== undefined) g.push(0, "SECTION", 2, "HEADER", 9, "$INSUNITS", 70, insunits, 0, "ENDSEC");
  g.push(0, "SECTION", 2, "ENTITIES", ...entities, 0, "ENDSEC", 0, "EOF");
  const lines: string[] = [];
  for (let i = 0; i < g.length; i += 2) lines.push(String(g[i]), String(g[i + 1]));
  return lines.join("\n");
}

const curves = (s: SketchData) => s.entities.filter((e) => e.kind !== "point");
const kinds = (s: SketchData) => curves(s).map((e) => e.kind).sort();
const areas = (s: SketchData) => findLoops(s).loops.map((l) => Math.abs(loopArea(l))).sort((a, b) => a - b);
const imported = (text: string) => withImported(emptySketch(), dxfToSketch(text));

describe("sketch to DXF", () => {
  it("writes lines, circles and arcs, construction on its own layer", () => {
    let s = addRectangle(emptySketch(), 0, 0, 40, 20).sketch;
    s = addCircle(s, 10, 10, 4).sketch;
    const a = addPoint(s, -5, 0), b = addPoint(a.sketch, -5, 20);
    s = addLineBetween(b.sketch, a.ids[0], b.ids[0], true).sketch;
    const text = sketchToDXF(s);
    expect(text).toContain("AC1009");
    expect(text.match(/\r\n {2}0\r\nLINE\r\n/g)?.length).toBe(5);
    expect(text).toContain("CIRCLE");
    expect(text).toMatch(/LINE\r\n {2}8\r\nCONSTRUCTION/);
  });

  it("round-trips: the same profiles come back", () => {
    let s = addRectangle(emptySketch(), 0, 0, 40, 20).sketch;
    s = addCircle(s, 10, 10, 4).sketch;
    const back = imported(sketchToDXF(s));
    expect(kinds(back)).toEqual(kinds(s));
    expect(areas(back)).toEqual(areas(s).map((x) => expect.closeTo(x, 6)));
  });

  it("writes arcs counter-clockwise with their angles", () => {
    // A quarter arc from (10, 0) to (0, 10) around the origin.
    const back = imported(dxf([0, "ARC", 8, "0", 10, 0, 20, 0, 40, 10, 50, 0, 51, 90]));
    const text = sketchToDXF(back);
    expect(text).toMatch(/ARC[\s\S]*\r\n 50\r\n0\r\n 51\r\n90\r\n/);
  });
});

describe("DXF to sketch", () => {
  it("joins the ends of separate lines into closed profiles", () => {
    const text = dxf([
      ...[0, "LINE", 10, 0, 20, 0, 11, 30, 21, 0],
      ...[0, "LINE", 10, 30, 20, 0, 11, 30, 21, 10],
      ...[0, "LINE", 10, 30, 20, 10, 11, 0, 21, 10],
      // Written slightly off: still the same corner.
      ...[0, "LINE", 10, 0.0000004, 20, 10, 11, 0, 21, 0],
    ]);
    const s = imported(text);
    expect(s.entities.filter((e) => e.kind === "point").length).toBe(4);
    expect(areas(s)).toEqual([expect.closeTo(300, 6)]);
  });

  it("reads polylines with bulges as arcs", () => {
    // 20 x 10 rectangle whose right side bulges out into a half circle (bulge 1 = 180°).
    const text = dxf([0, "LWPOLYLINE", 8, "0", 90, 4, 70, 1, 10, 0, 20, 0, 10, 20, 20, 0, 42, 1, 10, 20, 20, 10, 10, 0, 20, 10]);
    const s = imported(text);
    expect(kinds(s)).toEqual(["arc", "line", "line", "line"]);
    // loopArea approximates arcs with polygons: about 0.25 mm² short here.
    expect(areas(s)[0]).toBeCloseTo(200 + (Math.PI * 25) / 2, 0);
    const arc = curves(s).find((e) => e.kind === "arc")!;
    expect(arc.kind === "arc" && arc.radius).toBeCloseTo(5, 9);
  });

  it("reads old-style POLYLINE / VERTEX sequences, with a clockwise bulge", () => {
    const text = dxf([
      ...[0, "POLYLINE", 66, 1, 70, 1],
      ...[0, "VERTEX", 10, 0, 20, 0],
      ...[0, "VERTEX", 10, 20, 20, 0, 42, -1],
      ...[0, "VERTEX", 10, 20, 20, 10],
      ...[0, "VERTEX", 10, 0, 20, 10],
      ...[0, "SEQEND"],
    ]);
    const s = imported(text);
    // The half circle bulges inward: the rectangle minus half a disc.
    expect(areas(s)[0]).toBeCloseTo(200 - (Math.PI * 25) / 2, 0);
  });

  it("converts units from $INSUNITS", () => {
    const s = imported(dxf([0, "LINE", 10, 0, 20, 0, 11, 1, 21, 0], 1));
    const m = entityMap(s);
    const l = curves(s)[0];
    expect(l.kind === "line" && pointOf(m, l.p2).x).toBeCloseTo(25.4, 9);
    expect(dxfToSketch(dxf([0, "CIRCLE", 10, 0, 20, 0, 40, 2], 5)).entities.find((e) => e.kind === "circle")).toMatchObject({ radius: 20 });
  });

  it("reads full ellipses as ellipses and elliptical arcs as splines", () => {
    const full = imported(dxf([0, "ELLIPSE", 10, 5, 20, 5, 11, 10, 21, 0, 40, 0.5, 41, 0, 42, 2 * Math.PI]));
    expect(kinds(full)).toEqual(["ellipse"]);
    expect(areas(full)[0]).toBeCloseTo(Math.PI * 10 * 5, 0);
    const part = imported(dxf([0, "ELLIPSE", 10, 0, 20, 0, 11, 10, 21, 0, 40, 0.5, 41, 0, 42, Math.PI]));
    expect(kinds(part)).toEqual(["spline"]);
  });

  it("reads splines from fit points, or from control points and knots", () => {
    const fit = imported(dxf([0, "SPLINE", 70, 8, 71, 3, 74, 3, 11, 0, 21, 0, 11, 5, 21, 5, 11, 10, 21, 0]));
    expect(kinds(fit)).toEqual(["spline"]);
    const ctrl = dxfToSketch(dxf([0, "SPLINE", 70, 8, 71, 3, 72, 8, 73, 4, ...[0, 0, 0, 0, 1, 1, 1, 1].flatMap((k) => [40, k]), 10, 0, 20, 0, 10, 0, 20, 10, 10, 10, 20, 10, 10, 10, 20, 0]));
    const pts = ctrl.entities.filter((e) => e.kind === "point");
    // A clamped spline starts and ends at its end control points.
    expect(pts[0]).toMatchObject({ x: 0, y: 0 });
    expect(pts.at(-1)).toMatchObject({ x: expect.closeTo(10, 9), y: expect.closeTo(0, 9) });
  });

  it("samples a cubic Bézier-shaped B-spline correctly", () => {
    const pts = bsplineSamples(
      [
        [0, 0],
        [0, 10],
        [10, 10],
        [10, 0],
      ],
      [0, 0, 0, 0, 1, 1, 1, 1],
      [],
      3,
    );
    const mid = pts[Math.floor(pts.length / 2)];
    // A cubic Bézier with these points peaks at (5, 7.5).
    expect(mid[0]).toBeCloseTo(5, 6);
    expect(mid[1]).toBeCloseTo(7.5, 6);
  });

  it("mirrors entities drawn with their extrusion along -Z", () => {
    const s = imported(dxf([0, "CIRCLE", 10, 10, 20, 3, 40, 2, 230, -1]));
    expect(s.entities.find((e) => e.kind === "point")).toMatchObject({ x: -10, y: 3 });
  });

  it("counts what it skips, and refuses files with nothing usable", () => {
    const r = dxfToSketch(dxf([0, "TEXT", 1, "hello", 0, "LINE", 10, 0, 20, 0, 11, 5, 21, 0, 0, "TEXT", 1, "x", 0, "HATCH"]));
    expect(r.curves).toBe(1);
    expect(r.skipped).toEqual({ TEXT: 2, HATCH: 1 });
    expect(() => dxfToSketch(dxf([0, "TEXT", 1, "only text"]))).toThrow(DXFError);
    expect(() => dxfToSketch("not a dxf\nat all")).toThrow(DXFError);
  });

  it("round-trips ellipses and splines as closed polylines", () => {
    const s = imported(dxf([0, "ELLIPSE", 10, 0, 20, 0, 11, 10, 21, 0, 40, 0.5, 41, 0, 42, 2 * Math.PI]));
    const back = imported(sketchToDXF(s));
    expect(kinds(back).every((k) => k === "line")).toBe(true);
    expect(areas(back)[0]).toBeCloseTo(Math.PI * 50, 0);
  });
});
