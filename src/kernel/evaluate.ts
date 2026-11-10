// Replays the feature list on top of replicad/OpenCascade.
// Runs inside the kernel worker (and in Node tests); keep it free of DOM and React.

import {
  basicFaceExtrusion,
  draw,
  drawCircle,
  getOC,
  importSTEP,
  makeCompound,
  makePolygon,
  makeSolid,
  Plane,
  Vector,
  type AnyShape,
  type Drawing,
  type Edge,
  type Face,
  type Shape3D,
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
import type { BodyId, BooleanOp, Document, Feature, FeatureStatus, MeshData, SketchFeature, SketchPreview } from "../model/types";
import { frameToLocal, frameToWorld, planeFrame, standardFrame, type Frame, type Vec3 } from "../model/frame";
import { entityMap, pointOf } from "../sketch/model";
import { arcMidpoint, findLoops, loopPolygon, nestLoops, type Loop } from "../sketch/profiles";
import { parseSTL } from "../io/stl";

export interface EvaluationResult {
  /** All bodies combined (a compound when there are several): for display and export. */
  body: NamedShape | null;
  /** Individual bodies in creation order. */
  bodies: { id: BodyId; shape: NamedShape }[];
  /** Face hash (in `body`) -> owning body id. */
  faceBody: Map<number, BodyId>;
  sketches: SketchPreview[];
  status: FeatureStatus[];
}

// ---- sketches -------------------------------------------------------------------

function loopDrawing(l: Loop): Drawing {
  if (l.kind === "circle") return drawCircle(l.r).translate(l.cx, l.cy);
  let pen = draw(l.start);
  for (const s of l.segments) pen = s.kind === "line" ? pen.lineTo(s.to) : pen.threePointsArcTo(s.to, s.mid);
  return pen.close();
}

/** Builds the sketch region: outer loops add material, nested loops become holes. */
function sketchDrawing(f: SketchFeature): Drawing {
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

function booleanOp(body: NamedShape, tool: NamedShape, op: Exclude<BooleanOp, "new">, featureId: string): NamedShape {
  const shape = op === "join" ? body.shape.fuse(tool.shape) : op === "cut" ? body.shape.cut(tool.shape) : body.shape.intersect(tool.shape);
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
    const shape = result.shape.fuse(copy);
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
  readonly map = new Map<BodyId, NamedShape>();
  last: BodyId | null = null;

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

  /** Combines a new solid with the bodies according to `op`. */
  add(featureId: string, tool: NamedShape, op: BooleanOp, target?: BodyId) {
    const t = op === "new" ? null : this.target(target);
    if (!t) return this.set(featureId, tool);
    this.set(t.id, booleanOp(t.shape, tool, op as Exclude<BooleanOp, "new">, featureId));
  }
}

export async function evaluate(doc: Document, opts: EvaluateOptions = {}): Promise<EvaluationResult> {
  const sketches = new Map<string, SketchContext>();
  const previews: SketchPreview[] = [];
  const status: FeatureStatus[] = [];
  const bodies = new Bodies();

  for (const f of doc.features) {
    if (f.id === opts.stopBefore) break;
    if (f.suppressed) {
      status.push({ id: f.id, ok: true });
      continue;
    }
    try {
      const warning = await applyFeature(f, bodies, sketches, previews);
      status.push(warning ? { id: f.id, ok: false, error: warning } : { id: f.id, ok: true });
    } catch (e) {
      status.push({ id: f.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

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
  return { body, bodies: list, faceBody, sketches: previews, status };
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
        previews.push({ id: f.id, segments: sketchSegments(f, frame), reference: faceReference(face, frame) });
      } else {
        const frame = standardFrame(f.plane, f.offset);
        sketches.set(f.id, { feature: f, frame });
        previews.push({ id: f.id, segments: sketchSegments(f, frame) });
      }
      return;
    }

    case "extrude": {
      const { feature: s, frame } = sketchOf(f.sketchId);
      if (f.distance === 0) throw new Error("Distance cannot be 0");
      const shape = sketchDrawing(s).sketchOnPlane(replicadPlane(frame)).extrude(f.distance) as Shape3D;
      bodies.add(f.id, { shape, names: nameExtrusion(shape, f.id, s, frame, f.distance) }, f.op, f.target);
      return;
    }

    case "revolve": {
      const { feature: s, frame } = sketchOf(f.sketchId);
      const shape = sketchDrawing(s).sketchOnPlane(replicadPlane(frame)).revolve(AXES[f.axis], { angle: f.angle }) as Shape3D;
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
      const radius = selected ? (e: Edge) => (selected!.has(e.hashCode) ? f.size : null) : f.size;
      const shape = ensureValid(f.type === "fillet" ? body.shape.fillet(radius) : body.shape.chamfer(radius), `${f.type === "fillet" ? "Radius" : "Distance"} ${f.size} is too large for the selected edges`);
      const names = transferNames(shape, [body], (_face, sample) => `${f.id}:blend:${nearestEdgeName(sample.p, edges, selectedNames)}`);
      bodies.set(owner.id, { shape, names });
      return warning;
    }

    case "pushpull": {
      if (f.distance === 0) throw new Error("Distance cannot be 0");
      const owner = bodies.withFace(f.face);
      const body = owner.shape;
      const { face, point, normal } = planarFaceFrame(body, f.face, 0);
      const edges = nameEdges(body.shape, body.names);
      const faceEdges = new Set(face.edges.map((e) => edges.byHash.get(e.hashCode)!).filter(Boolean));
      const tool = basicFaceExtrusion(face, new Vector([normal[0] * f.distance, normal[1] * f.distance, normal[2] * f.distance])) as Shape3D;
      const named = { shape: tool, names: nameFaceExtrusion(tool, f.id, normal, point, f.distance, edges, faceEdges) };
      bodies.set(owner.id, booleanOp(body, named, f.distance > 0 ? "join" : "cut", f.id));
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

    case "import": {
      const bytes = base64ToBytes(f.data);
      const shape = f.format === "step" ? asSolid(await importSTEP(new Blob([bytes]))) : stlToSolid(bytes);
      bodies.add(f.id, { shape, names: nameByOrder(shape, `${f.id}:face`) }, f.op, f.target);
      return;
    }
  }
}

export function meshBody(body: NamedShape, faceBody: Map<number, BodyId> = new Map()): MeshData {
  const m = body.shape.mesh({ tolerance: 0.05, angularTolerance: 15 });
  const e = body.shape.meshEdges({ tolerance: 0.05, angularTolerance: 15 });
  const edgeNaming = nameEdges(body.shape, body.names);
  const types = new Map(body.shape.faces.map((f) => [f.hashCode, f.geomType]));
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
  };
}
