// 2D drawing sheet: layout of the views, dimensions and title block, built as
// plain primitives in paper millimetres (origin bottom-left, y up). The screen
// (SVG) and the exporters (SVG, PDF, DXF) all draw the same primitives.

import type { DrawingDimension, DrawingSheet, DrawingView, ViewDir, ViewProjection } from "../model/types";

export type P2 = [number, number];

export type Prim =
  | { kind: "line"; a: P2; b: P2; width: number; dash?: boolean; layer: Layer; ref?: string }
  | { kind: "tri"; pts: [P2, P2, P2]; layer: Layer; ref?: string }
  | { kind: "text"; at: P2; size: number; text: string; anchor: "start" | "middle" | "end"; angle?: number; layer: Layer; ref?: string };

export type Layer = "visible" | "hidden" | "dims" | "frame";

export const WIDTH = { visible: 0.5, hidden: 0.25, thin: 0.18, frame: 0.7 };

const PAPER: Record<DrawingSheet["size"], [number, number]> = { A4: [297, 210], A3: [420, 297], A2: [594, 420], A1: [841, 594] };

/** Sheet width and height in mm. */
export function paperSize(s: Pick<DrawingSheet, "size" | "orientation">): [number, number] {
  const [w, h] = PAPER[s.size];
  return s.orientation === "landscape" ? [w, h] : [h, w];
}

/** Drawing frame (ISO 5457: 20 mm on the left for binding, 10 elsewhere) and title block. */
export function frame(s: DrawingSheet) {
  const [w, h] = paperSize(s);
  const box = { x0: 20, y0: 10, x1: w - 10, y1: h - 10 };
  const title = { x0: box.x1 - 130, y0: box.y0, x1: box.x1, y1: box.y0 + 32 };
  return { w, h, box, title };
}

/** Standard scales, largest first. */
export const SCALES = [10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05, 0.02, 0.01];

export const scaleLabel = (k: number) => (k >= 1 ? `${round(k)}:1` : `1:${round(1 / k)}`);

const round = (v: number) => Math.round(v * 1000) / 1000;

/** Number as written on a dimension: up to two decimals. */
export const formatValue = (v: number) => String(Math.round(v * 100) / 100);

const VIEW_NAMES: Record<ViewDir, string> = { front: "Front", back: "Back", top: "Top", bottom: "Bottom", left: "Left", right: "Right", iso: "Isometric" };
export const viewName = (d: ViewDir) => VIEW_NAMES[d];

let counter = 0;
const uid = (p: string) => `${p}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Size of a projection in model mm. */
const extent = (p?: ViewProjection) => (p?.bounds ? { w: p.bounds.maxX - p.bounds.minX, h: p.bounds.maxY - p.bounds.minY } : { w: 0, h: 0 });

/**
 * A new sheet with the front view, the top view and a side view arranged by
 * the projection method, plus an isometric view; the largest standard scale that fits.
 */
export function defaultSheet(projections: Map<ViewDir, ViewProjection>, title: string): DrawingSheet {
  const base: DrawingSheet = { size: "A3", orientation: "landscape", scale: 1, projection: "first", title, author: "", views: [], dimensions: [] };
  return { ...base, ...arrange(base, projections) };
}

/** Views and scale for the standard arrangement on `s`'s paper. */
export function arrange(s: DrawingSheet, projections: Map<ViewDir, ViewProjection>): Pick<DrawingSheet, "views" | "scale"> {
  const { box, title } = frame(s);
  const side: ViewDir = s.projection === "first" ? "left" : "right";
  const F = extent(projections.get("front")), T = extent(projections.get("top")), S = extent(projections.get(side)), I = extent(projections.get("iso"));
  const gap = 25;
  // Needed space at scale k: two columns (front|side, then iso) and two rows (front, top).
  const fits = (k: number) => {
    const width = k * (F.w + S.w + Math.max(I.w, 0)) + 4 * gap;
    const height = k * (F.h + T.h) + 3 * gap;
    return width <= box.x1 - box.x0 && height <= box.y1 - box.y0 - (title.y1 - title.y0) / 2;
  };
  const scale = SCALES.find(fits) ?? SCALES[SCALES.length - 1];
  const left = box.x0 + gap + (scale * F.w) / 2;
  const frontY = s.projection === "first" ? box.y1 - gap - (scale * F.h) / 2 : box.y0 + (title.y1 - title.y0) + gap + (scale * F.h) / 2;
  const topY = s.projection === "first" ? frontY - (scale * (F.h + T.h)) / 2 - gap : frontY + (scale * (F.h + T.h)) / 2 + gap;
  const sideX = left + (scale * (F.w + S.w)) / 2 + gap;
  const views: DrawingView[] = [
    { id: uid("v"), dir: "front", x: left, y: frontY, hidden: true },
    { id: uid("v"), dir: "top", x: left, y: topY, hidden: true },
    { id: uid("v"), dir: side, x: sideX, y: frontY, hidden: true },
    { id: uid("v"), dir: "iso", x: Math.min(box.x1 - gap - (scale * I.w) / 2, sideX + (scale * (S.w + I.w)) / 2 + gap), y: s.projection === "first" ? topY : frontY, hidden: false },
  ];
  return { views, scale };
}

/** Paper position of a point given in view coordinates. */
export function toPaper(v: DrawingView, p: ViewProjection | undefined, scale: number, [u, w]: P2): P2 {
  const b = p?.bounds;
  const cx = b ? (b.minX + b.maxX) / 2 : 0, cy = b ? (b.minY + b.maxY) / 2 : 0;
  return [v.x + scale * (u - cx), v.y + scale * (w - cy)];
}

/** View coordinates of a paper point. */
export function toView(v: DrawingView, p: ViewProjection | undefined, scale: number, [x, y]: P2): P2 {
  const b = p?.bounds;
  const cx = b ? (b.minX + b.maxX) / 2 : 0, cy = b ? (b.minY + b.maxY) / 2 : 0;
  return [cx + (x - v.x) / scale, cy + (y - v.y) / scale];
}

/** The nearest snap point within `tol` (view mm), else null. */
export function snapPoint(p: ViewProjection | undefined, q: P2, tol: number): P2 | null {
  let best: P2 | null = null, bestD = tol;
  for (const s of p?.points ?? []) {
    const d = Math.hypot(s[0] - q[0], s[1] - q[1]);
    if (d <= bestD) [best, bestD] = [s, d];
  }
  return best;
}

/** The circle whose outline is nearest `q`, within `tol` (view mm). */
export function snapCircle(p: ViewProjection | undefined, q: P2, tol: number) {
  let best: { cx: number; cy: number; r: number } | null = null, bestD = tol;
  for (const c of p?.circles ?? []) {
    const d = Math.abs(Math.hypot(q[0] - c.cx, q[1] - c.cy) - c.r);
    if (d <= bestD) [best, bestD] = [c, d];
  }
  return best;
}

/** Paper-space box of a view, for picking and selection outlines. */
export function viewBox(v: DrawingView, p: ViewProjection | undefined, scale: number) {
  const b = p?.bounds;
  const w = b ? (b.maxX - b.minX) * scale : 20, h = b ? (b.maxY - b.minY) * scale : 20;
  return { x0: v.x - w / 2, y0: v.y - h / 2, x1: v.x + w / 2, y1: v.y + h / 2 };
}

/** Lines of the views and their labels. */
function viewPrims(s: DrawingSheet, projections: Map<ViewDir, ViewProjection>): Prim[] {
  const out: Prim[] = [];
  for (const v of s.views) {
    const p = projections.get(v.dir);
    if (!p) continue;
    const add = (segs: Float32Array, hidden: boolean) => {
      for (let i = 0; i < segs.length; i += 4) {
        out.push({
          kind: "line",
          a: toPaper(v, p, s.scale, [segs[i], segs[i + 1]]),
          b: toPaper(v, p, s.scale, [segs[i + 2], segs[i + 3]]),
          width: hidden ? WIDTH.hidden : WIDTH.visible,
          dash: hidden,
          layer: hidden ? "hidden" : "visible",
          ref: v.id,
        });
      }
    };
    if (v.hidden && v.dir !== "iso") add(p.hidden, true);
    add(p.visible, false);
    const box = viewBox(v, p, s.scale);
    out.push({ kind: "text", at: [v.x, box.y0 - 7], size: 3.5, text: viewName(v.dir).toUpperCase(), anchor: "middle", layer: "dims", ref: v.id });
  }
  return out;
}

/** Arrowhead with its tip at `tip`, pointing along `dir` (unit). */
function arrow(tip: P2, dir: P2, ref: string): Prim {
  const L = 3, W = 0.9;
  const base: P2 = [tip[0] - dir[0] * L, tip[1] - dir[1] * L];
  const n: P2 = [-dir[1] * W, dir[0] * W];
  return { kind: "tri", pts: [tip, [base[0] + n[0], base[1] + n[1]], [base[0] - n[0], base[1] - n[1]]], layer: "dims", ref };
}

const thin = (a: P2, b: P2, ref: string): Prim => ({ kind: "line", a, b, width: WIDTH.thin, layer: "dims", ref });

export interface ResolvedDimension {
  dim: DrawingDimension;
  value: number;
  /** The referenced geometry is gone (points no longer snap). */
  detached: boolean;
  prims: Prim[];
}

/** Geometry and value of a dimension on the current projections. */
export function resolveDimension(s: DrawingSheet, d: DrawingDimension, projections: Map<ViewDir, ViewProjection>): ResolvedDimension | null {
  const v = s.views.find((x) => x.id === d.view);
  if (!v) return null;
  const p = projections.get(v.dir);
  const tol = 0.05;
  const prims: Prim[] = [];
  const P = (q: P2) => toPaper(v, p, s.scale, q);
  const text = (at: P2, t: string, angle = 0): Prim => ({ kind: "text", at, size: 3.5, text: t, anchor: "middle", angle, layer: "dims", ref: d.id });

  if (d.kind === "diameter" || d.kind === "radius") {
    // The circle on this centre, the one closest to the radius that was picked.
    let circle: { cx: number; cy: number; r: number } | null = null;
    for (const c of p?.circles ?? []) {
      if (Math.hypot(c.cx - d.a[0], c.cy - d.a[1]) >= tol) continue;
      if (!circle || Math.abs(c.r - (d.r ?? c.r)) < Math.abs(circle.r - (d.r ?? circle.r))) circle = c;
    }
    if (circle && d.r !== undefined && Math.abs(circle.r - d.r) > Math.max(0.5, d.r * 0.25)) circle = null;
    const r = circle?.r ?? 0;
    const C = P(d.a), R = r * s.scale;
    const ang = (d.offset * Math.PI) / 180;
    const u: P2 = [Math.cos(ang), Math.sin(ang)];
    const outer: P2 = [C[0] + u[0] * (R + 10), C[1] + u[1] * (R + 10)];
    const onCircle: P2 = [C[0] + u[0] * R, C[1] + u[1] * R];
    const label = d.kind === "diameter" ? `Ø${formatValue(2 * r)}` : `R${formatValue(r)}`;
    if (d.kind === "diameter") {
      const far: P2 = [C[0] - u[0] * R, C[1] - u[1] * R];
      prims.push(thin(far, outer, d.id), arrow(onCircle, [-u[0], -u[1]], d.id), arrow(far, u, d.id));
    } else {
      prims.push(thin(C, outer, d.id), arrow(onCircle, u, d.id));
    }
    // Text on a short shelf at the end of the leader.
    const right = u[0] >= 0;
    const shelf: P2 = [outer[0] + (right ? 12 : -12), outer[1]];
    prims.push(thin(outer, shelf, d.id), text([(outer[0] + shelf[0]) / 2, outer[1] + 1.2], label));
    return { dim: d, value: d.kind === "diameter" ? 2 * r : r, detached: !circle, prims };
  }

  const sa = snapPoint(p, d.a, tol), sb = d.b ? snapPoint(p, d.b, tol) : null;
  const a = sa ?? d.a, b = sb ?? d.b ?? d.a;
  const A = P(a), B = P(b);
  let value: number;
  let L1: P2, L2: P2; // ends of the dimension line
  if (d.kind === "horizontal") {
    value = Math.abs(b[0] - a[0]);
    const y = (A[1] + B[1]) / 2 + d.offset;
    L1 = [A[0], y];
    L2 = [B[0], y];
  } else if (d.kind === "vertical") {
    value = Math.abs(b[1] - a[1]);
    const x = (A[0] + B[0]) / 2 + d.offset;
    L1 = [x, A[1]];
    L2 = [x, B[1]];
  } else {
    value = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const n: P2 = [-(B[1] - A[1]) / len, (B[0] - A[0]) / len];
    L1 = [A[0] + n[0] * d.offset, A[1] + n[1] * d.offset];
    L2 = [B[0] + n[0] * d.offset, B[1] + n[1] * d.offset];
  }
  // Extension lines: from 1 mm off the point to 2 mm past the dimension line.
  for (const [Q, L] of [
    [A, L1],
    [B, L2],
  ] as const) {
    const dx = L[0] - Q[0], dy = L[1] - Q[1], len = Math.hypot(dx, dy);
    if (len < 1.2) continue;
    const e: P2 = [dx / len, dy / len];
    prims.push(thin([Q[0] + e[0], Q[1] + e[1]], [L[0] + e[0] * 2, L[1] + e[1] * 2], d.id));
  }
  const len = Math.hypot(L2[0] - L1[0], L2[1] - L1[1]);
  if (len > 1e-6) {
    const t: P2 = [(L2[0] - L1[0]) / len, (L2[1] - L1[1]) / len];
    prims.push(thin(L1, L2, d.id));
    // Arrows inside when there's room, outside otherwise.
    if (len >= 8) prims.push(arrow(L1, [-t[0], -t[1]], d.id), arrow(L2, t, d.id));
    else {
      prims.push(arrow(L1, t, d.id), arrow(L2, [-t[0], -t[1]], d.id));
      prims.push(thin(L1, [L1[0] - t[0] * 6, L1[1] - t[1] * 6], d.id), thin(L2, [L2[0] + t[0] * 6, L2[1] + t[1] * 6], d.id));
    }
    // Text above the line, readable from the bottom or the right.
    let angle = (Math.atan2(t[1], t[0]) * 180) / Math.PI;
    if (angle > 90.5) angle -= 180;
    if (angle <= -89.5) angle += 180;
    const ar = (angle * Math.PI) / 180;
    const up: P2 = [-Math.sin(ar), Math.cos(ar)];
    const mid: P2 = [(L1[0] + L2[0]) / 2 + up[0] * 1.2, (L1[1] + L2[1]) / 2 + up[1] * 1.2];
    prims.push(text(mid, formatValue(value), angle));
  }
  return { dim: d, value, detached: !sa || (!!d.b && !sb), prims };
}

/** Frame, title block and its fields. */
function framePrims(s: DrawingSheet): Prim[] {
  const { box, title: t } = frame(s);
  const out: Prim[] = [];
  const line = (a: P2, b: P2, width = WIDTH.frame): Prim => ({ kind: "line", a, b, width, layer: "frame" });
  const rect = (x0: number, y0: number, x1: number, y1: number, width = WIDTH.frame) =>
    out.push(line([x0, y0], [x1, y0], width), line([x1, y0], [x1, y1], width), line([x1, y1], [x0, y1], width), line([x0, y1], [x0, y0], width));
  rect(box.x0, box.y0, box.x1, box.y1);
  rect(t.x0, t.y0, t.x1, t.y1);
  // Rows: title (top, tall); then author | scale; then date | size | projection.
  const r1 = t.y1 - 14, r2 = t.y1 - 23;
  out.push(line([t.x0, r1], [t.x1, r1], WIDTH.thin), line([t.x0, r2], [t.x1, r2], WIDTH.thin));
  const c1 = t.x0 + 80, c2 = t.x0 + 50, c3 = t.x0 + 95;
  out.push(line([c1, r1], [c1, r2], WIDTH.thin), line([c2, r2], [c2, t.y0], WIDTH.thin), line([c3, r2], [c3, t.y0], WIDTH.thin));
  const label = (x: number, y: number, txt: string): Prim => ({ kind: "text", at: [x + 1.5, y - 2.6], size: 1.8, text: txt, anchor: "start", layer: "frame" });
  const value = (x: number, y: number, txt: string, size = 3.5): Prim => ({ kind: "text", at: [x + 1.5, y], size, text: txt, anchor: "start", layer: "frame" });
  out.push(label(t.x0, t.y1, "TITLE"), value(t.x0, r1 + 2.5, s.title || "Untitled", 5));
  out.push(label(t.x0, r1, "AUTHOR"), value(t.x0, r2 + 2, s.author));
  out.push(label(c1, r1, "SCALE"), value(c1, r2 + 2, scaleLabel(s.scale)));
  out.push(label(t.x0, r2, "DATE"), value(t.x0, t.y0 + 2, new Date().toISOString().slice(0, 10)));
  out.push(label(c2, r2, "SHEET"), value(c2, t.y0 + 2, `${s.size} · mm`));
  out.push(label(c3, r2, "PROJECTION"), value(c3, t.y0 + 2, s.projection === "first" ? "First angle" : "Third angle", 3));
  return out;
}

/** Every primitive of the sheet: frame, views, dimensions. */
export function sheetPrims(s: DrawingSheet, projections: Map<ViewDir, ViewProjection>): { prims: Prim[]; dims: ResolvedDimension[] } {
  const dims = s.dimensions.map((d) => resolveDimension(s, d, projections)).filter((x): x is ResolvedDimension => !!x);
  return { prims: [...framePrims(s), ...viewPrims(s, projections), ...dims.flatMap((d) => d.prims)], dims };
}

export const newViewId = () => uid("v");
export const newDimensionId = () => uid("dim");

/**
 * Kind and offset for a linear dimension between paper points A and B with
 * the dimension line through `at`: beside the pair it's vertical, above or
 * below it horizontal; `aligned` keeps it parallel to AB.
 */
export function placeLinear(A: P2, B: P2, at: P2, aligned: boolean): { kind: "horizontal" | "vertical" | "aligned"; offset: number } {
  if (aligned) {
    const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
    const n: P2 = [-(B[1] - A[1]) / len, (B[0] - A[0]) / len];
    return { kind: "aligned", offset: (at[0] - A[0]) * n[0] + (at[1] - A[1]) * n[1] };
  }
  const outX = Math.max(0, Math.min(A[0], B[0]) - at[0], at[0] - Math.max(A[0], B[0]));
  const outY = Math.max(0, Math.min(A[1], B[1]) - at[1], at[1] - Math.max(A[1], B[1]));
  const sameX = Math.abs(A[0] - B[0]) < 1e-6, sameY = Math.abs(A[1] - B[1]) < 1e-6;
  const vertical = sameX || (!sameY && outX > outY);
  return vertical ? { kind: "vertical", offset: at[0] - (A[0] + B[0]) / 2 } : { kind: "horizontal", offset: at[1] - (A[1] + B[1]) / 2 };
}

/** New offset of an existing dimension dragged to paper point `at`. */
export function dragOffset(s: DrawingSheet, d: DrawingDimension, projections: Map<ViewDir, ViewProjection>, at: P2): number {
  const v = s.views.find((x) => x.id === d.view);
  if (!v) return d.offset;
  const p = projections.get(v.dir);
  const A = toPaper(v, p, s.scale, d.a);
  if (d.kind === "diameter" || d.kind === "radius") return (Math.atan2(at[1] - A[1], at[0] - A[0]) * 180) / Math.PI;
  const B = toPaper(v, p, s.scale, d.b ?? d.a);
  if (d.kind === "horizontal") return at[1] - (A[1] + B[1]) / 2;
  if (d.kind === "vertical") return at[0] - (A[0] + B[0]) / 2;
  return placeLinear(A, B, at, true).offset;
}
