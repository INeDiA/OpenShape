// Tools for the "cove" feature: a solid to subtract along an edge, leaving a
// concave quarter-round groove of the given radius centred on the edge.

import { drawCircle, makeCylinder, Plane, type Edge, type Shape3D } from "replicad";
import type { Vec3 } from "../model/frame";
import { circle3 } from "./measure";

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (v: Vec3): Vec3 => {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const tuple = (v: { toTuple(): number[] }) => v.toTuple() as Vec3;

/**
 * The solid removed by a cove of `radius` on `edge`: a cylinder along a
 * straight edge, a torus (or a segment of one) around a circular edge.
 */
export function coveTool(edge: Edge, radius: number): Shape3D {
  const start = tuple(edge.startPoint), end = tuple(edge.endPoint);
  if (edge.geomType === "LINE") {
    const axis = sub(end, start);
    return makeCylinder(radius, Math.hypot(...axis), start, unit(axis)) as Shape3D;
  }
  if (edge.geomType === "CIRCLE") {
    const circle = circle3(tuple(edge.pointAt(0)), tuple(edge.pointAt(0.37)), tuple(edge.pointAt(0.71)));
    if (!circle) throw new Error("Can't read the circular edge");
    const { center } = circle;
    const tangent = unit(tuple(edge.tangentAt(0)));
    const radial = unit(sub(start, center));
    // Axis oriented so the edge runs counter-clockwise around it.
    const n = unit(cross(radial, tangent));
    const closed = Math.hypot(...sub(end, start)) < 1e-7;
    let angle = 360;
    if (!closed) {
      const e = unit(sub(end, center));
      angle = (Math.atan2(dot(cross(radial, e), n), dot(radial, e)) * 180) / Math.PI;
      if (angle <= 0) angle += 360;
    }
    // A circle of `radius` across the edge at its start, swept around the edge's axis.
    const profile = drawCircle(radius).sketchOnPlane(new Plane(start, radial, tangent));
    return profile.revolve(n, { origin: center, angle }) as Shape3D;
  }
  throw new Error("Cove works on straight and circular edges");
}
