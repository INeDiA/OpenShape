// Fillets and chamfers through OCCT directly, to read the operation history:
// which faces each edge generated. Blend faces are then named after the edge
// they really come from, whatever the radius (naming by proximity misnames
// large fillets, whose faces can sit closer to a neighbouring edge).

import { cast, getOC, type Edge, type Shape3D } from "replicad";

export interface TreatedEdge {
  edge: Edge;
  size: number;
}

export interface TreatmentResult {
  shape: Shape3D;
  /** edge hash -> hashes of the faces it generated */
  generated: Map<number, number[]>;
}

interface OcList {
  IsEmpty(): boolean;
  First(): unknown;
  RemoveFirst(): void;
  delete(): void;
}

export function treatEdges(kind: "fillet" | "chamfer", shape: Shape3D, items: TreatedEdge[]): TreatmentResult {
  if (!items.length) throw new Error(`Nothing to ${kind}: no edge selected`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const oc = getOC() as any;
  const wrapped = (s: unknown) => (s as { wrapped: unknown }).wrapped;
  const builder = kind === "fillet" ? new oc.BRepFilletAPI_MakeFillet(wrapped(shape), oc.ChFi3d_FilletShape.ChFi3d_Rational) : new oc.BRepFilletAPI_MakeChamfer(wrapped(shape));
  try {
    for (const { edge, size } of items) builder.Add(size, wrapped(edge));
    const out = cast(builder.Shape()) as unknown as Shape3D;
    const generated = new Map<number, number[]>();
    for (const { edge } of items) {
      const list: OcList = new oc.NCollection_List_TopoDS_Shape(builder.Generated(wrapped(edge)));
      const faces: number[] = [];
      while (!list.IsEmpty()) {
        const s = cast(list.First() as never) as unknown as { hashCode: number };
        faces.push(s.hashCode);
        list.RemoveFirst();
      }
      list.delete();
      generated.set(edge.hashCode, faces);
    }
    return { shape: out, generated };
  } finally {
    builder.delete();
  }
}
