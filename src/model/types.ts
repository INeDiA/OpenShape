// Parametric feature model. A document is an ordered list of features;
// the kernel replays them from scratch to produce the current solid.

import type { SketchData } from "../sketch/model";

export type PlaneName = "XY" | "XZ" | "YZ";

/** Fields shared by every feature. */
interface FeatureBase {
  id: string;
  name: string;
  suppressed: boolean;
  /** Numeric fields driven by an expression, e.g. { distance: "height / 2" }. */
  exprs?: Partial<Record<string, string>>;
}

export interface SketchFeature extends FeatureBase {
  type: "sketch";
  /** Standard plane; ignored when `face` is set. */
  plane: PlaneName;
  /** Persistent name of a planar face to sketch on (see kernel/naming.ts). */
  face?: string;
  /** Distance along the plane normal. */
  offset: number;
  sketch: SketchData;
}

export type BooleanOp = "new" | "join" | "cut" | "intersect";

/**
 * Bodies are identified by the id of the feature that created them
 * (an extrude/revolve/import with op "new"). Features that modify a body take
 * an optional `target`; without it they act on the most recently touched body.
 */
export type BodyId = string;

export interface ExtrudeFeature extends FeatureBase {
  type: "extrude";
  sketchId: string;
  distance: number;
  op: BooleanOp;
  target?: BodyId;
}

export interface RevolveFeature extends FeatureBase {
  type: "revolve";
  sketchId: string;
  /** Axis in the sketch plane's global frame. */
  axis: "X" | "Y" | "Z";
  angle: number;
  op: BooleanOp;
  target?: BodyId;
}

export interface EdgeTreatmentFeature extends FeatureBase {
  type: "fillet" | "chamfer";
  size: number;
  /** Persistent edge names to treat (see kernel/naming.ts); empty means every edge. */
  edges: string[];
  /** Per-edge sizes overriding `size`, keyed by persistent edge name. */
  overrides?: Record<string, number>;
}

/** Moves a planar face along its normal: positive adds material, negative removes it. */
export interface PushPullFeature extends FeatureBase {
  type: "pushpull";
  face: string;
  distance: number;
}

/** Hollows the body; `faces` are removed to open it (empty = closed hollow). */
export interface ShellFeature extends FeatureBase {
  type: "shell";
  faces: string[];
  thickness: number;
}

/** Mirrors the body across a standard plane and joins the copy. */
export interface MirrorFeature extends FeatureBase {
  type: "mirror";
  plane: PlaneName;
  offset: number;
  target?: BodyId;
}

/** Repeats the body: linear along an axis or circular around it, joined. */
export interface PatternFeature extends FeatureBase {
  type: "pattern";
  mode: "linear" | "circular";
  axis: "X" | "Y" | "Z";
  /** Total number of instances, including the original. */
  count: number;
  /** Linear: distance between instances (mm). */
  spacing: number;
  /** Circular: total angle covered (degrees); 360 spreads instances evenly. */
  angle: number;
  target?: BodyId;
}

/** Moves and/or rotates one body (rotation about an axis through `pivot`, then translation). */
export interface TransformFeature extends FeatureBase {
  type: "transform";
  body: BodyId;
  dx: number;
  dy: number;
  dz: number;
  axis: "X" | "Y" | "Z";
  angle: number;
  pivotX: number;
  pivotY: number;
  pivotZ: number;
}

/** A solid imported from a STEP or STL file, embedded in the document. */
export interface ImportFeature extends FeatureBase {
  type: "import";
  fileName: string;
  format: "step" | "stl";
  /** File content, base64. */
  data: string;
  op: BooleanOp;
  target?: BodyId;
}

export type Feature =
  | SketchFeature
  | ExtrudeFeature
  | RevolveFeature
  | EdgeTreatmentFeature
  | PushPullFeature
  | ShellFeature
  | MirrorFeature
  | PatternFeature
  | TransformFeature
  | ImportFeature;

export interface Variable {
  id: string;
  name: string;
  /** Expression source; may reference earlier or later variables (no cycles). */
  expr: string;
  /** Last computed value, cached so the document is usable without re-evaluating. */
  value: number;
}

export interface Document {
  variables: Variable[];
  features: Feature[];
}

// ---- Kernel protocol -------------------------------------------------------

export interface MeshData {
  vertices: Float32Array;
  normals: Float32Array;
  triangles: Uint32Array;
  faceGroups: { start: number; count: number; faceId: number }[];
  /** Persistent name of each face group (same order as faceGroups). */
  faceNames: string[];
  /** Whether each face is planar (sketch on face, push/pull). */
  facePlanar: boolean[];
  /** Body each face belongs to. */
  faceBody: BodyId[];
  edges: Float32Array;
  /** Ranges of `edges` vertices (pairs) per kernel edge. */
  edgeGroups: { start: number; count: number; edgeId: number }[];
  /** Persistent name of each edge group. */
  edgeNames: string[];
  /** Body each edge group belongs to. */
  edgeBody: BodyId[];
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
  /** For sketches on a face: the face's edges as 2D segment pairs in sketch coordinates. */
  reference?: Float32Array;
}

export type KernelRequest =
  | { kind: "evaluate"; seq: number; doc: Document; stopBefore?: string; preview?: boolean }
  | { kind: "export"; seq: number; doc: Document; format: "step" | "mesh" };

export type KernelResponse =
  | { kind: "ready" }
  | { kind: "init-error"; error: string }
  | {
      kind: "evaluated";
      seq: number;
      mesh: MeshData | null;
      bodies: { id: BodyId; faces: number }[];
      sketches: SketchPreview[];
      status: FeatureStatus[];
      ms: number;
    }
  | { kind: "exported"; seq: number; blob?: Blob; mesh?: { vertices: Float32Array; triangles: Uint32Array }; error?: string };
