import type {
  BooleanOp,
  Document,
  EdgeTreatmentFeature,
  ExtrudeFeature,
  Feature,
  PlaneName,
  RevolveFeature,
  SketchFeature,
} from "./types";
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

export function makeEdgeTreatment(doc: Document, type: "fillet" | "chamfer"): EdgeTreatmentFeature {
  return {
    type,
    id: newId(type === "fillet" ? "fi" : "ch"),
    name: nextName(doc, type === "fillet" ? "Fillet" : "Chamfer"),
    suppressed: false,
    size: 1,
  };
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
  return doc.features.some((f) => (f.type === "extrude" || f.type === "revolve") && !f.suppressed);
}

/** Removing a sketch also removes the features that consume it. */
export function removeFeature(doc: Document, id: string): Document {
  const dependents = new Set([id]);
  for (const f of doc.features) {
    if ((f.type === "extrude" || f.type === "revolve") && dependents.has(f.sketchId)) dependents.add(f.id);
  }
  return { features: doc.features.filter((f) => !dependents.has(f.id)) };
}

export function updateFeature(doc: Document, id: string, patch: Partial<Feature>): Document {
  return { features: doc.features.map((f) => (f.id === id ? ({ ...f, ...patch } as Feature) : f)) };
}

export function demoDocument(): Document {
  const doc: Document = { features: [] };

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
