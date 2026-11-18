// Parametric feature model. A document is an ordered list of features;
// the kernel replays them from scratch to produce the current solid.

import type { SketchData } from "../sketch/model";
import type { Frame, Vec3 } from "./frame";

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
  /** Construction plane feature to sketch on (takes precedence over `face` and `plane`). */
  planeId?: string;
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
  /** Region ids of the sketch to use (see sketchRegions); all closed regions when absent. */
  regions?: string[];
  distance: number;
  /** Cut (or intersect) all the way through the target body, in the direction of `distance`. */
  throughAll?: boolean;
  op: BooleanOp;
  target?: BodyId;
}

export interface RevolveFeature extends FeatureBase {
  type: "revolve";
  sketchId: string;
  /** Region ids of the sketch to use; all closed regions when absent. */
  regions?: string[];
  /** World axis through the origin, used when `axisLine` isn't set. */
  axis: "X" | "Y" | "Z";
  /** A line of the sketch to revolve around (overrides `axis`). */
  axisLine?: string;
  angle: number;
  op: BooleanOp;
  target?: BodyId;
}

/** Moves the profile of one sketch along the path drawn in another. */
export interface SweepFeature extends FeatureBase {
  type: "sweep";
  /** Sketch with the profile. */
  sketchId: string;
  /** Region ids of the profile sketch; all closed regions when absent. */
  regions?: string[];
  /** Sketch with the path: one chain of curves, or a single closed curve. */
  pathId: string;
  op: BooleanOp;
  target?: BodyId;
}

/** A solid through the closed profiles of several sketches, in order. */
export interface LoftFeature extends FeatureBase {
  type: "loft";
  /** Sketch ids; each contributes its largest closed region. */
  sections: string[];
  /** Straight between profiles instead of smooth. */
  ruled: boolean;
  op: BooleanOp;
  target?: BodyId;
}

/** Tilts faces by `angle` degrees, pivoting where they meet the plane of the `neutral` face. */
export interface DraftFeature extends FeatureBase {
  type: "draft";
  faces: string[];
  /** Planar face whose plane stays fixed; the pull direction points away from it. */
  neutral: string;
  angle: number;
}

export interface EdgeTreatmentFeature extends FeatureBase {
  type: "fillet" | "chamfer";
  size: number;
  /** Persistent edge names to treat (see kernel/naming.ts); empty means every edge. */
  edges: string[];
  /** Per-edge sizes overriding `size`, keyed by persistent edge name. */
  overrides?: Record<string, number>;
}

/**
 * Concave rounding of edges (a "cove"): removes a cylinder of radius `size`
 * centred on each edge, leaving a quarter-round groove.
 */
export interface CoveFeature extends FeatureBase {
  type: "cove";
  size: number;
  /** Persistent edge names (at least one). */
  edges: string[];
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

/** Combines existing bodies: the tools are added to, taken from or intersected with the target. */
export interface BooleanFeature extends FeatureBase {
  type: "boolean";
  op: "join" | "cut" | "intersect";
  /** Body that receives the result (keeps its id). */
  target: BodyId;
  tools: BodyId[];
  /** Keep the tool bodies as they are (otherwise they're consumed). */
  keepTools: boolean;
  /** Subtract only: gap left around the tools (mm), e.g. for parts that must fit together. */
  clearance?: number;
}

/**
 * Construction plane, to sketch on:
 * - offset: parallel to a planar face (or a standard plane) at `distance`;
 * - angle: through a straight edge, turned `angle` degrees from a planar face;
 * - midplane: halfway between two parallel planar faces;
 * - normal: perpendicular to an edge, at `position` (0 start … 1 end) along it.
 */
export interface PlaneFeature extends FeatureBase {
  type: "plane";
  mode: "offset" | "angle" | "midplane" | "normal";
  /** Offset from a standard plane when `face` is absent. */
  base?: PlaneName;
  face?: string;
  /** Midplane: the second face. */
  face2?: string;
  /** Angle: the hinge (straight edge); normal: the edge the plane cuts. */
  edge?: string;
  distance: number;
  angle: number;
  position: number;
}

/** A construction plane as shown in the viewport. */
export interface PlanePreview {
  id: string;
  frame: Frame;
  /** Where to draw it (the plane's frame origin can be far from the model). */
  center: Vec3;
  /** Side of the square drawn, mm. */
  size: number;
}

/** 3D printing: a 45° roof over horizontal holes, so they print without supports. */
export interface TeardropFeature extends FeatureBase {
  type: "teardrop";
  /** Cylindrical hole faces. */
  faces: string[];
  /** Cut the roof flat at the top of the hole (a short bridge) instead of a point. */
  flat: boolean;
}

/** 3D printing: enlarges holes by `amount` (radius, mm), as printed holes come out small. */
export interface HoleFitFeature extends FeatureBase {
  type: "holefit";
  faces: string[];
  amount: number;
}

/** 3D printing: seats for heat-set threaded inserts, in existing holes from their opening. */
export interface InsertFeature extends FeatureBase {
  type: "insert";
  /** Cylindrical hole faces (the pilot holes). */
  faces: string[];
  /** Preset the size came from, or "custom". */
  size: "M2" | "M2.5" | "M3" | "M4" | "M5" | "custom";
  /** Seat diameter, mm. */
  diameter: number;
  /** Seat depth from the hole's opening, mm. */
  depth: number;
  /** For a through hole: seat at the lower opening instead of the upper. */
  flip: boolean;
}

/** 3D printing: turns the body so a planar face lies on the bed (z = 0, facing down). */
export interface LayFlatFeature extends FeatureBase {
  type: "layflat";
  face: string;
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
  | SweepFeature
  | LoftFeature
  | DraftFeature
  | EdgeTreatmentFeature
  | CoveFeature
  | PushPullFeature
  | ShellFeature
  | MirrorFeature
  | PatternFeature
  | TransformFeature
  | BooleanFeature
  | LayFlatFeature
  | PlaneFeature
  | TeardropFeature
  | HoleFitFeature
  | InsertFeature
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
  /** 2D technical drawing of the model (one sheet). */
  drawing?: DrawingSheet;
}

// ---- 2D drawings ----------------------------------------------------------

/** Standard view directions; "iso" looks from front-right-top. */
export type ViewDir = "front" | "back" | "top" | "bottom" | "left" | "right" | "iso";

export interface DrawingView {
  id: string;
  dir: ViewDir;
  /** Centre of the view on the sheet, paper mm from the bottom-left corner. */
  x: number;
  y: number;
  /** Draw hidden edges dashed. */
  hidden: boolean;
}

export type DimensionKind = "horizontal" | "vertical" | "aligned" | "diameter" | "radius";

/**
 * A dimension on a view. Points are in the view's own coordinates (model mm,
 * x right, y up) and re-snap to the nearest vertex or circle when the model changes.
 */
export interface DrawingDimension {
  id: string;
  view: string;
  kind: DimensionKind;
  a: [number, number];
  /** Second point (linear kinds). */
  b?: [number, number];
  /** Diameter/radius: radius of the circle picked (tells concentric circles apart). */
  r?: number;
  /** Linear: distance of the dimension line from the measured points (paper mm, signed). Circles: angle of the leader (degrees). */
  offset: number;
}

export interface DrawingSheet {
  size: "A4" | "A3" | "A2" | "A1";
  orientation: "landscape" | "portrait";
  /** Paper mm per model mm (2 = 2:1, 0.5 = 1:2). */
  scale: number;
  /** "first": ISO, Europe (top view below the front); "third": ASME (top view above). */
  projection: "first" | "third";
  title: string;
  author: string;
  views: DrawingView[];
  dimensions: DrawingDimension[];
}

/** Hidden-line projection of the model for one view (view coordinates, model mm). */
export interface ViewProjection {
  dir: ViewDir;
  /** Segments as x1, y1, x2, y2, … */
  visible: Float32Array;
  hidden: Float32Array;
  /** Snap points: ends of edges. */
  points: [number, number][];
  /** Circles and arcs (for diameter and radius dimensions). */
  circles: { cx: number; cy: number; r: number }[];
  bounds: { minX: number; minY: number; maxX: number; maxY: number } | null;
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
  /** Whether each face is a cylinder (holes, pins). */
  faceCylindrical?: boolean[];
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
  /** The sketch plane in world space (where the sketch's local coordinates live). */
  frame: Frame;
  /** Pickable regions, as polygons in sketch coordinates (flat x, y pairs). */
  regions: RegionPreview[];
}

export interface RegionPreview {
  id: string;
  outer: Float32Array;
  holes: Float32Array[];
  /** A point inside the region (not in a hole), in sketch coordinates. */
  inside: [number, number];
}

/** What to measure: named faces and edges of the final model, or one body. */
export interface MeasureSelection {
  faces: string[];
  edges: string[];
  body: BodyId | null;
}

/** One line of a measurement: a number with a unit, or preformatted text. */
export type MeasureRow = { label: string; value: number; unit: "mm" | "mm²" | "mm³" | "°" } | { label: string; text: string };

export interface Measurement {
  title: string;
  rows: MeasureRow[];
  /** For a body: the numbers print estimates need. */
  body?: { volume: number; area: number; size: [number, number, number] };
}

/** Tessellation of exported meshes: chord tolerance and angle (draft 0.05 mm / 15°, normal 0.01 / 5°, fine 0.002 / 2°). */
export type MeshQuality = "draft" | "normal" | "fine";

/** One body's triangles for a mesh export. */
export interface ExportPart {
  id: BodyId;
  vertices: Float32Array;
  triangles: Uint32Array;
}

export type KernelRequest =
  | { kind: "evaluate"; seq: number; doc: Document; stopBefore?: string; preview?: boolean }
  | { kind: "measure"; seq: number; doc: Document; selection: MeasureSelection }
  | { kind: "export"; seq: number; doc: Document; format: "step" | "mesh"; bodies?: BodyId[]; quality?: MeshQuality }
  | { kind: "project"; seq: number; doc: Document; dirs: ViewDir[] };

export type KernelResponse =
  /** `threads`: OCCT worker threads available to Booleans (1 = single-threaded build). */
  | { kind: "ready"; threads?: number }
  | { kind: "init-error"; error: string }
  | {
      kind: "evaluated";
      seq: number;
      mesh: MeshData | null;
      bodies: { id: BodyId; faces: number }[];
      sketches: SketchPreview[];
      planes?: PlanePreview[];
      status: FeatureStatus[];
      ms: number;
    }
  | { kind: "measured"; seq: number; measurement?: Measurement; error?: string }
  | { kind: "projected"; seq: number; views?: ViewProjection[]; error?: string }
  | { kind: "exported"; seq: number; blob?: Blob; parts?: ExportPart[]; error?: string };
