// Replays the feature list on top of replicad/OpenCascade.
// Runs inside the kernel worker; keep it free of DOM and React.

import { draw, drawCircle, type Drawing, type Shape3D } from "replicad";
import type {
  BooleanOp,
  Document,
  FeatureStatus,
  MeshData,
  PlaneName,
  SketchFeature,
  SketchPreview,
} from "../model/types";
import { entityMap, pointOf } from "../sketch/model";
import { findLoops, nestLoops, type Loop } from "../sketch/profiles";

export interface EvaluationResult {
  body: Shape3D | null;
  sketches: SketchPreview[];
  status: FeatureStatus[];
}

function loopDrawing(l: Loop): Drawing {
  if (l.kind === "circle") return drawCircle(l.r).translate(l.cx, l.cy);
  const [first, ...rest] = l.points;
  let pen = draw(first);
  for (const p of rest) pen = pen.lineTo(p);
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

/** Maps a 2D sketch point to world space, matching replicad's named planes. */
function toWorld(plane: PlaneName, offset: number, x: number, y: number): [number, number, number] {
  switch (plane) {
    case "XY":
      return [x, y, offset];
    case "XZ":
      // replicad XZ plane: x -> X, y -> Z, normal -Y
      return [x, -offset, y];
    case "YZ":
      return [offset, x, y];
  }
}

function sketchSegments(f: SketchFeature): Float32Array {
  const m = entityMap(f.sketch);
  const out: number[] = [];
  const seg = (x1: number, y1: number, x2: number, y2: number) =>
    out.push(...toWorld(f.plane, f.offset, x1, y1), ...toWorld(f.plane, f.offset, x2, y2));
  for (const e of f.sketch.entities) {
    if (e.kind === "line") {
      const a = pointOf(m, e.p1), b = pointOf(m, e.p2);
      seg(a.x, a.y, b.x, b.y);
    } else if (e.kind === "circle") {
      const c = pointOf(m, e.center);
      const n = 64;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        seg(c.x + e.radius * Math.cos(a0), c.y + e.radius * Math.sin(a0), c.x + e.radius * Math.cos(a1), c.y + e.radius * Math.sin(a1));
      }
    }
  }
  return new Float32Array(out);
}

function combine(body: Shape3D | null, tool: Shape3D, op: BooleanOp): Shape3D {
  if (op === "new" || !body) return tool;
  switch (op) {
    case "join":
      return body.fuse(tool);
    case "cut":
      return body.cut(tool);
    case "intersect":
      return body.intersect(tool);
  }
}

export function evaluate(doc: Document): EvaluationResult {
  const sketches = new Map<string, SketchFeature>();
  const previews: SketchPreview[] = [];
  const status: FeatureStatus[] = [];
  let body: Shape3D | null = null;

  for (const f of doc.features) {
    if (f.suppressed) {
      status.push({ id: f.id, ok: true });
      continue;
    }
    try {
      switch (f.type) {
        case "sketch": {
          sketches.set(f.id, f);
          previews.push({ id: f.id, segments: sketchSegments(f) });
          break;
        }
        case "extrude": {
          const s = sketches.get(f.sketchId);
          if (!s) throw new Error("Referenced sketch is missing or suppressed");
          if (f.distance === 0) throw new Error("Distance cannot be 0");
          const solid = sketchDrawing(s)
            .sketchOnPlane(s.plane, s.offset)
            .extrude(f.distance) as Shape3D;
          body = combine(body, solid, f.op);
          break;
        }
        case "revolve": {
          const s = sketches.get(f.sketchId);
          if (!s) throw new Error("Referenced sketch is missing or suppressed");
          const axis: [number, number, number] =
            f.axis === "X" ? [1, 0, 0] : f.axis === "Y" ? [0, 1, 0] : [0, 0, 1];
          const solid = sketchDrawing(s)
            .sketchOnPlane(s.plane, s.offset)
            .revolve(axis, { angle: f.angle }) as Shape3D;
          body = combine(body, solid, f.op);
          break;
        }
        case "fillet":
        case "chamfer": {
          if (!body) throw new Error("No body to apply it to");
          if (f.size <= 0) throw new Error("Size must be > 0");
          body = f.type === "fillet" ? body.fillet(f.size) : body.chamfer(f.size);
          break;
        }
      }
      status.push({ id: f.id, ok: true });
    } catch (e) {
      status.push({ id: f.id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { body, sketches: previews, status };
}

export function meshBody(body: Shape3D): MeshData {
  const m = body.mesh({ tolerance: 0.05, angularTolerance: 15 });
  const e = body.meshEdges({ tolerance: 0.05, angularTolerance: 15 });
  return {
    vertices: new Float32Array(m.vertices),
    normals: new Float32Array(m.normals),
    triangles: new Uint32Array(m.triangles),
    faceGroups: m.faceGroups,
    edges: new Float32Array(e.lines),
  };
}
