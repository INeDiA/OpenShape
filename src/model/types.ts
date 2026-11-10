// Parametric feature model. A document is an ordered list of features;
// the kernel replays them from scratch to produce the current solid.

import type { SketchData } from "../sketch/model";

export type PlaneName = "XY" | "XZ" | "YZ";

export interface SketchFeature {
  type: "sketch";
  id: string;
  name: string;
  suppressed: boolean;
  plane: PlaneName;
  offset: number;
  sketch: SketchData;
}

export type BooleanOp = "new" | "join" | "cut" | "intersect";

export interface ExtrudeFeature {
  type: "extrude";
  id: string;
  name: string;
  suppressed: boolean;
  sketchId: string;
  distance: number;
  op: BooleanOp;
}

export interface RevolveFeature {
  type: "revolve";
  id: string;
  name: string;
  suppressed: boolean;
  sketchId: string;
  /** Axis in the sketch plane's global frame. */
  axis: "X" | "Y" | "Z";
  angle: number;
  op: BooleanOp;
}

export interface EdgeTreatmentFeature {
  type: "fillet" | "chamfer";
  id: string;
  name: string;
  suppressed: boolean;
  /** Applied to every edge of the current body (edge picking comes later). */
  size: number;
}

export type Feature = SketchFeature | ExtrudeFeature | RevolveFeature | EdgeTreatmentFeature;

export interface Document {
  features: Feature[];
}

// ---- Kernel protocol -------------------------------------------------------

export interface MeshData {
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  faceGroups: { start: number; count: number; faceId: number }[];
  edges: Float32Array;
}

export interface FeatureStatus {
  id: string;
  ok: boolean;
  error?: string;
}

export interface SketchPreview {
  id: string;
  /** Line segment pairs in world space, flattened xyz (for THREE.LineSegments). */
  segments: Float32Array;
}

export type KernelRequest =
  | { kind: "evaluate"; seq: number; doc: Document }
  | { kind: "export"; seq: number; doc: Document; format: "step" | "stl" };

export type KernelResponse =
  | { kind: "ready" }
  | { kind: "init-error"; error: string }
  | {
      kind: "evaluated";
      seq: number;
      mesh: MeshData | null;
      sketches: SketchPreview[];
      status: FeatureStatus[];
      ms: number;
    }
  | { kind: "exported"; seq: number; blob: Blob | null; error?: string };
