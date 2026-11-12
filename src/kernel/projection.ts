// Hidden-line projections of the model for 2D drawings (OCCT's HLR through replicad).

import { makeProjectedEdges, ProjectionCamera, type AnyShape, type Edge } from "replicad";
import type { ViewDir, ViewProjection } from "../model/types";
import type { Vec3 } from "../model/frame";

/** Direction towards the viewer and the view's x axis (Z is up in the model). */
export const VIEW_AXES: Record<ViewDir, { dir: Vec3; x: Vec3 }> = {
  front: { dir: [0, -1, 0], x: [1, 0, 0] },
  back: { dir: [0, 1, 0], x: [-1, 0, 0] },
  top: { dir: [0, 0, 1], x: [1, 0, 0] },
  bottom: { dir: [0, 0, -1], x: [1, 0, 0] },
  right: { dir: [1, 0, 0], x: [0, 1, 0] },
  left: { dir: [-1, 0, 0], x: [0, -1, 0] },
  iso: { dir: [1 / Math.sqrt(3), -1 / Math.sqrt(3), 1 / Math.sqrt(3)], x: [1 / Math.SQRT2, 1 / Math.SQRT2, 0] },
};

type P2 = [number, number];

/** Points along an edge: its ends for a line, enough samples for a curve. */
function sample(e: Edge): P2[] {
  const at = (t: number): P2 => {
    const p = e.pointAt(t);
    return [p.x, p.y];
  };
  if (e.geomType === "LINE") return [at(0), at(1)];
  const n = Math.max(8, Math.min(96, Math.ceil(e.length / 0.5)));
  return Array.from({ length: n + 1 }, (_, i) => at(i / n));
}

/** Circle through three points, or null when they're (nearly) collinear. */
function circle3(a: P2, b: P2, c: P2): { cx: number; cy: number; r: number } | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] ** 2 + a[1] ** 2, b2 = b[0] ** 2 + b[1] ** 2, c2 = c[0] ** 2 + c[1] ** 2;
  const cx = (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d;
  const cy = (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d;
  return { cx, cy, r: Math.hypot(a[0] - cx, a[1] - cy) };
}

const key = (p: P2) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`;

export function projectView(shape: AnyShape, dir: ViewDir, withHidden = true): ViewProjection {
  const { dir: d, x } = VIEW_AXES[dir];
  const camera = new ProjectionCamera([0, 0, 0], d, x);
  try {
    const { visible, hidden } = makeProjectedEdges(shape, camera, withHidden);
    const points = new Map<string, P2>();
    const circles = new Map<string, { cx: number; cy: number; r: number }>();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const segs = (edges: Edge[], keep: boolean) => {
      const out: number[] = [];
      for (const e of edges) {
        const pts = sample(e);
        for (let i = 0; i + 1 < pts.length; i++) out.push(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        for (const p of pts) {
          minX = Math.min(minX, p[0]);
          maxX = Math.max(maxX, p[0]);
          minY = Math.min(minY, p[1]);
          maxY = Math.max(maxY, p[1]);
        }
        if (!keep) continue;
        // Ends of open edges; a closed curve's seam is not a meaningful point.
        const first = pts[0], last = pts[pts.length - 1];
        if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 1e-6) for (const p of [first, last]) points.set(key(p), p);
        // Arcs and circles: fit through three samples and check the rest.
        if (e.geomType !== "LINE" && pts.length >= 5) {
          const c = circle3(pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)]);
          if (c && c.r > 1e-3 && pts.every((p) => Math.abs(Math.hypot(p[0] - c.cx, p[1] - c.cy) - c.r) < 1e-3 * Math.max(1, c.r))) {
            circles.set(`${c.cx.toFixed(3)},${c.cy.toFixed(3)},${c.r.toFixed(3)}`, c);
            points.set(key([c.cx, c.cy]), [c.cx, c.cy]);
          }
        }
      }
      return new Float32Array(out);
    };
    const vis = segs(visible, true);
    const hid = segs(hidden, false);
    for (const e of [...visible, ...hidden]) e.delete();
    return {
      dir,
      visible: vis,
      hidden: hid,
      points: [...points.values()],
      circles: [...circles.values()],
      bounds: Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null,
    };
  } finally {
    camera.delete();
  }
}
