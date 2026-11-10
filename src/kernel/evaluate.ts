// Replays the feature list on top of replicad/OpenCascade.
// Runs inside the kernel worker (and in Node tests); keep it free of DOM and React.

import {
  basicFaceExtrusion,
  draw,
  drawCircle,
  importSTEP,
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
import type { BooleanOp, Document, Feature, FeatureStatus, MeshData, SketchFeature, SketchPreview } from "../model/types";
import { frameToLocal, frameToWorld, planeFrame, standardFrame, type Frame, type Vec3 } from "../model/frame";
import { entityMap, pointOf } from "../sketch/model";
import { arcMidpoint, findLoops, loopPolygon, nestLoops, type Loop } from "../sketch/profiles";
import { parseSTL } from "../io/stl";

export interface EvaluationResult {
  body: NamedShape | null;
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

function combine(body: NamedShape | null, tool: NamedShape, op: BooleanOp, featureId: string): NamedShape {
  if (op === "new" || !body) return tool;
  const shape = op === "join" ? body.shape.fuse(tool.shape) : op === "cut" ? body.shape.cut(tool.shape) : body.shape.intersect(tool.shape);
  return { shape, names: transferNames(shape, [body, tool], () => `${featureId}:new`) };
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

export async function evaluate(doc: Document, opts: EvaluateOptions = {}): Promise<EvaluationResult> {
  const sketches = new Map<string, SketchContext>();
  const previews: SketchPreview[] = [];
  const status: FeatureStatus[] = [];
  let body: NamedShape | null = null;

  for (const f of doc.features) {
    if (f.id === opts.stopBefore) break;
    if (f.suppressed) {
      status.push({ id: f.id, ok: true });
      continue;
    }
    try {
      const r = await applyFeature(f, body, sketches, previews);
      body = r.body;
      status.push(r.warning ? { id: f.id, ok: false, error: r.warning } : { id: f.id, ok: true });
    } catch (e) {
      status.push({ id: f.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { body, sketches: previews, status };
}

async function applyFeature(
  f: Feature,
  body: NamedShape | null,
  sketches: Map<string, SketchContext>,
  previews: SketchPreview[],
): Promise<{ body: NamedShape | null; warning?: string }> {
  const sketchOf = (id: string) => {
    const s = sketches.get(id);
    if (!s) throw new Error("Referenced sketch is missing, suppressed or failed");
    return s;
  };

  switch (f.type) {
    case "sketch": {
      if (f.face) {
        const { face, frame } = planarFaceFrame(body, f.face, f.offset);
        sketches.set(f.id, { feature: f, frame });
        previews.push({ id: f.id, segments: sketchSegments(f, frame), reference: faceReference(face, frame) });
      } else {
        const frame = standardFrame(f.plane, f.offset);
        sketches.set(f.id, { feature: f, frame });
        previews.push({ id: f.id, segments: sketchSegments(f, frame) });
      }
      return { body };
    }

    case "extrude": {
      const { feature: s, frame } = sketchOf(f.sketchId);
      if (f.distance === 0) throw new Error("Distance cannot be 0");
      const shape = sketchDrawing(s).sketchOnPlane(replicadPlane(frame)).extrude(f.distance) as Shape3D;
      return { body: combine(body, { shape, names: nameExtrusion(shape, f.id, s, frame, f.distance) }, f.op, f.id) };
    }

    case "revolve": {
      const { feature: s, frame } = sketchOf(f.sketchId);
      const shape = sketchDrawing(s).sketchOnPlane(replicadPlane(frame)).revolve(AXES[f.axis], { angle: f.angle }) as Shape3D;
      return { body: combine(body, { shape, names: nameRevolution(shape, f.id) }, f.op, f.id) };
    }

    case "fillet":
    case "chamfer": {
      if (!body) throw new Error("No body to apply it to");
      if (f.size <= 0) throw new Error("Size must be > 0");
      const edges = nameEdges(body.shape, body.names);
      let selected: Set<number> | null = null;
      let selectedNames: Set<string> | undefined;
      let warning: string | undefined;
      if (f.edges.length) {
        const found = f.edges.filter((n) => edges.byName.has(n));
        if (!found.length) throw new Error(`None of the ${f.edges.length} selected edges exist anymore`);
        if (found.length < f.edges.length) warning = `${f.edges.length - found.length} of ${f.edges.length} selected edges no longer exist`;
        selectedNames = new Set(found);
        selected = new Set(found.map((n) => edges.byName.get(n)!.hashCode));
      }
      const radius = selected ? (e: Edge) => (selected!.has(e.hashCode) ? f.size : null) : f.size;
      const shape = f.type === "fillet" ? body.shape.fillet(radius) : body.shape.chamfer(radius);
      const names = transferNames(shape, [body], (_face, sample) => `${f.id}:blend:${nearestEdgeName(sample.p, edges, selectedNames)}`);
      return { body: { shape, names }, warning };
    }

    case "pushpull": {
      if (!body) throw new Error("No body to push or pull");
      if (f.distance === 0) throw new Error("Distance cannot be 0");
      const { face, point, normal } = planarFaceFrame(body, f.face, 0);
      const edges = nameEdges(body.shape, body.names);
      const faceEdges = new Set(face.edges.map((e) => edges.byHash.get(e.hashCode)!).filter(Boolean));
      const tool = basicFaceExtrusion(face, new Vector([normal[0] * f.distance, normal[1] * f.distance, normal[2] * f.distance])) as Shape3D;
      const named = { shape: tool, names: nameFaceExtrusion(tool, f.id, normal, point, f.distance, edges, faceEdges) };
      return { body: combine(body, named, f.distance > 0 ? "join" : "cut", f.id) };
    }

    case "shell": {
      if (!body) throw new Error("No body to shell");
      if (f.thickness <= 0) throw new Error("Thickness must be > 0");
      if (!f.faces.length) throw new Error("Select at least one face to open");
      const hashes = new Set<number>();
      for (const n of f.faces) hashes.add(faceByName(body, n).hashCode);
      // In replicad a positive thickness hollows inward, keeping the outer dimensions.
      const shape = body.shape.shell(f.thickness, (finder) => finder.when(({ element }) => hashes.has(element.hashCode)));
      return { body: { shape, names: transferNames(shape, [body], () => `${f.id}:inner`) } };
    }

    case "mirror": {
      if (!body) throw new Error("No body to mirror");
      const fr = standardFrame(f.plane, f.offset);
      const copy = body.shape.clone().mirror(f.plane, fr.origin);
      return { body: joinCopies(body, [copy], f.id) };
    }

    case "pattern": {
      if (!body) throw new Error("No body to pattern");
      const n = Math.round(f.count);
      if (n < 2) throw new Error("Count must be at least 2");
      if (n > 200) throw new Error("Count is limited to 200");
      const axis = AXES[f.axis];
      const copies: Shape3D[] = [];
      for (let k = 1; k < n; k++) {
        if (f.mode === "linear") {
          copies.push(body.shape.clone().translate([axis[0] * f.spacing * k, axis[1] * f.spacing * k, axis[2] * f.spacing * k]));
        } else {
          const step = Math.abs(f.angle) >= 360 ? 360 / n : f.angle / (n - 1);
          copies.push(body.shape.clone().rotate(step * k, [0, 0, 0], axis));
        }
      }
      return { body: joinCopies(body, copies, f.id) };
    }

    case "import": {
      const bytes = base64ToBytes(f.data);
      const shape = f.format === "step" ? asSolid(await importSTEP(new Blob([bytes]))) : stlToSolid(bytes);
      const names: FaceNames = nameByOrder(shape, `${f.id}:face`);
      return { body: combine(body, { shape, names }, f.op, f.id) };
    }
  }
}

export function meshBody(body: NamedShape): MeshData {
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
    edges: new Float32Array(e.lines),
    edgeGroups: e.edgeGroups,
    edgeNames: e.edgeGroups.map((g) => edgeNaming.byHash.get(g.edgeId) ?? "?"),
  };
}
