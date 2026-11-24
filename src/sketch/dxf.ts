// DXF import and export for sketches.
//
// Export writes DXF R12 (the most widely read version): lines, circles and
// arcs exactly; ellipses and splines as fine 2D polylines (R12 has no ellipse
// or spline entity). Construction geometry goes on its own layer.
//
// Import reads the ENTITIES section: LINE, CIRCLE, ARC, LWPOLYLINE and
// POLYLINE (with bulges), ELLIPSE and SPLINE. Units come from $INSUNITS
// (millimetres when absent). Ends that coincide become one sketch point, so
// imported outlines are closed profiles that extrude straight away.

import { entityMap, pointOf, skId, type SkEntity, type SketchData } from "./model";
import { curvePolyline } from "./curves";

type Pt = [number, number];

// ---- export -------------------------------------------------------------------

const num = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Object.is(r, -0) ? "0" : String(r);
};

/** The sketch as a DXF R12 file (millimetres, sketch plane coordinates). */
export function sketchToDXF(s: SketchData): string {
  const m = entityMap(s);
  const g: (string | number)[] = [];
  const add = (...pairs: (string | number)[]) => g.push(...pairs);
  add(0, "SECTION", 2, "HEADER", 9, "$ACADVER", 1, "AC1009", 9, "$INSUNITS", 70, 4, 0, "ENDSEC");
  add(0, "SECTION", 2, "TABLES");
  add(0, "TABLE", 2, "LTYPE", 70, 2);
  add(0, "LTYPE", 2, "CONTINUOUS", 70, 0, 3, "Solid line", 72, 65, 73, 0, 40, 0);
  add(0, "LTYPE", 2, "DASHED", 70, 0, 3, "Dashed __ __ __", 72, 65, 73, 2, 40, 4.5, 49, 3, 49, -1.5);
  add(0, "ENDTAB");
  add(0, "TABLE", 2, "LAYER", 70, 2);
  add(0, "LAYER", 2, "SKETCH", 70, 0, 62, 7, 6, "CONTINUOUS");
  add(0, "LAYER", 2, "CONSTRUCTION", 70, 0, 62, 8, 6, "DASHED");
  add(0, "ENDTAB", 0, "ENDSEC");
  add(0, "SECTION", 2, "ENTITIES");
  const polyline = (layer: string, pts: Pt[], closed: boolean) => {
    add(0, "POLYLINE", 8, layer, 66, 1, 10, 0, 20, 0, 30, 0, 70, closed ? 1 : 0);
    for (const p of pts) add(0, "VERTEX", 8, layer, 10, num(p[0]), 20, num(p[1]), 30, 0);
    add(0, "SEQEND", 8, layer);
  };
  for (const e of s.entities) {
    if (e.kind === "point") continue;
    const layer = e.construction ? "CONSTRUCTION" : "SKETCH";
    if (e.kind === "line") {
      const a = pointOf(m, e.p1), b = pointOf(m, e.p2);
      add(0, "LINE", 8, layer, 10, num(a.x), 20, num(a.y), 30, 0, 11, num(b.x), 21, num(b.y), 31, 0);
    } else if (e.kind === "circle") {
      const c = pointOf(m, e.center);
      add(0, "CIRCLE", 8, layer, 10, num(c.x), 20, num(c.y), 30, 0, 40, num(e.radius));
    } else if (e.kind === "arc") {
      const c = pointOf(m, e.center), a = pointOf(m, e.start), b = pointOf(m, e.end);
      const deg = (p: { x: number; y: number }) => ((Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 360) % 360;
      add(0, "ARC", 8, layer, 10, num(c.x), 20, num(c.y), 30, 0, 40, num(Math.hypot(a.x - c.x, a.y - c.y)), 50, num(deg(a)), 51, num(deg(b)));
    } else {
      // Ellipses and splines: closed curves repeat their first point, which the closed flag replaces.
      const pts = curvePolyline(m, e, 48);
      const closed = e.kind === "ellipse" || !!e.closed;
      polyline(layer, closed ? pts.slice(0, -1) : pts, closed);
    }
  }
  add(0, "ENDSEC", 0, "EOF");
  const lines: string[] = [];
  for (let i = 0; i < g.length; i += 2) lines.push(String(g[i]).padStart(3, " "), String(g[i + 1]));
  return lines.join("\r\n") + "\r\n";
}

// ---- import -------------------------------------------------------------------

export interface DXFImport {
  /** New entities (points and curves) in sketch coordinates, mm. */
  entities: SkEntity[];
  /** Curves created. */
  curves: number;
  /** Entity types that were skipped, with their counts. */
  skipped: Record<string, number>;
  /** Scale applied to reach millimetres (from $INSUNITS). */
  unitScale: number;
}

export class DXFError extends Error {}

/** Millimetres per drawing unit for the $INSUNITS codes that make sense here. */
const UNITS: Record<number, number> = { 0: 1, 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 8: 0.0000254, 9: 0.0254, 10: 914.4, 13: 0.001, 14: 100 };

const MAX_CURVES = 5000;

type Pair = { code: number; value: string };

function pairs(text: string): Pair[] {
  const lines = text.split(/\r?\n/);
  const out: Pair[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = Number(lines[i].trim());
    if (!Number.isInteger(code)) throw new DXFError("This doesn't look like a text DXF file (binary DXF isn't supported)");
    out.push({ code, value: lines[i + 1].trim() });
  }
  return out;
}

/** One entity's group codes, in order (codes can repeat, e.g. polyline vertices). */
interface Entity {
  type: string;
  codes: Pair[];
}

const first = (e: Entity, code: number, fallback = 0) => {
  const p = e.codes.find((x) => x.code === code);
  return p ? Number(p.value) : fallback;
};
const all = (e: Entity, code: number) => e.codes.filter((x) => x.code === code).map((x) => Number(x.value));

/** Reads a DXF and returns sketch geometry. Throws DXFError when nothing usable is found. */
export function dxfToSketch(text: string): DXFImport {
  const ps = pairs(text);
  // Header: units.
  let unitScale = 1;
  const ins = ps.findIndex((p) => p.code === 9 && p.value === "$INSUNITS");
  if (ins >= 0 && ps[ins + 1]?.code === 70) unitScale = UNITS[Number(ps[ins + 1].value)] ?? 1;

  // Entities section, split into entities at each code 0.
  const start = ps.findIndex((p, i) => p.code === 2 && p.value === "ENTITIES" && ps[i - 1]?.code === 0 && ps[i - 1].value === "SECTION");
  if (start < 0) throw new DXFError("The file has no ENTITIES section");
  const entities: Entity[] = [];
  for (let i = start + 1; i < ps.length; i++) {
    const p = ps[i];
    if (p.code === 0) {
      if (p.value === "ENDSEC") break;
      entities.push({ type: p.value, codes: [] });
    } else entities.at(-1)?.codes.push(p);
  }

  const out = new Builder(unitScale);
  const skipped: Record<string, number> = {};
  const skip = (t: string) => (skipped[t] = (skipped[t] ?? 0) + 1);
  for (let i = 0; i < entities.length; i++) {
    const e = entities[i];
    // Entities drawn with their extrusion along -Z are mirrored in X (common in CAM exports).
    const flip = first(e, 230, 1) < 0;
    const X = (x: number) => (flip ? -x : x);
    switch (e.type) {
      case "LINE":
        out.line([X(first(e, 10)), first(e, 20)], [X(first(e, 11)), first(e, 21)]);
        break;
      case "CIRCLE":
        out.circle([X(first(e, 10)), first(e, 20)], first(e, 40));
        break;
      case "ARC": {
        let a0 = first(e, 50), a1 = first(e, 51);
        if (flip) [a0, a1] = [180 - a1, 180 - a0];
        out.arc([X(first(e, 10)), first(e, 20)], first(e, 40), a0, a1);
        break;
      }
      case "LWPOLYLINE": {
        const xs = all(e, 10), ys = all(e, 20);
        // Bulges belong to the vertex before them; vertices without one have 0.
        const bulges: number[] = [];
        let v = -1;
        for (const c of e.codes) {
          if (c.code === 10) bulges[++v] = 0;
          else if (c.code === 42 && v >= 0) bulges[v] = Number(c.value);
        }
        out.polyline(xs.map((x, k) => [X(x), ys[k]] as Pt), bulges.map((b) => (flip ? -b : b)), (first(e, 70) & 1) === 1);
        break;
      }
      case "POLYLINE": {
        const closed = (first(e, 70) & 1) === 1;
        const pts: Pt[] = [], bulges: number[] = [];
        while (entities[i + 1]?.type === "VERTEX") {
          const v = entities[++i];
          pts.push([X(first(v, 10)), first(v, 20)]);
          bulges.push(flip ? -first(v, 42) : first(v, 42));
        }
        if (entities[i + 1]?.type === "SEQEND") i++;
        // 3D meshes and polyface meshes aren't sketch geometry.
        if (first(e, 70) & (16 | 64)) skip("POLYLINE (mesh)");
        else out.polyline(pts, bulges, closed);
        break;
      }
      case "ELLIPSE": {
        const c: Pt = [X(first(e, 10)), first(e, 20)];
        const major: Pt = [X(first(e, 11)), first(e, 21)];
        const ratio = first(e, 40, 1);
        let t0 = first(e, 41, 0), t1 = first(e, 42, Math.PI * 2);
        if (flip) [t0, t1] = [Math.PI - t1, Math.PI - t0];
        out.ellipse(c, major, ratio, t0, t1);
        break;
      }
      case "SPLINE": {
        const fit = all(e, 11).map((x, k) => [X(x), all(e, 21)[k]] as Pt);
        const closed = (first(e, 70) & 1) === 1;
        if (fit.length >= 2) out.spline(fit, closed);
        else {
          const ctrl = all(e, 10).map((x, k) => [X(x), all(e, 20)[k]] as Pt);
          const pts = bsplineSamples(ctrl, all(e, 40), all(e, 41), first(e, 71, 3));
          if (pts.length >= 2) out.spline(pts, closed && pts.length > 2);
          else skip("SPLINE (invalid)");
        }
        break;
      }
      case "VERTEX":
      case "SEQEND":
        break;
      default:
        skip(e.type);
    }
    if (out.curves > MAX_CURVES) throw new DXFError(`The file has more than ${MAX_CURVES} curves: too many for a sketch`);
  }
  if (!out.curves) {
    const kinds = Object.keys(skipped);
    throw new DXFError(kinds.length ? `Nothing to import: the file only has ${kinds.join(", ")}` : "The file has no geometry");
  }
  return { entities: out.entities, curves: out.curves, skipped, unitScale };
}

/** Collects sketch entities, sharing points that coincide. */
class Builder {
  entities: SkEntity[] = [];
  curves = 0;
  private points = new Map<string, { id: string; x: number; y: number }>();
  constructor(private scale: number) {}

  /** Id of the point at p (drawing units), created or reused: ends within 1 µm are one point. */
  private point(p: Pt): string {
    const x = p[0] * this.scale, y = p[1] * this.scale;
    const TOL = 1e-3;
    const gx = Math.round(x / TOL), gy = Math.round(y / TOL);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const hit = this.points.get(`${gx + i},${gy + j}`);
        if (hit && Math.hypot(hit.x - x, hit.y - y) <= TOL) return hit.id;
      }
    const id = skId("p");
    this.points.set(`${gx},${gy}`, { id, x, y });
    this.entities.push({ id, kind: "point", x, y });
    return id;
  }

  private same(a: Pt, b: Pt) {
    return Math.hypot((a[0] - b[0]) * this.scale, (a[1] - b[1]) * this.scale) < 1e-3;
  }

  line(a: Pt, b: Pt) {
    if (this.same(a, b)) return;
    this.entities.push({ id: skId("l"), kind: "line", p1: this.point(a), p2: this.point(b) });
    this.curves++;
  }

  circle(c: Pt, r: number) {
    if (!(r > 0)) return;
    this.entities.push({ id: skId("c"), kind: "circle", center: this.point(c), radius: r * this.scale });
    this.curves++;
  }

  /** Counter-clockwise from a0 to a1 (degrees). */
  arc(c: Pt, r: number, a0: number, a1: number) {
    if (!(r > 0)) return;
    let sweep = (((a1 - a0) % 360) + 360) % 360;
    if (sweep < 1e-9) sweep = 360;
    if (sweep >= 360 - 1e-9) return this.circle(c, r);
    const at = (deg: number): Pt => [c[0] + r * Math.cos((deg * Math.PI) / 180), c[1] + r * Math.sin((deg * Math.PI) / 180)];
    this.entities.push({ id: skId("a"), kind: "arc", center: this.point(c), start: this.point(at(a0)), end: this.point(at(a0 + sweep)), radius: r * this.scale });
    this.curves++;
  }

  /** A segment with a bulge (tan of a quarter of the arc's angle; positive is counter-clockwise). */
  private bulgeSegment(a: Pt, b: Pt, bulge: number) {
    if (Math.abs(bulge) < 1e-9) return this.line(a, b);
    if (this.same(a, b)) return;
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const k = (1 - bulge * bulge) / (4 * bulge);
    const c: Pt = [(a[0] + b[0]) / 2 - k * dy, (a[1] + b[1]) / 2 + k * dx];
    const r = (Math.hypot(dx, dy) * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
    const deg = (p: Pt) => (Math.atan2(p[1] - c[1], p[0] - c[0]) * 180) / Math.PI;
    // Counter-clockwise from a to b, or from b to a for a clockwise bulge.
    if (bulge > 0) this.arc(c, r, deg(a), deg(b));
    else this.arc(c, r, deg(b), deg(a));
  }

  polyline(pts: Pt[], bulges: number[], closed: boolean) {
    for (let k = 0; k + 1 < pts.length; k++) this.bulgeSegment(pts[k], pts[k + 1], bulges[k] ?? 0);
    if (closed && pts.length > 2) this.bulgeSegment(pts[pts.length - 1], pts[0], bulges[pts.length - 1] ?? 0);
  }

  /** Full ellipses become sketch ellipses; elliptical arcs become a spline through points on them. */
  ellipse(c: Pt, major: Pt, ratio: number, t0: number, t1: number) {
    const a = Math.hypot(...major);
    if (!(a > 0) || !(ratio > 0)) return;
    const ux = major[0] / a, uy = major[1] / a;
    const at = (t: number): Pt => [c[0] + a * Math.cos(t) * ux - a * ratio * Math.sin(t) * uy, c[1] + a * Math.cos(t) * uy + a * ratio * Math.sin(t) * ux];
    let sweep = (((t1 - t0) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (sweep < 1e-9) sweep = 2 * Math.PI;
    if (sweep >= 2 * Math.PI - 1e-9) {
      this.entities.push({ id: skId("e"), kind: "ellipse", center: this.point(c), major: this.point(at(0)), minor: this.point(at(Math.PI / 2)) });
      this.curves++;
      return;
    }
    const n = Math.max(4, Math.ceil((sweep / (2 * Math.PI)) * 24));
    this.spline(Array.from({ length: n + 1 }, (_, k) => at(t0 + (sweep * k) / n)), false);
  }

  spline(pts: Pt[], closed: boolean) {
    // Drop repeated points (and a closing point equal to the first).
    const clean: Pt[] = [];
    for (const p of pts) if (!clean.length || !this.same(clean[clean.length - 1], p)) clean.push(p);
    if (closed && clean.length > 2 && this.same(clean[0], clean[clean.length - 1])) clean.pop();
    if (clean.length < 2) return;
    if (clean.length === 2 && !closed) return this.line(clean[0], clean[1]);
    this.entities.push({ id: skId("s"), kind: "spline", points: clean.map((p) => this.point(p)), ...(closed ? { closed: true } : {}) });
    this.curves++;
  }
}

/**
 * Points along a (rational) B-spline given by control points, knots and
 * weights, for splines stored without fit points. Enough of them that a
 * smooth curve through them follows the original closely.
 */
export function bsplineSamples(ctrl: Pt[], knots: number[], weights: number[], degree: number): Pt[] {
  const n = ctrl.length;
  if (n < 2) return [];
  const p = Math.max(1, Math.min(degree, n - 1));
  // Clamped uniform knots when the file doesn't give a usable vector.
  const U = knots.length === n + p + 1 ? knots : [...Array(p + 1).fill(0), ...Array.from({ length: n - p - 1 }, (_, k) => (k + 1) / (n - p)), ...Array(p + 1).fill(1)];
  const w = weights.length === n ? weights : Array(n).fill(1);
  const lo = U[p], hi = U[n];
  const count = Math.min(400, Math.max(8, n * 4));
  const out: Pt[] = [];
  for (let s = 0; s <= count; s++) {
    const t = lo + ((hi - lo) * s) / count;
    // Knot span: the last k with U[k] <= t < U[k + 1] (the end belongs to the last span).
    let k = p;
    while (k < n - 1 && t >= U[k + 1]) k++;
    // de Boor in homogeneous coordinates.
    const d = Array.from({ length: p + 1 }, (_, j) => {
      const i = k - p + j, wi = w[i];
      return [ctrl[i][0] * wi, ctrl[i][1] * wi, wi];
    });
    for (let r = 1; r <= p; r++)
      for (let j = p; j >= r; j--) {
        const i = k - p + j;
        const den = U[i + p + 1 - r] - U[i];
        const a = den === 0 ? 0 : (t - U[i]) / den;
        d[j] = [0, 1, 2].map((q) => (1 - a) * d[j - 1][q] + a * d[j][q]);
      }
    out.push([d[p][0] / d[p][2], d[p][1] / d[p][2]]);
  }
  return out;
}

/** Imported entities appended to a sketch. */
export const withImported = (s: SketchData, imported: DXFImport): SketchData => ({ entities: [...s.entities, ...imported.entities], constraints: s.constraints });
