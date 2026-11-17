// Replays the feature list on top of replicad/OpenCascade.
// Runs inside the kernel worker (and in Node tests); keep it free of DOM and React.

import {
  basicFaceExtrusion,
  draw,
  drawCircle,
  drawEllipse,
  getOC,
  importSTEP,
  makeCompound,
  makePolygon,
  makeSolid,
  Plane,
  Vector,
  type AnyShape,
  type Drawing,
  type Face,
  type Shape3D,
  type Wire,
} from "replicad";
import {
  copyNames,
  faceSamples,
  nameByOrder,
  nameEdges,
  nameExtrusion,
  nameFaceExtrusion,
  nameRevolution,
  nearestEdgeName,
  transferNames,
  type FaceNames,
  type NamedShape,
} from "./naming";
import type { BodyId, BooleanOp, Document, Feature, FeatureStatus, MeshData, RegionPreview, SketchFeature, SketchPreview } from "../model/types";
import { frameToLocal, frameToWorld, planeFrame, standardFrame, type Frame, type Vec3 } from "../model/frame";
import { entityMap, pointOf } from "../sketch/model";
import { curvePolyline } from "../sketch/curves";
import { commonShapes, cutShapes, fuseShapes, offsetSolid } from "./booleans";
import { coveTool } from "./cove";
import { arcMidpoint, findLoops, loopPolygon, nestLoops, regionInteriorPoint, sketchRegions, type Loop } from "../sketch/profiles";
import { parseSTL } from "../io/stl";
import { stretchFace } from "./stretch";
import { treatEdges } from "./edgeTreatment";
import { blendCorners, mixedRadiusCorners } from "./vertexBlend";
import { loftThrough, sweepAlong } from "./sweepLoft";
import { draftFaces } from "./draft";
import { sketchPath, type SketchPath } from "../sketch/path";
import { loopArea } from "../sketch/profiles";

export interface EvaluationResult {
  /** All bodies combined (a compound when there are several): for display and export. */
  body: NamedShape | null;
  /** Individual bodies in creation order. */
  bodies: { id: BodyId; shape: NamedShape }[];
  /** Face hash (in `body`) -> owning body id. */
  faceBody: Map<number, BodyId>;
  sketches: SketchPreview[];
  status: FeatureStatus[];
  /** True when `body` is a compound made for this result and may be freed by the caller. */
  ownsBody: boolean;
  /** Features taken from the incremental cache instead of being recomputed. */
  reused: number;
}

// ---- sketches -------------------------------------------------------------------

function loopDrawing(l: Loop): Drawing {
  if (l.kind === "circle") return drawCircle(l.r).translate(l.cx, l.cy);
  if (l.kind === "ellipse") return drawEllipse(l.a, l.b).rotate((l.angle * 180) / Math.PI, [0, 0]).translate(l.cx, l.cy);
  let pen = draw(l.start);
  for (const s of l.segments) {
    if (s.kind === "line") pen = pen.lineTo(s.to);
    else if (s.kind === "arc") pen = pen.threePointsArcTo(s.to, s.mid);
    else pen = pen.cubicBezierCurveTo(s.to, s.c1, s.c2);
  }
  return pen.close();
}

/** The drawing of a sweep path (open unless it closes on itself). */
function pathDrawing(p: SketchPath): Drawing {
  if (p.kind !== "path") return loopDrawing(p);
  let pen = draw(p.start);
  for (const s of p.segments) {
    if (s.kind === "line") pen = pen.lineTo(s.to);
    else if (s.kind === "arc") pen = pen.threePointsArcTo(s.to, s.mid);
    else pen = pen.cubicBezierCurveTo(s.to, s.c1, s.c2);
  }
  return p.closed ? pen.close() : pen.done();
}

/**
 * Builds the sketch region: outer loops add material, nested loops become
 * holes. With `regions`, only those regions (each minus the loops inside it).
 */
function sketchDrawing(f: SketchFeature, regions?: string[]): Drawing {
  if (regions?.length) {
    const all = sketchRegions(f.sketch);
    let result: Drawing | null = null;
    for (const id of regions) {
      const r = all.find((x) => x.id === id);
      if (!r) throw new Error(`A selected region of ${f.name} no longer exists: pick the regions again`);
      let d = loopDrawing(r.loop);
      for (const h of r.holes) d = d.cut(loopDrawing(h));
      result = result ? result.fuse(d) : d;
    }
    return result!;
  }
  const { loops } = findLoops(f.sketch);
  if (loops.length === 0) throw new Error("Sketch has no closed profile");
  let result: Drawing | null = null;
  for (const { loop, depth } of nestLoops(loops)) {
    const d = loopDrawing(loop);
    if (!result) result = d;
    else result = depth % 2 === 0 ? result.fuse(d) : result.cut(d);
  }
  return result!;
}

/** Region outlines for picking in the viewport. */
function regionPreviews(f: SketchFeature): RegionPreview[] {
  const flat = (l: Loop) => new Float32Array(loopPolygon(l, 24).flat());
  try {
    return sketchRegions(f.sketch).map((r) => ({ id: r.id, outer: flat(r.loop), holes: r.holes.map(flat), inside: regionInteriorPoint(r) }));
  } catch {
    return [];
  }
}

const replicadPlane = (fr: Frame) => new Plane(fr.origin, fr.x, fr.n);

/** World-space line segments for the viewport preview of a sketch. */
function sketchSegments(f: SketchFeature, fr: Frame): Float32Array {
  const m = entityMap(f.sketch);
  const out: number[] = [];
  const seg = (a: [number, number], b: [number, number]) => out.push(...frameToWorld(fr, a[0], a[1]), ...frameToWorld(fr, b[0], b[1]));
  const ring = (pts: [number, number][], closed: boolean) => {
    for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) seg(pts[i], pts[(i + 1) % pts.length]);
  };
  for (const e of f.sketch.entities) {
    if (e.kind === "line") {
      const a = pointOf(m, e.p1), b = pointOf(m, e.p2);
      seg([a.x, a.y], [b.x, b.y]);
    } else if (e.kind === "circle") {
      const c = pointOf(m, e.center);
      ring(loopPolygon({ kind: "circle", cx: c.x, cy: c.y, r: e.radius }), true);
    } else if (e.kind === "arc") {
      const s = pointOf(m, e.start), t = pointOf(m, e.end);
      const poly = loopPolygon({ kind: "path", start: [s.x, s.y], segments: [{ kind: "arc", to: [t.x, t.y], mid: arcMidpoint(m, e) }] }, 24);
      ring([...poly, [t.x, t.y]], false);
    } else if (e.kind === "ellipse" || e.kind === "spline") {
      ring(curvePolyline(m, e), false);
    }
  }
  return new Float32Array(out);
}

// ---- faces of the current body ----------------------------------------------------

function faceByName(body: NamedShape | null, name: string): Face {
  if (!body) throw new Error("No body yet");
  for (const f of body.shape.faces) if (body.names.get(f.hashCode) === name) return f;
  throw new Error(`Face "${name}" no longer exists`);
}

function planarFaceFrame(body: NamedShape | null, name: string, offset: number): { face: Face; frame: Frame; point: Vec3; normal: Vec3 } {
  const face = faceByName(body, name);
  if (face.geomType !== "PLANE") throw new Error("The selected face is not planar");
  const s = faceSamples(body!.shape).get(face.hashCode);
  if (!s) throw new Error("Can't evaluate the selected face");
  return { face, frame: planeFrame(s.p, s.n, offset), point: s.p, normal: s.n };
}

/** The face's edges in sketch coordinates, drawn as reference geometry in the editor. */
function faceReference(face: Face, fr: Frame): Float32Array {
  const out: number[] = [];
  for (const e of face.edges) {
    const steps = e.geomType === "LINE" ? 1 : 24;
    let prev = frameToLocal(fr, e.pointAt(0).toTuple() as Vec3);
    for (let k = 1; k <= steps; k++) {
      const cur = frameToLocal(fr, e.pointAt(k / steps).toTuple() as Vec3);
      out.push(prev[0], prev[1], cur[0], cur[1]);
      prev = cur;
    }
  }
  return new Float32Array(out);
}

// ---- solids --------------------------------------------------------------------------

/** `touching`: the tool meets the body only along shared faces (OCCT's faster glue mode applies). */
function booleanOp(body: NamedShape, tool: NamedShape, op: Exclude<BooleanOp, "new">, featureId: string, touching = false): NamedShape {
  const shape = op === "join" ? fuseShapes(body.shape, [tool.shape], { glue: touching }) : op === "cut" ? cutShapes(body.shape, [tool.shape], { glue: touching }) : commonShapes(body.shape, [tool.shape]);
  return { shape, names: transferNames(shape, [body, tool], () => `${featureId}:new`) };
}

/**
 * OCCT can return broken solids instead of failing (e.g. a fillet radius
 * larger than the faces it joins). Refuse them with a readable message.
 */
function ensureValid(shape: Shape3D, what: string): Shape3D {
  const oc = getOC() as unknown as { BRepCheck_Analyzer: new (s: unknown, geom?: boolean) => { IsValid_2?: () => boolean; IsValid?: () => boolean; delete(): void } };
  const a = new oc.BRepCheck_Analyzer((shape as unknown as { wrapped: unknown }).wrapped, true);
  const ok = a.IsValid_2 ? a.IsValid_2() : a.IsValid ? a.IsValid() : true;
  a.delete();
  if (!ok) throw new Error(what);
  return shape;
}

/** Same face names after a rigid transform (face order is preserved). */
function keepNames(original: NamedShape, moved: Shape3D): FaceNames {
  const src = original.shape.faces;
  const names: FaceNames = new Map();
  moved.faces.forEach((f, k) => names.set(f.hashCode, original.names.get(src[k]?.hashCode) ?? `?${k}`));
  return names;
}

/** Joins transformed copies of the body, each named after its original faces. */
function joinCopies(body: NamedShape, copies: Shape3D[], featureId: string): NamedShape {
  let result = body;
  copies.forEach((copy, i) => {
    const named = { shape: copy, names: copyNames(body, copy, `${featureId}:copy${i + 1}`) };
    const shape = fuseShapes(result.shape, [copy]);
    result = { shape, names: transferNames(shape, [result, named], () => `${featureId}:new`) };
  });
  return result;
}

const AXES: Record<"X" | "Y" | "Z", Vec3> = { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] };

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

const MAX_STL_TRIANGLES = 20000;

/**
 * STL meshes become B-rep solids: one planar face per triangle, sewn into a
 * shell, then coplanar faces are merged so flat regions are single faces.
 */
function stlToSolid(bytes: Uint8Array): Shape3D {
  const tris = parseSTL(bytes);
  if (!tris.length) throw new Error("The STL file has no triangles");
  if (tris.length > MAX_STL_TRIANGLES) throw new Error(`STL has ${tris.length} triangles; the limit is ${MAX_STL_TRIANGLES}`);
  const faces: Face[] = [];
  for (const t of tris) {
    const a: Vec3 = [t[0], t[1], t[2]], b: Vec3 = [t[3], t[4], t[5]], c: Vec3 = [t[6], t[7], t[8]];
    const cr = [(b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]), (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]), (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])];
    if (Math.hypot(...cr) < 1e-12) continue; // degenerate
    faces.push(makePolygon([a, b, c]));
  }
  return makeSolid(faces).simplify() as unknown as Shape3D;
}

function asSolid(s: AnyShape): Shape3D {
  if (!("fuse" in s)) throw new Error("The file doesn't contain a solid");
  return s as Shape3D;
}

export interface EvaluateOptions {
  /** Stop replaying before this feature (history rollback, e.g. while editing it). */
  stopBefore?: string;
}

interface SketchContext {
  feature: SketchFeature;
  frame: Frame;
}

/** Mutable modeling state while replaying the history. */
class Bodies {
  readonly map: Map<BodyId, NamedShape>;
  last: BodyId | null = null;

  constructor(from?: { map: Map<BodyId, NamedShape>; last: BodyId | null }) {
    this.map = new Map(from?.map);
    this.last = from?.last ?? null;
  }

  set(id: BodyId, shape: NamedShape) {
    this.map.set(id, shape);
    this.last = id;
  }

  /** Explicit target, else the most recently touched body. */
  target(id?: BodyId): { id: BodyId; shape: NamedShape } | null {
    const key = id && this.map.has(id) ? id : this.last;
    if (id && !this.map.has(id)) throw new Error("Target body no longer exists");
    return key ? { id: key, shape: this.map.get(key)! } : null;
  }

  /** Body that has a face with this persistent name. */
  withFace(name: string): { id: BodyId; shape: NamedShape } {
    for (const [id, b] of this.map) for (const n of b.names.values()) if (n === name) return { id, shape: b };
    throw new Error(`Face "${name}" no longer exists`);
  }

  /** Body that has an edge with this persistent name (edge names come from its faces). */
  withEdge(name: string): { id: BodyId; shape: NamedShape } | null {
    for (const [id, b] of this.map) if (nameEdges(b.shape, b.names).byName.has(name)) return { id, shape: b };
    return null;
  }

  /** Drops a body (consumed by a Boolean). */
  remove(id: BodyId) {
    this.map.delete(id);
    if (this.last === id) this.last = [...this.map.keys()].pop() ?? null;
  }

  /** Combines a new solid with the bodies according to `op`. */
  add(featureId: string, tool: NamedShape, op: BooleanOp, target?: BodyId) {
    const t = op === "new" ? null : this.target(target);
    if (!t) return this.set(featureId, tool);
    this.set(t.id, booleanOp(t.shape, tool, op as Exclude<BooleanOp, "new">, featureId));
  }
}

// ---- incremental evaluation ---------------------------------------------------------
//
// Kernel shapes are immutable (every operation returns a new shape), so the
// state after each feature can be kept and reused: when only the last
// features change (e.g. dragging a push/pull handle), replay starts from the
// last unchanged feature instead of from scratch.

interface Snapshot {
  key: string;
  bodies: Map<BodyId, NamedShape>;
  last: BodyId | null;
  sketches: Map<string, SketchContext>;
  previews: SketchPreview[];
  status: FeatureStatus[];
}

let snapshots: Snapshot[] = [];
const featureJson = new WeakMap<Feature, string>();

/** Drops cached intermediate states (tests, or to free memory). */
export function clearEvaluationCache() {
  snapshots = [];
}

/** FNV-1a over the previous key and this feature's JSON: identifies the history prefix. */
function prefixKey(prev: string, f: Feature): string {
  let json = featureJson.get(f);
  if (json === undefined) {
    json = JSON.stringify(f);
    featureJson.set(f, json);
  }
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  const src = prev + "\u0000" + json;
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x0100019d) >>> 0;
  }
  return `${h1.toString(36)}.${h2.toString(36)}.${src.length}`;
}

export async function evaluate(doc: Document, opts: EvaluateOptions = {}): Promise<EvaluationResult> {
  const stop = opts.stopBefore ? doc.features.findIndex((f) => f.id === opts.stopBefore) : -1;
  const features = stop >= 0 ? doc.features.slice(0, stop) : doc.features;
  const keys: string[] = [];
  features.forEach((f, i) => keys.push(prefixKey(i ? keys[i - 1] : "", f)));

  // Longest cached prefix of this history.
  let reuse = 0;
  while (reuse < features.length && reuse < snapshots.length && snapshots[reuse].key === keys[reuse]) reuse++;
  const from = reuse ? snapshots[reuse - 1] : null;

  const sketches = new Map<string, SketchContext>(from?.sketches);
  const previews: SketchPreview[] = [...(from?.previews ?? [])];
  const status: FeatureStatus[] = [...(from?.status ?? [])];
  const bodies = new Bodies(from ? { map: from.bodies, last: from.last } : undefined);
  const next = snapshots.slice(0, reuse);

  for (let i = reuse; i < features.length; i++) {
    const f = features[i];
    if (f.suppressed) {
      status.push({ id: f.id, ok: true });
    } else {
      try {
        const warning = await applyFeature(f, bodies, sketches, previews);
        status.push(warning ? { id: f.id, ok: false, error: warning } : { id: f.id, ok: true });
      } catch (e) {
        status.push({ id: f.id, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }
    next.push({ key: keys[i], bodies: new Map(bodies.map), last: bodies.last, sketches: new Map(sketches), previews: [...previews], status: [...status] });
  }
  // A shorter history (rollback) keeps the longer cache: it's still a valid prefix.
  if (features.length >= snapshots.length || reuse < features.length) snapshots = next;

  const list = [...bodies.map].map(([id, shape]) => ({ id, shape }));
  const faceBody = new Map<number, BodyId>();
  let body: NamedShape | null = null;
  if (list.length === 1) body = list[0].shape;
  else if (list.length > 1) {
    const names: FaceNames = new Map();
    for (const b of list) for (const [h, n] of b.shape.names) names.set(h, n);
    // makeCompound takes ownership of its inputs: pass clones (same TShape, same face hashes).
    body = { shape: makeCompound(list.map((b) => b.shape.shape.clone())) as unknown as Shape3D, names };
  }
  for (const b of list) for (const f of b.shape.shape.faces) faceBody.set(f.hashCode, b.id);
  return { body, bodies: list, faceBody, sketches: previews, status, ownsBody: list.length > 1, reused: reuse };
}

/**
 * Extrusion length that goes through the whole target body from the sketch
 * plane in direction `sign` (with a millimetre to spare).
 */
function throughDistance(bodies: Bodies, target: BodyId | undefined, frame: Frame, sign: number): number {
  const body = bodies.target(target);
  if (!body) throw new Error("No body to cut through");
  const [lo, hi] = body.shape.shape.boundingBox.bounds;
  let reach = -Infinity;
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) {
    const d = (x - frame.origin[0]) * frame.n[0] + (y - frame.origin[1]) * frame.n[1] + (z - frame.origin[2]) * frame.n[2];
    reach = Math.max(reach, d * sign);
  }
  if (reach <= 0) throw new Error("The body is entirely behind the sketch: flip the direction");
  return sign * (reach + 1);
}

async function applyFeature(f: Feature, bodies: Bodies, sketches: Map<string, SketchContext>, previews: SketchPreview[]): Promise<string | undefined> {
  const sketchOf = (id: string) => {
    const s = sketches.get(id);
    if (!s) throw new Error("Referenced sketch is missing, suppressed or failed");
    return s;
  };

  switch (f.type) {
    case "sketch": {
      if (f.face) {
        const owner = bodies.withFace(f.face);
        const { face, frame } = planarFaceFrame(owner.shape, f.face, f.offset);
        sketches.set(f.id, { feature: f, frame });
        previews.push({ id: f.id, segments: sketchSegments(f, frame), reference: faceReference(face, frame), frame, regions: regionPreviews(f) });
      } else {
        const frame = standardFrame(f.plane, f.offset);
        sketches.set(f.id, { feature: f, frame });
        previews.push({ id: f.id, segments: sketchSegments(f, frame), frame, regions: regionPreviews(f) });
      }
      return;
    }

    case "extrude": {
      const { feature: s, frame } = sketchOf(f.sketchId);
      if (f.distance === 0) throw new Error("Distance cannot be 0");
      let distance = f.distance;
      if (f.throughAll && (f.op === "cut" || f.op === "intersect")) distance = throughDistance(bodies, f.target, frame, Math.sign(f.distance));
      const shape = sketchDrawing(s, f.regions).sketchOnPlane(replicadPlane(frame)).extrude(distance) as Shape3D;
      bodies.add(f.id, { shape, names: nameExtrusion(shape, f.id, s, frame, distance) }, f.op, f.target);
      return;
    }

    case "sweep": {
      const { feature: s, frame } = sketchOf(f.sketchId);
      const { feature: ps, frame: pathFrame } = sketchOf(f.pathId);
      if (f.pathId === f.sketchId) throw new Error("The path must be in a different sketch from the profile");
      const sketch = sketchDrawing(s, f.regions).sketchOnPlane(replicadPlane(frame));
      const spine = (pathDrawing(sketchPath(ps.sketch)).sketchOnPlane(replicadPlane(pathFrame)) as unknown as { wire: Wire }).wire;
      const tool = sweepAlong((sketch as unknown as { faces(): unknown }).faces(), spine, f.id);
      bodies.add(f.id, tool, f.op, f.target);
      return;
    }

    case "loft": {
      const wires = f.sections.map((id) => {
        const { feature: s, frame } = sketchOf(id);
        const { loops } = findLoops(s.sketch);
        if (!loops.length) throw new Error(`${s.name} has no closed profile`);
        // The largest closed profile of each sketch.
        const loop = loops.reduce((a, b) => (Math.abs(loopArea(b)) > Math.abs(loopArea(a)) ? b : a));
        return (loopDrawing(loop).sketchOnPlane(replicadPlane(frame)) as unknown as { wire: Wire }).wire;
      });
      bodies.add(f.id, loftThrough(wires, f.ruled, f.id), f.op, f.target);
      return;
    }

    case "boolean": {
      if (!f.target) throw new Error("Pick the target body");
      if (!f.tools.length) throw new Error("Pick the tool bodies");
      const target = bodies.map.get(f.target);
      if (!target) throw new Error("The target body no longer exists");
      const missing = f.tools.filter((t) => !bodies.map.has(t) || t === f.target);
      const tools = f.tools.filter((t) => t !== f.target && bodies.map.has(t)).map((t) => bodies.map.get(t)!);
      if (!tools.length) throw new Error("None of the tool bodies exist anymore");
      // A subtraction with clearance cuts with the tools grown by that gap.
      const gap = f.op === "cut" ? (f.clearance ?? 0) : 0;
      if (gap < 0) throw new Error("Clearance can't be negative");
      const shapes = tools.map((t) => (gap > 0 ? offsetSolid(t.shape, gap) : t.shape));
      const shape = f.op === "join" ? fuseShapes(target.shape, shapes) : f.op === "cut" ? cutShapes(target.shape, shapes) : commonShapes(target.shape, shapes);
      if (!shape.faces.length) throw new Error(f.op === "intersect" ? "The bodies don't overlap" : "Nothing is left of the target");
      const names = transferNames(shape, [target, ...tools], () => `${f.id}:new`);
      bodies.set(f.target, { shape, names });
      if (!f.keepTools) for (const t of f.tools) if (t !== f.target) bodies.remove(t);
      return missing.length ? `${missing.length} of ${f.tools.length} tool bodies no longer exist` : undefined;
    }

    case "draft": {
      if (!f.faces.length) throw new Error("Select the faces to draft");
      if (!f.neutral) throw new Error("Pick the neutral face");
      const owner = bodies.withFace(f.neutral);
      const { point, normal } = planarFaceFrame(owner.shape, f.neutral, 0);
      const faces = f.faces.map((name) => ({ face: faceByName(owner.shape, name), name }));
      bodies.set(owner.id, draftFaces(owner.shape, faces, point, normal, f.angle, f.id));
      return;
    }

    case "revolve": {
      const { feature: s, frame } = sketchOf(f.sketchId);
      let axis: Vec3 = AXES[f.axis], origin: Vec3 = [0, 0, 0];
      if (f.axisLine) {
        const m = entityMap(s.sketch);
        const line = m.get(f.axisLine);
        if (!line || line.kind !== "line") throw new Error(`The axis line of ${f.name} is no longer in ${s.name}`);
        const a = pointOf(m, line.p1), b = pointOf(m, line.p2);
        origin = frameToWorld(frame, a.x, a.y);
        const end = frameToWorld(frame, b.x, b.y);
        axis = [end[0] - origin[0], end[1] - origin[1], end[2] - origin[2]];
        if (Math.hypot(...axis) < 1e-9) throw new Error("The axis line has no length");
      }
      const shape = sketchDrawing(s, f.regions).sketchOnPlane(replicadPlane(frame)).revolve(axis, { origin, angle: f.angle }) as Shape3D;
      bodies.add(f.id, { shape, names: nameRevolution(shape, f.id) }, f.op, f.target);
      return;
    }

    case "fillet":
    case "chamfer": {
      if (f.size <= 0) throw new Error("Size must be > 0");
      // The body that owns the selected edges, or the current body for "all edges".
      const owner = f.edges.length ? f.edges.map((n) => bodies.withEdge(n)).find(Boolean) ?? null : bodies.target();
      if (!owner) throw new Error(f.edges.length ? `None of the ${f.edges.length} selected edges exist anymore` : "No body to apply it to");
      const body = owner.shape;
      const edges = nameEdges(body.shape, body.names);
      let selected: Set<number> | null = null;
      let selectedNames: Set<string> | undefined;
      let warning: string | undefined;
      if (f.edges.length) {
        const found = f.edges.filter((n) => edges.byName.has(n));
        if (found.length < f.edges.length) warning = `${f.edges.length - found.length} of ${f.edges.length} selected edges no longer exist`;
        selectedNames = new Set(found);
        selected = new Set(found.map((n) => edges.byName.get(n)!.hashCode));
      }
      // Per-edge overrides; keys may carry a "#k" added when naming the blend face.
      const override = new Map<number, number>();
      for (const [key, value] of Object.entries(f.overrides ?? {})) {
        const e = edges.byName.get(key) ?? edges.byName.get(key.replace(/#\d+$/, ""));
        if (e && value > 0) override.set(e.hashCode, value);
      }
      // Edges to treat with their sizes (every edge when none is selected).
      const items = [...edges.byName]
        .filter(([, e]) => !selected || selected.has(e.hashCode))
        .map(([name, e]) => ({ name, edge: e, size: override.get(e.hashCode) ?? f.size }));
      const { shape: raw, generated } = treatEdges(f.type, body.shape, items);
      // With per-edge sizes, name the largest one (the general size may be fine).
      const largest = Math.max(...items.map((it) => it.size));
      let shape = ensureValid(raw, `${f.type === "fillet" ? "Radius" : "Distance"} ${largest} is too large for the selected edges`);
      // Blend faces are named after the edge that generated them (OCCT history);
      // corner patches, generated by vertices, fall back to the nearest edge.
      const blendName = new Map<number, string>();
      for (const it of items) for (const h of generated.get(it.edge.hashCode) ?? []) blendName.set(h, `${f.id}:blend:${it.name}`);
      const among = selectedNames ?? new Set(items.map((it) => it.name));
      const cornerName = (sample: { p: Vec3 }) => `${f.id}:blend:${nearestEdgeName(sample.p, edges, among)}`;
      let names = transferNames(shape, [body], (face, sample) => blendName.get(face.hashCode) ?? cornerName(sample));
      // Where fillets of different radii meet, OCCT's corner patch can be hook-shaped:
      // replace it with a setback vertex blend (its faces keep their names by geometry).
      const corners = f.type === "fillet" ? mixedRadiusCorners(items) : [];
      if (corners.length) {
        const original = new Set(body.shape.faces.map((x) => x.hashCode));
        const isCornerFace = (x: Face) => x.geomType !== "PLANE" && !blendName.has(x.hashCode) && !original.has(x.hashCode);
        const result = blendCorners(shape, corners, isCornerFace);
        if (result.blended) {
          names = transferNames(result.shape, [{ shape, names }], (_face, sample) => cornerName(sample));
          shape = result.shape;
        }
      }
      bodies.set(owner.id, { shape, names });
      return warning;
    }

    case "cove": {
      if (f.size <= 0) throw new Error("Radius must be > 0");
      if (!f.edges.length) throw new Error("Select at least one edge");
      const owner = f.edges.map((n) => bodies.withEdge(n)).find(Boolean) ?? null;
      if (!owner) throw new Error(`None of the ${f.edges.length} selected edges exist anymore`);
      const body = owner.shape;
      const edges = nameEdges(body.shape, body.names);
      const found = f.edges.filter((n) => edges.byName.has(n));
      const warning = found.length < f.edges.length ? `${f.edges.length - found.length} of ${f.edges.length} selected edges no longer exist` : undefined;
      // One cylinder (or torus segment) per edge, all subtracted in a single Boolean run.
      const tools = found.map((n) => coveTool(edges.byName.get(n)!, f.size));
      const shape = ensureValid(cutShapes(body.shape, tools), `Radius ${f.size} is too large for the selected edges`);
      // New concave faces are named after the edge they replace.
      const among = new Set(found);
      const names = transferNames(shape, [body], (_face, sample) => `${f.id}:cove:${nearestEdgeName(sample.p, edges, among)}`);
      bodies.set(owner.id, { shape, names });
      return warning;
    }

    case "pushpull": {
      if (f.distance === 0) throw new Error("Distance cannot be 0");
      const owner = bodies.withFace(f.face);
      const body = owner.shape;
      const { face, point, normal } = planarFaceFrame(body, f.face, 0);
      // Preferred: move the face, stretching the walls (fillets and holes ride along).
      try {
        const st = stretchFace(body, face, normal, f.distance, f.id);
        if (st) {
          ensureValid(st.shape, "stretch");
          bodies.set(owner.id, st);
          return;
        }
      } catch {
        /* not a clean stretch: extrude the face instead */
      }
      const edges = nameEdges(body.shape, body.names);
      const faceEdges = new Set(face.edges.map((e) => edges.byHash.get(e.hashCode)!).filter(Boolean));
      const tool = basicFaceExtrusion(face, new Vector([normal[0] * f.distance, normal[1] * f.distance, normal[2] * f.distance])) as Shape3D;
      const named = { shape: tool, names: nameFaceExtrusion(tool, f.id, normal, point, f.distance, edges, faceEdges) };
      // Pulling out, the extruded face only touches the body at that face.
      bodies.set(owner.id, booleanOp(body, named, f.distance > 0 ? "join" : "cut", f.id, f.distance > 0));
      return;
    }

    case "shell": {
      if (f.thickness <= 0) throw new Error("Thickness must be > 0");
      if (!f.faces.length) throw new Error("Select at least one face to open");
      const owner = bodies.withFace(f.faces[0]);
      const body = owner.shape;
      const hashes = new Set<number>();
      for (const n of f.faces) hashes.add(faceByName(body, n).hashCode);
      // In replicad a positive thickness hollows inward, keeping the outer dimensions.
      const shape = ensureValid(body.shape.shell(f.thickness, (finder) => finder.when(({ element }) => hashes.has(element.hashCode))), `Thickness ${f.thickness} is too large for this body`);
      bodies.set(owner.id, { shape, names: transferNames(shape, [body], () => `${f.id}:inner`) });
      return;
    }

    case "mirror": {
      const t = bodies.target(f.target);
      if (!t) throw new Error("No body to mirror");
      const fr = standardFrame(f.plane, f.offset);
      const copy = t.shape.shape.clone().mirror(f.plane, fr.origin);
      bodies.set(t.id, joinCopies(t.shape, [copy], f.id));
      return;
    }

    case "pattern": {
      const t = bodies.target(f.target);
      if (!t) throw new Error("No body to pattern");
      const n = Math.round(f.count);
      if (n < 2) throw new Error("Count must be at least 2");
      if (n > 200) throw new Error("Count is limited to 200");
      const axis = AXES[f.axis];
      const copies: Shape3D[] = [];
      for (let k = 1; k < n; k++) {
        if (f.mode === "linear") {
          copies.push(t.shape.shape.clone().translate([axis[0] * f.spacing * k, axis[1] * f.spacing * k, axis[2] * f.spacing * k]));
        } else {
          const step = Math.abs(f.angle) >= 360 ? 360 / n : f.angle / (n - 1);
          copies.push(t.shape.shape.clone().rotate(step * k, [0, 0, 0], axis));
        }
      }
      bodies.set(t.id, joinCopies(t.shape, copies, f.id));
      return;
    }

    case "transform": {
      const t = bodies.target(f.body);
      if (!t) throw new Error("Body no longer exists");
      let shape = t.shape.shape.clone();
      if (f.angle) shape = shape.rotate(f.angle, [f.pivotX, f.pivotY, f.pivotZ], AXES[f.axis]);
      if (f.dx || f.dy || f.dz) shape = shape.translate([f.dx, f.dy, f.dz]);
      bodies.set(t.id, { shape, names: keepNames(t.shape, shape) });
      return;
    }

    case "layflat": {
      const owner = bodies.withFace(f.face);
      const { point, normal } = planarFaceFrame(owner.shape, f.face, 0);
      let shape = owner.shape.shape.clone();
      // Turn the face's outward normal to point straight down, about the face itself.
      const d = Math.max(-1, Math.min(1, -normal[2]));
      if (d < 1 - 1e-12) {
        let axis: Vec3 = [-normal[1], normal[0], 0]; // normal × (0, 0, -1)
        if (Math.hypot(...axis) < 1e-9) axis = [1, 0, 0]; // facing up: half a turn
        shape = shape.rotate((Math.acos(d) * 180) / Math.PI, point, axis);
      }
      // Rest on the bed.
      const lo = shape.boundingBox.bounds[0][2];
      if (Math.abs(lo) > 1e-9) shape = shape.translate([0, 0, -lo]);
      const names = keepNames(owner.shape, shape);
      bodies.set(owner.id, { shape, names });
      // The face may not be the lowest part (e.g. at the bottom of a recess).
      const moved = shape.faces.find((x) => names.get(x.hashCode) === f.face);
      const faceZ = moved ? moved.boundingBox.bounds[0][2] : 0;
      return faceZ > 1e-3 ? `The body rests on other faces: this one stays ${faceZ.toFixed(2)} mm above the bed` : undefined;
    }

    case "import": {
      const bytes = base64ToBytes(f.data);
      const shape = f.format === "step" ? asSolid(await importSTEP(new Blob([bytes]))) : stlToSolid(bytes);
      bodies.add(f.id, { shape, names: nameByOrder(shape, `${f.id}:face`) }, f.op, f.target);
      return;
    }
  }
}

/** `fast` meshes coarser and skips edge naming: used for live previews while dragging. */
export function meshBody(body: NamedShape, faceBody: Map<number, BodyId> = new Map(), fast = false): MeshData {
  const quality = fast ? { tolerance: 0.15, angularTolerance: 25 } : { tolerance: 0.05, angularTolerance: 15 };
  const m = body.shape.mesh(quality);
  const e = body.shape.meshEdges(quality);
  const edgeNaming = fast ? { byHash: new Map<number, string>() } : nameEdges(body.shape, body.names);
  const types = new Map(body.shape.faces.map((f) => [f.hashCode, f.geomType]));
  const edgeBody = new Map<number, BodyId>();
  for (const f of body.shape.faces) {
    const b = faceBody.get(f.hashCode);
    if (b) for (const e of f.edges) edgeBody.set(e.hashCode, b);
  }
  return {
    vertices: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    triangles: new Uint32Array(m.triangles),
    faceGroups: m.faceGroups,
    faceNames: m.faceGroups.map((g) => body.names.get(g.faceId) ?? "?"),
    facePlanar: m.faceGroups.map((g) => types.get(g.faceId) === "PLANE"),
    faceBody: m.faceGroups.map((g) => faceBody.get(g.faceId) ?? ""),
    edges: new Float32Array(e.lines),
    edgeGroups: e.edgeGroups,
    edgeNames: e.edgeGroups.map((g) => edgeNaming.byHash.get(g.edgeId) ?? "?"),
    edgeBody: e.edgeGroups.map((g) => edgeBody.get(g.edgeId) ?? ""),
  };
}
