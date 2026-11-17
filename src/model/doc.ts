import type { BooleanOp, Document, EdgeTreatmentFeature, ExtrudeFeature, Feature, PlaneName, ImportFeature, MirrorFeature, PatternFeature, PushPullFeature, RevolveFeature, ShellFeature, SketchFeature, CoveFeature, SweepFeature, LoftFeature, DraftFeature, BooleanFeature, BodyId, LayFlatFeature } from "./types";
import { emptySketch, type SketchData } from "../sketch/model";
import { addCircle, addConstraint, addRectangle } from "../sketch/builders";

let counter = 0;
export const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

function nextName(doc: Document, base: string) {
  const n = doc.features.filter((f) => f.name.startsWith(base)).length + 1;
  return `${base} ${n}`;
}

export function makeSketch(doc: Document, plane: PlaneName = "XY", offset = 0, sketch: SketchData = emptySketch()): SketchFeature {
  return {
    type: "sketch",
    id: newId("sk"),
    name: nextName(doc, "Sketch"),
    suppressed: false,
    plane,
    offset,
    sketch,
  };
}

export function makeExtrude(doc: Document, sketchId: string, op: BooleanOp): ExtrudeFeature {
  return {
    type: "extrude",
    id: newId("ex"),
    name: nextName(doc, "Extrude"),
    suppressed: false,
    sketchId,
    distance: 20,
    op,
  };
}

export function makeRevolve(doc: Document, sketchId: string, op: BooleanOp): RevolveFeature {
  return {
    type: "revolve",
    id: newId("rv"),
    name: nextName(doc, "Revolve"),
    suppressed: false,
    sketchId,
    axis: "Y",
    angle: 360,
    op,
  };
}

export function makeSweep(doc: Document, sketchId: string, pathId: string, op: BooleanOp): SweepFeature {
  return { type: "sweep", id: newId("sw"), name: nextName(doc, "Sweep"), suppressed: false, sketchId, pathId, op };
}

export function makeLoft(doc: Document, sections: string[], op: BooleanOp): LoftFeature {
  return { type: "loft", id: newId("lo"), name: nextName(doc, "Loft"), suppressed: false, sections, ruled: false, op };
}

export function makeDraft(doc: Document, faces: string[], neutral = ""): DraftFeature {
  return { type: "draft", id: newId("dr"), name: nextName(doc, "Draft"), suppressed: false, faces, neutral, angle: 3 };
}

export function makeBoolean(doc: Document, target: BodyId | "", op: BooleanFeature["op"] = "join"): BooleanFeature {
  return { type: "boolean", id: newId("bo"), name: nextName(doc, "Boolean"), suppressed: false, op, target, tools: [], keepTools: false };
}

export function makeLayFlat(doc: Document, face: string): LayFlatFeature {
  return { type: "layflat", id: newId("lf"), name: nextName(doc, "Lay flat"), suppressed: false, face };
}

/** Sketches a feature consumes, with the regions it uses (all when absent). */
export function sketchUses(f: Feature): { sketchId: string; regions?: string[] }[] {
  switch (f.type) {
    case "extrude":
    case "revolve":
      return [{ sketchId: f.sketchId, regions: f.regions }];
    case "sweep":
      return [{ sketchId: f.sketchId, regions: f.regions }, { sketchId: f.pathId }];
    case "loft":
      return f.sections.map((sketchId) => ({ sketchId }));
    default:
      return [];
  }
}

export function makeEdgeTreatment(doc: Document, type: "fillet" | "chamfer"): EdgeTreatmentFeature {
  return {
    type,
    id: newId(type === "fillet" ? "fi" : "ch"),
    name: nextName(doc, type === "fillet" ? "Fillet" : "Chamfer"),
    suppressed: false,
    size: 1,
    edges: [],
  };
}

export function makeCove(doc: Document, edges: string[], size = 2): CoveFeature {
  return { type: "cove", id: newId("cv"), name: nextName(doc, "Cove"), suppressed: false, size, edges };
}

export function makeSketchOnFace(doc: Document, face: string): SketchFeature {
  return { ...makeSketch(doc, "XY", 0), face };
}

export function makePushPull(doc: Document, face: string, distance = 10): PushPullFeature {
  return { type: "pushpull", id: newId("pp"), name: nextName(doc, "Push/Pull"), suppressed: false, face, distance };
}

export function makeShell(doc: Document, faces: string[]): ShellFeature {
  return { type: "shell", id: newId("sh"), name: nextName(doc, "Shell"), suppressed: false, faces, thickness: 2 };
}

export function makeMirror(doc: Document): MirrorFeature {
  return { type: "mirror", id: newId("mi"), name: nextName(doc, "Mirror"), suppressed: false, plane: "YZ", offset: 0 };
}

export function makePattern(doc: Document): PatternFeature {
  return { type: "pattern", id: newId("pa"), name: nextName(doc, "Pattern"), suppressed: false, mode: "linear", axis: "X", count: 3, spacing: 50, angle: 360 };
}

export function makeImport(fileName: string, format: "step" | "stl", data: string, op: BooleanOp): ImportFeature {
  return { type: "import", id: newId("im"), name: fileName, suppressed: false, fileName, format, data, op };
}

/** Latest non-suppressed sketch at or before `index` (defaults to end). */
export function lastSketch(doc: Document, index = doc.features.length - 1): SketchFeature | undefined {
  for (let i = index; i >= 0; i--) {
    const f = doc.features[i];
    if (f.type === "sketch" && !f.suppressed) return f;
  }
  return undefined;
}

export function hasBody(doc: Document) {
  return doc.features.some((f) => (f.type === "extrude" || f.type === "revolve" || f.type === "sweep" || f.type === "loft" || f.type === "import") && !f.suppressed);
}

/** Removing a sketch also removes the features that consume it. */
export function removeFeature(doc: Document, id: string): Document {
  const dependents = new Set([id]);
  for (const f of doc.features) {
    if (sketchUses(f).some((u) => dependents.has(u.sketchId))) dependents.add(f.id);
  }
  return { ...doc, features: doc.features.filter((f) => !dependents.has(f.id)) };
}

export function updateFeature(doc: Document, id: string, patch: Partial<Feature>): Document {
  return { ...doc, features: doc.features.map((f) => (f.id === id ? ({ ...f, ...patch } as Feature) : f)) };
}

export function demoDocument(): Document {
  const doc: Document = { variables: [], features: [] };

  // Base plate: 40 x 30 rectangle, dimensioned.
  let base = addRectangle(emptySketch(), -20, -15, 20, 15);
  const [bottom, right] = base.ids;
  base = addConstraint(base.sketch, { kind: "length", line: bottom, value: 40 });
  base = addConstraint(base.sketch, { kind: "length", line: right, value: 30 });
  const baseSketch = makeSketch(doc, "XY", 0, base.sketch);
  doc.features.push(baseSketch);
  doc.features.push({ ...makeExtrude(doc, baseSketch.id, "new"), distance: 20 });

  // Hole on the top face.
  let hole = addCircle(emptySketch(), 0, 0, 8);
  hole = addConstraint(hole.sketch, { kind: "radius", circle: hole.ids[0], value: 8 });
  const holeSketch = makeSketch(doc, "XY", 20, hole.sketch);
  doc.features.push(holeSketch);
  doc.features.push({ ...makeExtrude(doc, holeSketch.id, "cut"), distance: -12 });

  doc.features.push(makeEdgeTreatment(doc, "fillet"));
  return doc;
}
