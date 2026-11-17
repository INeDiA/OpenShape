// Boolean operations straight on OCCT, instead of replicad's fuse/cut/intersect.
//
// - Each operation is built once. replicad passes both shapes to the OCCT
//   constructor (which already computes the result) and then calls Build()
//   again, so every Boolean ran twice; with glue it first ran without it.
// - Parallel mode is switched on when the multi-threaded WASM build is loaded
//   (see setBooleanParallel), which speeds up large operations several times.

import { cast, getOC, makeCompound, type Shape3D, type Solid } from "replicad";
import type { Vec3 } from "../model/frame";

let parallel = false;

/** Use OCCT's parallel mode (only meaningful with the multi-threaded build). */
export function setBooleanParallel(on: boolean) {
  parallel = on;
}

type ShapeList = { Append(s: unknown): void; delete(): void };
interface BuilderAlgo {
  SetArguments(l: ShapeList): void;
  SetTools(l: ShapeList): void;
  SetGlue(g: unknown): void;
  SetRunParallel(on: boolean): void;
  Build(): void;
  HasErrors(): boolean;
  SimplifyResult(unifyEdges: boolean, unifyFaces: boolean, angularTol: number): void;
  Shape(): unknown;
  delete(): void;
}
type OC = {
  NCollection_List_TopoDS_Shape: new () => ShapeList;
  BRepAlgoAPI_Fuse: new () => BuilderAlgo;
  BRepAlgoAPI_Cut: new () => BuilderAlgo;
  BRepAlgoAPI_Common: new () => BuilderAlgo;
  BRepAlgoAPI_Splitter: new () => BuilderAlgo;
  BOPAlgo_GlueEnum: { BOPAlgo_GlueShift: unknown };
  gp_Pnt: new (x: number, y: number, z: number) => { delete(): void };
  gp_Dir: new (x: number, y: number, z: number) => { delete(): void };
  gp_Pln: new (p: unknown, d: unknown) => { delete(): void };
  BRepBuilderAPI_MakeFace: new (pln: unknown) => { Face(): { delete(): void }; delete(): void };
};

const wrapped = (s: Shape3D) => (s as unknown as { wrapped: unknown }).wrapped;

interface Options {
  /** The shapes only meet along shared faces (OCCT's much faster glue mode). */
  glue?: boolean;
  /** Merge same-domain faces and edges afterwards, like replicad does by default. */
  simplify?: boolean;
}

function run(kind: "Fuse" | "Cut" | "Common" | "Splitter", shape: Shape3D, tools: unknown[], opts: Options = {}): Shape3D {
  const oc = getOC() as unknown as OC;
  const args = new oc.NCollection_List_TopoDS_Shape();
  const toolList = new oc.NCollection_List_TopoDS_Shape();
  const b = new oc[`BRepAlgoAPI_${kind}`]();
  try {
    args.Append(wrapped(shape));
    for (const t of tools) toolList.Append(t);
    b.SetArguments(args);
    b.SetTools(toolList);
    if (opts.glue) b.SetGlue(oc.BOPAlgo_GlueEnum.BOPAlgo_GlueShift);
    b.SetRunParallel(parallel);
    b.Build();
    if (b.HasErrors()) throw new Error(`The ${kind === "Common" ? "intersection" : kind.toLowerCase()} failed`);
    if (opts.simplify !== false && kind !== "Splitter") b.SimplifyResult(true, true, 1e-3);
    return cast(b.Shape() as Parameters<typeof cast>[0]) as Shape3D;
  } finally {
    b.delete();
    args.delete();
    toolList.delete();
  }
}

export const fuseShapes = (shape: Shape3D, tools: Shape3D[], opts?: Options) => run("Fuse", shape, tools.map(wrapped), opts);
export const cutShapes = (shape: Shape3D, tools: Shape3D[], opts?: Options) => run("Cut", shape, tools.map(wrapped), opts);
export const commonShapes = (shape: Shape3D, tools: Shape3D[], opts?: Options) => run("Common", shape, tools.map(wrapped), opts);

/**
 * `shape` grown by `distance` in every direction (shrunk when negative): a
 * true offset, so convex edges become rounds of that radius and the gap to
 * the original is the same everywhere.
 */
export function offsetSolid(shape: Shape3D, distance: number): Shape3D {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const maker = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    maker.PerformByJoin(wrapped(shape), distance, 1e-6, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
    if (!maker.IsDone()) throw new Error(`Can't offset the body by ${distance} mm`);
    return cast(maker.Shape()) as Shape3D;
  } finally {
    maker.delete();
  }
}

/** The parts of `shape` on each side of the plane through `origin` with normal `n` (null when empty). */
export function splitByPlane(shape: Shape3D, origin: Vec3, n: Vec3): { above: Shape3D | null; below: Shape3D | null } {
  const oc = getOC() as unknown as OC;
  const p = new oc.gp_Pnt(origin[0], origin[1], origin[2]);
  const d = new oc.gp_Dir(n[0], n[1], n[2]);
  const pln = new oc.gp_Pln(p, d);
  const maker = new oc.BRepBuilderAPI_MakeFace(pln);
  const face = maker.Face();
  let pieces: Solid[];
  try {
    pieces = run("Splitter", shape, [face]).solids;
  } finally {
    face.delete();
    maker.delete();
    pln.delete();
    d.delete();
    p.delete();
  }
  // Each piece lies on one side: classify it by its bounding box center.
  const above: Solid[] = [], below: Solid[] = [];
  for (const s of pieces) {
    const [lo, hi] = s.boundingBox.bounds;
    const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
    const side = (c[0] - origin[0]) * n[0] + (c[1] - origin[1]) * n[1] + (c[2] - origin[2]) * n[2];
    if (side > 1e-7) above.push(s);
    else if (side < -1e-7) below.push(s);
  }
  const group = (list: Solid[]): Shape3D | null => (list.length === 0 ? null : list.length === 1 ? list[0] : (makeCompound(list) as Shape3D));
  return { above: group(above), below: group(below) };
}
