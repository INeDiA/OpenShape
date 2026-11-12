// Sweeps (a profile moved along a path) and lofts (a solid through several
// profiles) straight on OCCT, keeping the end caps to name them.

import { cast, getOC, type Shape3D, type Wire } from "replicad";
import type { FaceNames } from "./naming";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const wrapped = (s: unknown) => (s as { wrapped: unknown }).wrapped;

/** Names the faces of a sweep or loft: start and end caps, the rest in kernel order. */
function nameCaps(shape: Shape3D, first: unknown, last: unknown, featureId: string, kind: string): FaceNames {
  const hashes = (s: unknown) => {
    if (!s) return new Set<number>();
    try {
      const c = cast(s as never) as unknown as { faces?: { hashCode: number }[]; hashCode: number };
      return new Set(c.faces ? c.faces.map((f) => f.hashCode) : [c.hashCode]);
    } catch {
      return new Set<number>();
    }
  };
  const start = hashes(first), end = hashes(last);
  const names: FaceNames = new Map();
  let k = 0;
  for (const f of shape.faces) {
    if (start.has(f.hashCode)) names.set(f.hashCode, `${featureId}:start`);
    else if (end.has(f.hashCode)) names.set(f.hashCode, `${featureId}:end`);
    else names.set(f.hashCode, `${featureId}:${kind}:${k++}`);
  }
  return names;
}

/** Moves `profile` (a face or a compound of faces) along `spine`. */
export function sweepAlong(profile: unknown, spine: Wire, featureId: string): { shape: Shape3D; names: FaceNames } {
  const oc = getOC() as Any;
  const pipe = new oc.BRepOffsetAPI_MakePipe(wrapped(spine), wrapped(profile));
  try {
    pipe.Build();
    if (!pipe.IsDone()) throw new Error("The sweep failed: check that the profile can follow the path");
    const shape = cast(pipe.Shape()) as unknown as Shape3D;
    if (!shape.faces.length) throw new Error("The sweep produced no solid");
    return { shape, names: nameCaps(shape, pipe.FirstShape(), pipe.LastShape(), featureId, "sweep") };
  } finally {
    pipe.delete();
  }
}

/** A solid through closed `sections`, in order (`ruled`: straight between sections). */
export function loftThrough(sections: Wire[], ruled: boolean, featureId: string): { shape: Shape3D; names: FaceNames } {
  if (sections.length < 2) throw new Error("A loft needs at least two profiles");
  const oc = getOC() as Any;
  const loft = new oc.BRepOffsetAPI_ThruSections(true, ruled, 1e-6);
  try {
    for (const w of sections) loft.AddWire(wrapped(w));
    loft.Build();
    if (!loft.IsDone()) throw new Error("The loft failed: the profiles can't be joined");
    const shape = cast(loft.Shape()) as unknown as Shape3D;
    return { shape, names: nameCaps(shape, loft.FirstShape(), loft.LastShape(), featureId, "loft") };
  } finally {
    loft.delete();
  }
}
