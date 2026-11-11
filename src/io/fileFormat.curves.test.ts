import { describe, expect, it } from "vitest";
import { parseFile, serialize } from "./fileFormat";
import { addCircle, addEllipse, addPoint, addRectangle, addSpline } from "../sketch/builders";
import { trimCurve } from "../sketch/edit";
import { emptySketch } from "../sketch/model";
import { makeSketch } from "../model/doc";
import type { Document } from "../model/types";

describe("file format: new sketch curves", () => {
  it("round-trips ellipses, splines and trimmed sketches (points after curves)", () => {
    let s = addEllipse(emptySketch(), 0, 0, 10, 0, 4)!.sketch;
    const a = addPoint(s, 20, 0), b = addPoint(a.sketch, 25, 5), c = addPoint(b.sketch, 30, 0);
    s = addSpline(c.sketch, [a.ids[0], b.ids[0], c.ids[0]])!.sketch;
    const rect = addRectangle(s, -10, -3, 3, 7);
    const circle = addCircle(rect.sketch, 3, 0, 3.3);
    const t = trimCurve(circle.sketch, circle.ids[0], 1, 0);
    if ("error" in t) throw new Error(t.error);
    // Trimming appends new points after the arc that uses them.
    const arcAt = t.sketch.entities.findIndex((e) => e.id === circle.ids[0]);
    expect(t.sketch.entities.slice(arcAt + 1).some((e) => e.kind === "point")).toBe(true);
    const doc: Document = { variables: [], features: [] };
    doc.features.push(makeSketch(doc, "XY", 0, t.sketch));
    const back = parseFile(serialize(doc, { generator: "test", created: "", modified: "" } as never));
    expect(back.doc).toEqual(doc);
  });
});
