// PlaneGCS (FreeCAD's sketch solver, WASM) wrapper.
// Translates our sketch model to planegcs primitives, solves, and maps back.

import { GcsWrapper, SolveStatus, init_planegcs_module, type SketchPrimitive } from "@salusoft89/planegcs";
import wasmUrl from "@salusoft89/planegcs/dist/planegcs_dist/planegcs.wasm?url";
import type { SkArc, SkCircle, SkConstraint, SkLine, SkPoint, SketchData } from "./model";
import { entityMap } from "./model";

export interface SolveResult {
  sketch: SketchData;
  ok: boolean;
  /** Remaining degrees of freedom; 0 means fully constrained. */
  dof: number;
  conflicting: string[];
  redundant: string[];
}

export interface DragTarget {
  point: string;
  x: number;
  y: number;
}

let wrapper: GcsWrapper | null = null;
let loading: Promise<GcsWrapper> | null = null;

/** `wasmPath` overrides the bundled URL (used by tests running in Node). */
export function loadSolver(wasmPath: string = wasmUrl): Promise<GcsWrapper> {
  if (wrapper) return Promise.resolve(wrapper);
  if (!loading) {
    loading = init_planegcs_module({ locateFile: () => wasmPath }).then((mod: { GcsSystem: new () => ConstructorParameters<typeof GcsWrapper>[0] }) => {
      wrapper = new GcsWrapper(new mod.GcsSystem());
      return wrapper;
    });
  }
  return loading!;
}

export const solverReady = () => wrapper !== null;

function toPrimitives(s: SketchData, drag?: DragTarget[]): SketchPrimitive[] {
  const m = entityMap(s);
  const fixed = new Set(s.constraints.filter((c) => c.kind === "fixed").map((c) => (c as { point: string }).point));
  const out: SketchPrimitive[] = [];

  // Geometry must be pushed before anything that references it.
  for (const e of s.entities) if (e.kind === "point") out.push({ id: e.id, type: "point", x: e.x, y: e.y, fixed: fixed.has(e.id) });
  for (const e of s.entities) {
    if (e.kind === "line") out.push({ id: e.id, type: "line", p1_id: e.p1, p2_id: e.p2 });
    if (e.kind === "circle") out.push({ id: e.id, type: "circle", c_id: e.center, radius: e.radius });
    if (e.kind === "arc") {
      const c = m.get(e.center) as SkPoint, a = m.get(e.start) as SkPoint, b = m.get(e.end) as SkPoint;
      const a0 = Math.atan2(a.y - c.y, a.x - c.x);
      let a1 = Math.atan2(b.y - c.y, b.x - c.x);
      if (a1 <= a0) a1 += Math.PI * 2;
      out.push({ id: e.id, type: "arc", c_id: e.center, start_id: e.start, end_id: e.end, radius: Math.hypot(a.x - c.x, a.y - c.y), start_angle: a0, end_angle: a1 });
    }
  }
  // Keeps arc end points on the arc's circle, at its start/end angles.
  for (const e of s.entities) if (e.kind === "arc") out.push({ id: `__rules_${e.id}`, type: "arc_rules", a_id: e.id });

  for (const c of s.constraints) {
    const p = constraintPrimitive(c, m);
    if (p) out.push(p);
  }

  for (const [i, d] of (drag ?? []).entries()) {
    if (fixed.has(d.point)) continue;
    out.push({ id: `__drag_x${i}`, type: "coordinate_x", p_id: d.point, x: d.x, temporary: true });
    out.push({ id: `__drag_y${i}`, type: "coordinate_y", p_id: d.point, y: d.y, temporary: true });
  }
  return out;
}

function constraintPrimitive(c: SkConstraint, m: ReturnType<typeof entityMap>): SketchPrimitive | null {
  const id = c.id;
  switch (c.kind) {
    case "fixed":
      return null; // expressed as point.fixed
    case "coincident":
      return { id, type: "p2p_coincident", p1_id: c.a, p2_id: c.b };
    case "horizontal":
      return { id, type: "horizontal_l", l_id: c.line };
    case "vertical":
      return { id, type: "vertical_l", l_id: c.line };
    case "parallel":
      return { id, type: "parallel", l1_id: c.a, l2_id: c.b };
    case "perpendicular":
      return { id, type: "perpendicular_ll", l1_id: c.a, l2_id: c.b };
    case "equal": {
      const ka = m.get(c.a)?.kind, kb = m.get(c.b)?.kind;
      if (ka === "line") return { id, type: "equal_length", l1_id: c.a, l2_id: c.b };
      if (ka === "circle" && kb === "circle") return { id, type: "equal_radius_cc", c1_id: c.a, c2_id: c.b };
      if (ka === "arc" && kb === "arc") return { id, type: "equal_radius_aa", a1_id: c.a, a2_id: c.b };
      // One circle, one arc (in either order).
      return ka === "circle" ? { id, type: "equal_radius_ca", c1_id: c.a, a2_id: c.b } : { id, type: "equal_radius_ca", c1_id: c.b, a2_id: c.a };
    }
    case "pointOnLine":
      return { id, type: "point_on_line_pl", p_id: c.point, l_id: c.line };
    case "pointOnCircle":
      return m.get(c.circle)?.kind === "arc" ? { id, type: "point_on_arc", p_id: c.point, a_id: c.circle } : { id, type: "point_on_circle", p_id: c.point, c_id: c.circle };
    case "tangent":
      return m.get(c.circle)?.kind === "arc" ? { id, type: "tangent_la", l_id: c.line, a_id: c.circle } : { id, type: "tangent_lc", l_id: c.line, c_id: c.circle };
    case "midpoint": {
      const l = m.get(c.line) as SkLine;
      return { id, type: "p2p_symmetric_ppp", p1_id: l.p1, p2_id: l.p2, p_id: c.point };
    }
    case "distance":
      return { id, type: "p2p_distance", p1_id: c.a, p2_id: c.b, distance: c.value };
    case "length": {
      const l = m.get(c.line) as SkLine;
      return { id, type: "p2p_distance", p1_id: l.p1, p2_id: l.p2, distance: c.value };
    }
    case "radius":
      return m.get(c.circle)?.kind === "arc" ? { id, type: "arc_radius", a_id: c.circle, radius: c.value } : { id, type: "circle_radius", c_id: c.circle, radius: c.value };
    case "angle":
      return { id, type: "l2l_angle_ll", l1_id: c.a, l2_id: c.b, angle: (c.value * Math.PI) / 180 };
  }
}

/** Solves synchronously; call loadSolver() once before. */
export function solve(s: SketchData, drag?: DragTarget[]): SolveResult {
  if (!wrapper) throw new Error("Solver not loaded");
  const w = wrapper;
  w.clear_data();
  w.push_primitives_and_params(toPrimitives(s, drag));
  const status = w.solve();
  const ok = status === SolveStatus.Success || status === SolveStatus.Converged;
  const conflicting = w.get_gcs_conflicting_constraints().filter((id) => !id.startsWith("__"));
  const redundant = w.get_gcs_redundant_constraints().filter((id) => !id.startsWith("__"));
  const dof = drag?.length ? -1 : w.gcs.dof();

  if (!ok) return { sketch: s, ok, dof, conflicting, redundant };

  w.apply_solution();
  const solved = new Map(w.sketch_index.get_primitives().map((p) => [p.id, p]));
  const entities = s.entities.map((e) => {
    const p = solved.get(e.id) as Record<string, unknown> | undefined;
    if (!p) return e;
    if (e.kind === "point") return { ...e, x: p.x as number, y: p.y as number };
    if (e.kind === "circle" || e.kind === "arc") return { ...e, radius: Math.abs(p.radius as number) } as SkCircle | SkArc;
    return e;
  });
  return { sketch: { ...s, entities }, ok, dof, conflicting, redundant };
}
