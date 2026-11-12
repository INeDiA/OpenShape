// The path of a sweep: the sketch's non-construction curves joined end to end
// into one chain (lines, arcs, open splines), or a single closed curve.

import { curveEnds, entityMap, pointOf, type SkCurve, type SketchData } from "./model";
import { arcMidpoint, type Pt, type Segment } from "./profiles";
import { ellipseGeom, splineBeziers, splinePoints } from "./curves";

export type SketchPath = { kind: "path"; start: Pt; segments: Segment[]; closed: boolean } | { kind: "circle"; cx: number; cy: number; r: number } | { kind: "ellipse"; cx: number; cy: number; a: number; b: number; angle: number };

export function sketchPath(s: SketchData): SketchPath {
  const m = entityMap(s);
  const curves = s.entities.filter((e): e is SkCurve => e.kind !== "point" && !e.construction);
  if (!curves.length) throw new Error("The path sketch has no curves");
  const closedCurves = curves.filter((c) => c.kind === "circle" || c.kind === "ellipse" || (c.kind === "spline" && c.closed));
  if (closedCurves.length) {
    if (curves.length > 1) throw new Error("A closed path must be the only curve of its sketch");
    const c = closedCurves[0];
    if (c.kind === "circle") {
      const ctr = pointOf(m, c.center);
      return { kind: "circle", cx: ctr.x, cy: ctr.y, r: c.radius };
    }
    if (c.kind === "ellipse") return { kind: "ellipse", ...ellipseGeom(m, c) };
    const pts = splinePoints(m, c as Extract<SkCurve, { kind: "spline" }>);
    return { kind: "path", start: pts[0], segments: splineBeziers(pts, true).map((b) => ({ kind: "bezier", ...b })), closed: true };
  }

  // Coincident constraints make points one vertex.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  for (const c of s.constraints) if (c.kind === "coincident") parent.set(find(c.a), find(c.b));

  const ends = new Map<SkCurve, [string, string]>();
  const degree = new Map<string, number>();
  for (const c of curves) {
    const e = curveEnds(c)!.map(find) as [string, string];
    ends.set(c, e);
    for (const v of e) degree.set(v, (degree.get(v) ?? 0) + 1);
  }
  if ([...degree.values()].some((d) => d > 2)) throw new Error("The path branches: it must be one chain of curves");
  const tips = [...degree].filter(([, d]) => d === 1).map(([v]) => v);
  const closed = tips.length === 0;

  const pt = (id: string): Pt => {
    const p = pointOf(m, id);
    return [p.x, p.y];
  };
  /** Segments of a curve walked from its end `from`. */
  const walk = (c: SkCurve, from: string): Segment[] => {
    const [a, b] = ends.get(c)!;
    const fwd = a === from;
    if (c.kind === "line") return [{ kind: "line", to: pt(fwd ? b : a) }];
    if (c.kind === "arc") return [{ kind: "arc", to: pt(fwd ? c.end : c.start), mid: arcMidpoint(m, c) }];
    const pts = splinePoints(m, c as Extract<SkCurve, { kind: "spline" }>);
    return splineBeziers(fwd ? pts : pts.reverse()).map((z) => ({ kind: "bezier", ...z }));
  };

  let at = closed ? ends.get(curves[0])![0] : tips[0];
  const start = pt(at);
  const left = new Set(curves);
  const segments: Segment[] = [];
  while (left.size) {
    const next = [...left].find((c) => ends.get(c)!.includes(at));
    if (!next) break;
    left.delete(next);
    segments.push(...walk(next, at));
    const [a, b] = ends.get(next)!;
    at = a === at ? b : a;
  }
  if (left.size) throw new Error("The path is not connected: join its curves end to end");
  return { kind: "path", start, segments, closed };
}
