// Finds closed regions in a sketch for the kernel to turn into faces.
// Pure geometry, no WASM: runs in the kernel worker and in tests.

import type { SkLine, SketchData } from "./model";
import { entityMap, pointOf } from "./model";

export type Loop =
  | { kind: "polygon"; points: [number, number][] }
  | { kind: "circle"; cx: number; cy: number; r: number };

export interface ProfileResult {
  loops: Loop[];
  /** Curves that are not part of any closed loop (shown, but ignored by solids). */
  openCurves: string[];
}

const TOL = 1e-6;

/**
 * Closed loops from non-construction geometry. Lines are joined through shared
 * point ids or coincident constraints; every vertex of a loop must have degree 2.
 */
export function findLoops(s: SketchData): ProfileResult {
  const m = entityMap(s);
  const loops: Loop[] = [];
  const openCurves: string[] = [];

  for (const e of s.entities) {
    if (e.kind === "circle" && !e.construction) {
      const c = pointOf(m, e.center);
      if (e.radius > TOL) loops.push({ kind: "circle", cx: c.x, cy: c.y, r: e.radius });
    }
  }

  // Union-find over point ids so coincident points act as one vertex.
  const parent = new Map<string, string>();
  const find = (a: string): string => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const union = (a: string, b: string) => parent.set(find(a), find(b));
  for (const c of s.constraints) if (c.kind === "coincident") union(c.a, c.b);

  const lines = s.entities.filter((e): e is SkLine => e.kind === "line" && !e.construction);
  const adj = new Map<string, SkLine[]>();
  for (const l of lines) {
    for (const p of [find(l.p1), find(l.p2)]) {
      if (!adj.has(p)) adj.set(p, []);
      adj.get(p)!.push(l);
    }
  }

  const visited = new Set<string>();
  for (const start of lines) {
    if (visited.has(start.id)) continue;
    // Collect the connected component.
    const comp: SkLine[] = [];
    const stack = [start];
    while (stack.length) {
      const l = stack.pop()!;
      if (visited.has(l.id)) continue;
      visited.add(l.id);
      comp.push(l);
      for (const p of [find(l.p1), find(l.p2)]) for (const n of adj.get(p) ?? []) if (!visited.has(n.id)) stack.push(n);
    }
    const vertices = new Set(comp.flatMap((l) => [find(l.p1), find(l.p2)]));
    const simpleCycle = comp.length >= 3 && [...vertices].every((v) => adj.get(v)!.length === 2);
    if (!simpleCycle) {
      openCurves.push(...comp.map((l) => l.id));
      continue;
    }
    // Walk the cycle.
    const pts: [number, number][] = [];
    let cur = comp[0];
    let at = find(cur.p1);
    const used = new Set<string>();
    for (let i = 0; i < comp.length; i++) {
      used.add(cur.id);
      const p = pointOf(m, find(cur.p1) === at ? cur.p1 : cur.p2);
      pts.push([p.x, p.y]);
      at = find(cur.p1) === at ? find(cur.p2) : find(cur.p1);
      const next = adj.get(at)!.find((l) => !used.has(l.id));
      if (!next) break;
      cur = next;
    }
    if (Math.abs(polygonArea(pts)) > TOL) loops.push({ kind: "polygon", points: pts });
    else openCurves.push(...comp.map((l) => l.id));
  }

  return { loops, openCurves };
}

export function polygonArea(pts: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function loopArea(l: Loop): number {
  return l.kind === "circle" ? Math.PI * l.r * l.r : Math.abs(polygonArea(l.points));
}

function samplePoint(l: Loop): [number, number] {
  if (l.kind === "circle") return [l.cx + l.r * 0.999, l.cy];
  // Point slightly inside the first edge's midpoint is not needed: a vertex works
  // for containment against *other* loops as long as loops don't touch.
  return l.points[0];
}

export function loopContains(outer: Loop, [x, y]: [number, number]): boolean {
  if (outer.kind === "circle") return (x - outer.cx) ** 2 + (y - outer.cy) ** 2 < outer.r * outer.r;
  let inside = false;
  const p = outer.points;
  for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
    const [xi, yi] = p[i];
    const [xj, yj] = p[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Orders loops by area and assigns nesting depth: even depth adds material,
 * odd depth is a hole.
 */
export function nestLoops(loops: Loop[]): { loop: Loop; depth: number }[] {
  const sorted = [...loops].sort((a, b) => loopArea(b) - loopArea(a));
  return sorted.map((loop, i) => {
    const pt = samplePoint(loop);
    const depth = sorted.slice(0, i).filter((o) => loopContains(o, pt)).length;
    return { loop, depth };
  });
}
