// Hit testing and small geometric helpers for the sketch editor.

import type { SkCircle, SkLine, SketchData } from "./model";
import { entityMap, pointOf } from "./model";

export type Hit = { kind: "point" | "line" | "circle"; id: string };

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Nearest entity within `tol` (sketch units); points win over curves. */
export function hitTest(s: SketchData, x: number, y: number, tol: number, exclude: Set<string> = new Set()): Hit | null {
  const m = entityMap(s);
  let best: Hit | null = null;
  let bestD = tol;
  for (const e of s.entities) {
    if (e.kind !== "point" || exclude.has(e.id)) continue;
    const d = Math.hypot(e.x - x, e.y - y);
    if (d <= bestD) {
      bestD = d;
      best = { kind: "point", id: e.id };
    }
  }
  if (best) return best;
  bestD = tol;
  for (const e of s.entities) {
    if (exclude.has(e.id)) continue;
    let d = Infinity;
    if (e.kind === "line") {
      const a = pointOf(m, e.p1), b = pointOf(m, e.p2);
      d = distToSegment(x, y, a.x, a.y, b.x, b.y);
    } else if (e.kind === "circle") {
      const c = pointOf(m, e.center);
      d = Math.abs(Math.hypot(x - c.x, y - c.y) - e.radius);
    }
    if (d <= bestD) {
      bestD = d;
      best = { kind: e.kind as "line" | "circle", id: e.id };
    }
  }
  return best;
}

export function lineEnds(s: SketchData | ReturnType<typeof entityMap>, l: SkLine) {
  return [pointOf(s, l.p1), pointOf(s, l.p2)] as const;
}

export function circleCenter(s: SketchData | ReturnType<typeof entityMap>, c: SkCircle) {
  return pointOf(s, c.center);
}

export function bounds(s: SketchData): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const m = entityMap(s);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const add = (x: number, y: number) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const e of s.entities) {
    if (e.kind === "point") add(e.x, e.y);
    if (e.kind === "circle") {
      const c = pointOf(m, e.center);
      add(c.x - e.radius, c.y - e.radius);
      add(c.x + e.radius, c.y + e.radius);
    }
  }
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}
