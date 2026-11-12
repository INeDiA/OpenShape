// Draft: tilts faces by an angle about their intersection with a neutral plane
// (the faces keep their line on that plane), as moulded parts need.

import { cast, getOC, type Face, type Shape3D } from "replicad";
import type { Vec3 } from "../model/frame";
import { transferNames, type FaceNames, type NamedShape } from "./naming";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const wrapped = (s: unknown) => (s as { wrapped: unknown }).wrapped;

/**
 * Drafts `faces` of `body` by `angle` degrees. The neutral plane goes through
 * `point` with normal `normal` (a face of the body, pointing out of it); the
 * pull direction is away from it, so a positive angle narrows the part away from
 * the neutral plane.
 */
export function draftFaces(body: NamedShape, faces: { face: Face; name: string }[], point: Vec3, normal: Vec3, angle: number, featureId: string): NamedShape {
  const oc = getOC() as Any;
  const dir = new oc.gp_Dir(-normal[0], -normal[1], -normal[2]);
  const p = new oc.gp_Pnt(point[0], point[1], point[2]);
  const n = new oc.gp_Dir(normal[0], normal[1], normal[2]);
  const pln = new oc.gp_Pln(p, n);
  const draft = new oc.BRepOffsetAPI_DraftAngle(wrapped(body.shape));
  try {
    const rad = (angle * Math.PI) / 180;
    for (const { face, name } of faces) {
      draft.Add(wrapped(face), dir, rad, pln, true);
      if (!draft.AddDone()) throw new Error(`Face ${short(name)} can't be drafted from this neutral plane`);
    }
    draft.Build();
    if (!draft.IsDone()) throw new Error(`Angle ${angle}° can't be applied to these faces`);
    const shape = cast(draft.Shape()) as unknown as Shape3D;
    // Every face, drafted or not, keeps its name through the operation's history.
    const names: FaceNames = new Map();
    for (const f of body.shape.faces) {
      const name = body.names.get(f.hashCode);
      if (!name) continue;
      try {
        const m = cast(draft.ModifiedShape(wrapped(f))) as unknown as { hashCode: number };
        names.set(m.hashCode, name);
      } catch {
        // removed face
      }
    }
    const leftover = shape.faces.filter((f) => !names.has(f.hashCode));
    if (leftover.length) {
      const extra = transferNames(shape, [body], () => `${featureId}:new`);
      for (const f of leftover) names.set(f.hashCode, extra.get(f.hashCode) ?? `${featureId}:new`);
    }
    return { shape, names };
  } finally {
    draft.delete();
    pln.delete();
    n.delete();
    p.delete();
    dir.delete();
  }
}

const short = (n: string) => (n.length > 30 ? `…${n.slice(-28)}` : n);
