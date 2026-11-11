import { describe, expect, it } from "vitest";
import { demoDocument } from "./doc";
import { dependencies, dependentsOf, moveFeature, removeFeatures } from "./history";
import type { Document, Feature } from "./types";

// Demo: Sketch 1, Extrude 1, Sketch 2, Extrude 2 (cut), Fillet 1.
const demo = () => demoDocument();
const ids = (d: Document) => d.features.map((f) => f.name);

describe("history editing", () => {
  it("finds references to sketches, faces and bodies", () => {
    const d = demo();
    const [s1, e1, s2, e2] = d.features;
    const pull: Feature = { id: "pp-x", name: "Pull", suppressed: false, type: "pushpull", face: `${e1.id}:end`, distance: 5 };
    const doc = { ...d, features: [...d.features, pull] };
    const deps = dependencies(doc);
    expect([...deps.get(e1.id)!]).toEqual([s1.id]);
    expect([...deps.get(e2.id)!]).toEqual([s2.id]);
    expect([...deps.get("pp-x")!]).toEqual([e1.id]);
    expect(dependentsOf(doc, s1.id)).toEqual(new Set([e1.id, "pp-x"]));
  });

  it("does not confuse ids that are prefixes of other ids", () => {
    const a: Feature = { id: "ex-1", name: "A", suppressed: false, type: "pushpull", face: "ex-10:end", distance: 1 };
    const b: Feature = { id: "ex-10", name: "B", suppressed: false, type: "pushpull", face: "x:end", distance: 1 };
    expect([...dependencies({ variables: [], features: [b, a] }).get("ex-1")!]).toEqual(["ex-10"]);
  });

  it("moves a feature when nothing it uses ends up after it", () => {
    const d = demo();
    // The demo fillet rounds edges of Extrude 1 only, so it can go right after it.
    const moved = moveFeature(d, d.features[4].id, 2);
    expect(moved.ok).toBe(true);
    if (moved.ok) expect(ids(moved.doc)).toEqual(["Sketch 1", "Extrude 1", "Fillet 1", "Sketch 2", "Extrude 2"]);
  });

  it("refuses to move a feature before what it uses", () => {
    const d = demo();
    const r = moveFeature(d, d.features[1].id, 0); // Extrude 1 above Sketch 1
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/Extrude 1.*Sketch 1/);
    const r2 = moveFeature(d, d.features[0].id, 3); // Sketch 1 below Extrude 1
    expect(r2.ok).toBe(false);
  });

  it("keeps the list unchanged when dropped in place", () => {
    const d = demo();
    const r = moveFeature(d, d.features[2].id, 2);
    expect(r.ok && r.doc).toBe(d);
  });

  it("removes only the given features", () => {
    const d = demo();
    expect(ids(removeFeatures(d, [d.features[4].id]))).toEqual(["Sketch 1", "Extrude 1", "Sketch 2", "Extrude 2"]);
  });
});
