import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactElement, type WheelEvent as RWheelEvent } from "react";
import type { SketchFeature, SketchImage } from "../model/types";
import { constraintActions, CONSTRAINT_GLYPH, dimensionFor } from "./actions";
import { addArcThrough, addCircle, addConstraint, addEllipse, addLineBetween, addPoint, addRectangle, addSpline, addTangentArc, exitDirection, tangentArcGeom } from "./builders";
import { ellipseGeom, splineBeziers, splinePoints, type Pt } from "./curves";
import { addSlot, circularPlace, filletCorner, linearPlace, offsetCurves, patternCurves, trimCurve } from "./edit";
import { addProjected, distanceTo, type Projected } from "./project";
import { arcMidpoint } from "./profiles";
import { bounds, hitTest, type Hit } from "./geometry";
import { skId } from "./model";
import type { NewConstraint, SkArc, SkCircle, SkConstraint, SkCurve, SkEllipse, SkLine, SketchData } from "./model";
import { curvePoints, entityMap, isDimension, pointOf, removeConstraints, removeEntities } from "./model";
import { solve, type DragTarget, type SolveResult } from "./solver";
import { DXFError, dxfToSketch, sketchToDXF, withImported } from "./dxf";
import { downloadBlob } from "../io/storage";
import { evalExpr, isPlainNumber, type Scope } from "../expr/expr";

type Tool = "select" | "line" | "rect" | "circle" | "arc" | "tarc" | "ellipse" | "spline" | "slot" | "fillet" | "trim" | "project";

interface Props {
  feature: SketchFeature;
  scope: Scope;
  /** Edges of the face being sketched on, as 2D segment pairs (x1, y1, x2, y2). */
  reference?: Float32Array;
  /** The model's edges seen through the sketch plane, for the Project tool. */
  projectable?: Projected[];
  onCommit: (sketch: SketchData) => void;
  /** Saves the reference pictures (added, moved, scaled or removed). */
  onImages?: (images: SketchImage[]) => void;
  onExit: () => void;
  /** Reports the 2D view (center in sketch coordinates, pixels per mm) so the 3D camera can follow it. */
  onViewChange?: (view: { cx: number; cy: number; scale: number }) => void;
}

interface View {
  cx: number;
  cy: number;
  /** pixels per mm */
  scale: number;
}

/** In-progress drawing: anchors already placed by the active tool. */
type Pending =
  | { tool: "line"; from: string | null; x: number; y: number; chainStart: string | null }
  | { tool: "rect"; x: number; y: number }
  | { tool: "circle"; center: string | null; x: number; y: number }
  | { tool: "arc"; start: string | null; sx: number; sy: number; end?: { id: string | null; x: number; y: number } }
  /** Tangent arc leaving `curve` at its end point `from`. */
  | { tool: "tarc"; curve: string; from: string }
  | { tool: "ellipse"; cx: number; cy: number; center: string | null; major?: { x: number; y: number } }
  | { tool: "spline"; points: { id: string | null; x: number; y: number }[] }
  /** Slot: the first arc centre, then the second; the third click sets the width. */
  | { tool: "slot"; a: { id: string | null; x: number; y: number }; b?: { id: string | null; x: number; y: number } }
  | null;

interface DragState {
  base: SketchData;
  points: { id: string; x0: number; y0: number }[];
  startX: number;
  startY: number;
  moved: boolean;
}

interface EditState {
  id: string;
  sx: number;
  sy: number;
  text: string;
}

const SNAP_PX = 9;
const AXIS_SNAP_DEG = 4;
const TOOL_KEYS: Record<string, Tool> = { s: "select", l: "line", r: "rect", c: "circle", a: "arc", g: "tarc", o: "ellipse", p: "spline", b: "slot", u: "fillet", k: "trim", j: "project" };

/** The line or arc ending at point `id` that a tangent arc should continue (the newest one). */
function curveEndingAt(s: SketchData, id: string): string | null {
  for (let i = s.entities.length - 1; i >= 0; i--) {
    const e = s.entities[i];
    if ((e.kind === "line" && (e.p1 === id || e.p2 === id)) || (e.kind === "arc" && (e.start === id || e.end === id))) return e.id;
  }
  return null;
}

const fmt = (v: number) => (Math.abs(v - Math.round(v)) < 1e-6 ? String(Math.round(v)) : v.toFixed(2));

export function SketchEditor({ feature, scope, reference, projectable = [], onCommit, onImages, onExit, onViewChange }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [sketch, setSketch] = useState<SketchData>(feature.sketch);
  const [status, setStatus] = useState<Omit<SolveResult, "sketch"> | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Pending>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [hover, setHover] = useState<Hit | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  /** Offset distance being typed (null when the offset field is closed). */
  const [offsetText, setOffsetText] = useState<string | null>(null);
  /** Pattern being set up for the selected curves (null when its fields are closed). */
  /** Radius for the Fillet tool. */
  const [filletText, setFilletText] = useState("2");
  const [patternForm, setPatternForm] = useState<{ mode: "linear" | "circular"; count: string; dx: string; dy: string; angle: string } | null>(null);
  const drag = useRef<DragState | null>(null);
  /** Reference pictures, the selected one, and one being dragged. */
  const [images, setImages] = useState<SketchImage[]>(feature.images ?? []);
  const [imageSel, setImageSel] = useState<string | null>(null);
  const imgDrag = useRef<{ id: string; x0: number; y0: number; sx: number; sy: number; moved: boolean } | null>(null);
  /** Scale calibration: two points picked on the picture, then their real distance. */
  const [calib, setCalib] = useState<{ id: string; pts: { x: number; y: number }[]; text: string } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const dxfInput = useRef<HTMLInputElement>(null);
  /** Information (not an error) shown in the status bar, e.g. what a DXF import brought in. */
  const [notice, setNotice] = useState<string | null>(null);
  const pan = useRef<{ x: number; y: number; cx: number; cy: number } | null>(null);

  const [view, setView] = useState<View>(() => {
    const b = bounds(feature.sketch);
    if (!b) return { cx: 0, cy: 0, scale: 6 };
    return { cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: 6 };
  });

  // Follow external changes (undo/redo) unless a drag is in progress.
  useEffect(() => {
    if (!drag.current) setSketch(feature.sketch);
  }, [feature.sketch]);

  useEffect(() => {
    if (!imgDrag.current) setImages(feature.images ?? []);
  }, [feature.images]);

  const commitImages = (list: SketchImage[]) => {
    setImages(list);
    onImages?.(list);
  };

  /** Adds the curves of a DXF file to the sketch, at their own coordinates, and shows them. */
  const importDXF = async (file: File) => {
    try {
      const r = dxfToSketch(await file.text());
      const next = withImported(sketch, r);
      if (!apply(next, "the import")) return;
      const b = bounds(next);
      if (b) {
        const w = Math.max(b.maxX - b.minX, 10), h = Math.max(b.maxY - b.minY, 10);
        setView({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: Math.min(size.w / w, size.h / h) * 0.55 });
      }
      const skipped = Object.entries(r.skipped).map(([t, n]) => `${n} ${t}`);
      const units = r.unitScale === 25.4 ? " (inches converted to mm)" : r.unitScale !== 1 ? ` (scaled ×${r.unitScale} to mm)` : "";
      setNotice(`Imported ${r.curves} curve${r.curves === 1 ? "" : "s"} from ${file.name}${units}${skipped.length ? `; skipped ${skipped.join(", ")}` : ""}`);
    } catch (e) {
      setNotice(null);
      setMessage(e instanceof DXFError ? e.message : `Can't read ${file.name}: ${e instanceof Error ? e.message : e}`);
    }
  };

  const exportDXF = () => {
    downloadBlob(new Blob([sketchToDXF(sketch)], { type: "application/dxf" }), `${feature.name.replace(/[\\/:*?"<>|]/g, "_")}.dxf`);
    setNotice(`Exported ${feature.name}.dxf (mm, R12)`);
  };

  /** Reads a picture, shrinks it to at most 1600 px and places it in the middle of the view. */
  const importImage = async (file: File) => {
    try {
      const url = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(r.result as string);
        r.onerror = () => rej(r.error);
        r.readAsDataURL(file);
      });
      const img = new Image();
      img.src = url;
      await img.decode();
      const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      const cv = document.createElement("canvas");
      cv.width = Math.max(1, Math.round(img.naturalWidth * k));
      cv.height = Math.max(1, Math.round(img.naturalHeight * k));
      cv.getContext("2d")!.drawImage(img, 0, 0, cv.width, cv.height);
      // PNG keeps transparency; when it comes out big, JPEG it is.
      let src = file.type === "image/png" ? cv.toDataURL("image/png") : "";
      if (!src || src.length > 1_500_000) src = cv.toDataURL("image/jpeg", 0.85);
      const width = (size.w / view.scale) * 0.6;
      const im: SketchImage = { id: skId("img"), src, x: view.cx, y: view.cy, width, height: (width * cv.height) / cv.width, opacity: 0.6 };
      commitImages([...images, im]);
      setImageSel(im.id);
      setSelection(new Set());
      setMessage("Picture added: drag it into place, then use Scale to set its real size.");
    } catch {
      setMessage("Couldn't read that picture.");
    }
  };

  /** Scales the picture being calibrated so the two picked points are `text` mm apart. */
  const applyCalibration = () => {
    if (!calib || calib.pts.length < 2) return;
    let real: number;
    try {
      real = evalExpr(calib.text.trim().replace(",", "."), scope);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    const [p, q] = calib.pts;
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (!(real > 0) || d < 1e-9) {
      setMessage("The distance must be positive.");
      return;
    }
    const k = real / d;
    commitImages(images.map((im) => (im.id === calib.id ? { ...im, width: im.width * k, height: im.height * k, x: p.x + (im.x - p.x) * k, y: p.y + (im.y - p.y) * k } : im)));
    setCalib(null);
    setMessage(null);
  };

  const imageAt = (x: number, y: number) =>
    [...images].reverse().find((im) => Math.abs(x - im.x) <= im.width / 2 && Math.abs(y - im.y) <= im.height / 2) ?? null;

  // Initial status.
  useEffect(() => {
    const r = solve(feature.sketch);
    setStatus(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = svgRef.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fit the sketch once we know the real size.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || size.w < 50) return;
    fitted.current = true;
    let b = bounds(sketch);
    if (reference?.length) {
      const xs = reference.filter((_, i) => i % 2 === 0), ys = reference.filter((_, i) => i % 2 === 1);
      const rb = { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
      b = b ? { minX: Math.min(b.minX, rb.minX), maxX: Math.max(b.maxX, rb.maxX), minY: Math.min(b.minY, rb.minY), maxY: Math.max(b.maxY, rb.maxY) } : rb;
    }
    if (!b) return;
    const w = Math.max(b.maxX - b.minX, 10), h = Math.max(b.maxY - b.minY, 10);
    setView({ cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2, scale: Math.min(size.w / w, size.h / h) * 0.55 });
  }, [size, sketch]);

  useEffect(() => {
    onViewChange?.(view);
  }, [view, onViewChange]);

  const toScreen = useCallback((x: number, y: number) => [size.w / 2 + (x - view.cx) * view.scale, size.h / 2 - (y - view.cy) * view.scale] as const, [size, view]);
  const toWorld = useCallback((sx: number, sy: number) => ({ x: view.cx + (sx - size.w / 2) / view.scale, y: view.cy - (sy - size.h / 2) / view.scale }), [size, view]);

  const eventWorld = (ev: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect();
    return toWorld(ev.clientX - r.left, ev.clientY - r.top);
  };

  /** Solves and commits, or rejects the change with a message if it over-constrains the sketch. */
  const apply = useCallback(
    (next: SketchData, what = "change"): boolean => {
      const r = solve(next);
      if (!r.ok || r.conflicting.length) {
        setMessage(`Can't apply ${what}: it conflicts with existing constraints.`);
        return false;
      }
      setMessage(r.redundant.length ? "Some constraints are redundant." : null);
      setSketch(r.sketch);
      setStatus(r);
      onCommit(r.sketch);
      return true;
    },
    [onCommit],
  );

  const snapPoint = (x: number, y: number, exclude?: Set<string>): string | null => {
    const h = hitTest(sketch, x, y, SNAP_PX / view.scale, exclude);
    return h?.kind === "point" ? h.id : null;
  };

  /** Snaps to a vertex of the reference face, if one is close. */
  const refSnap = (x: number, y: number): { x: number; y: number } | null => {
    if (!reference) return null;
    const tol = SNAP_PX / view.scale;
    for (let i = 0; i < reference.length; i += 2) {
      if (Math.hypot(reference[i] - x, reference[i + 1] - y) <= tol) return { x: reference[i], y: reference[i + 1] };
    }
    return null;
  };

  /** Free points snap to a 1 mm grid (finer when zoomed in). */
  const gridSnap = (v: number) => {
    const step = view.scale > 20 ? 0.1 : view.scale > 4 ? 1 : 5;
    return Math.round(v / step) * step;
  };

  const pointAt = (s: SketchData, x: number, y: number): { sketch: SketchData; id: string } => {
    const existing = snapPoint(x, y);
    if (existing) return { sketch: s, id: existing };
    const ref = refSnap(x, y);
    const r = ref ? addPoint(s, ref.x, ref.y) : addPoint(s, gridSnap(x), gridSnap(y));
    return { sketch: r.sketch, id: r.ids[0] };
  };

  const cancelPending = () => setPending(null);

  /** The model edge under the cursor, for the Project tool. */
  const nearestProjectable = (x: number, y: number): Projected | null => {
    let best: Projected | null = null, bestD = SNAP_PX / view.scale;
    for (const c of projectable) {
      const d = distanceTo(c, { x, y });
      if (d < bestD) [best, bestD] = [c, d];
    }
    return best;
  };

  /** A projected curve as an SVG polyline (arcs and circles sampled). */
  const projectedPoints = (c: Projected): string => {
    let pts: { x: number; y: number }[];
    if (c.kind === "line") pts = [c.a, c.b];
    else if (c.kind === "spline") pts = c.closed ? [...c.points, c.points[0]] : c.points;
    else {
      const a0 = c.kind === "circle" ? 0 : Math.atan2(c.a.y - c.c.y, c.a.x - c.c.x);
      let a1 = c.kind === "circle" ? 2 * Math.PI : Math.atan2(c.b.y - c.c.y, c.b.x - c.c.x);
      if (a1 <= a0) a1 += 2 * Math.PI;
      const n = Math.max(8, Math.ceil(((a1 - a0) / (2 * Math.PI)) * 64));
      pts = Array.from({ length: n + 1 }, (_, i) => ({ x: c.c.x + c.r * Math.cos(a0 + ((a1 - a0) * i) / n), y: c.c.y + c.r * Math.sin(a0 + ((a1 - a0) * i) / n) }));
    }
    return pts.map((p) => toScreen(p.x, p.y).join(",")).join(" ");
  };

  /** Commits the spline being drawn (needs two points, three when closed). */
  const finishSpline = (placed: { id: string | null; x: number; y: number }[], closed: boolean) => {
    setPending(null);
    if (placed.length < 2) return;
    let s = sketch;
    const ids = placed.map((p) => {
      if (p.id) return p.id;
      const r = addPoint(s, p.x, p.y);
      s = r.sketch;
      return r.ids[0];
    });
    const r = addSpline(s, ids, closed);
    if (r) apply(r.sketch, "spline");
  };

  // ---- pointer handling ----------------------------------------------------

  const onPointerDown = (ev: RPointerEvent) => {
    if (edit) return;
    (ev.target as Element).setPointerCapture?.(ev.pointerId);
    const { x, y } = eventWorld(ev);

    if (ev.button === 1 || ev.button === 2 || (ev.button === 0 && ev.altKey)) {
      pan.current = { x: ev.clientX, y: ev.clientY, cx: view.cx, cy: view.cy };
      return;
    }
    if (ev.button !== 0) return;

    if (calib) {
      if (calib.pts.length < 2) {
        const snap = snapPoint(x, y);
        const at = snap ? pointOf(sketch, snap) : { x, y };
        setCalib({ ...calib, pts: [...calib.pts, { x: at.x, y: at.y }] });
      }
      return;
    }

    if (tool === "select") {
      const h = hitTest(sketch, x, y, SNAP_PX / view.scale);
      if (!h) {
        setSelection(new Set());
        const im = imageAt(x, y);
        setImageSel(im?.id ?? null);
        if (im) imgDrag.current = { id: im.id, x0: im.x, y0: im.y, sx: x, sy: y, moved: false };
        return;
      }
      setImageSel(null);
      setSelection((sel) => {
        const n = new Set(ev.shiftKey || ev.metaKey ? sel : sel.has(h.id) ? sel : []);
        if (n.has(h.id) && (ev.shiftKey || ev.metaKey)) n.delete(h.id);
        else n.add(h.id);
        return n;
      });
      const m = entityMap(sketch);
      const e = m.get(h.id)!;
      const ids = e.kind === "point" ? [e.id] : curvePoints(e);
      drag.current = {
        base: sketch,
        points: ids.map((id) => ({ id, x0: pointOf(m, id).x, y0: pointOf(m, id).y })),
        startX: x,
        startY: y,
        moved: false,
      };
      return;
    }

    if (tool === "line") {
      let s = sketch;
      if (!pending || pending.tool !== "line") {
        const snap = snapPoint(x, y);
        const at = snap ? pointOf(s, snap) : { x: gridSnap(x), y: gridSnap(y) };
        setPending({ tool: "line", from: snap, x: at.x, y: at.y, chainStart: snap });
        return;
      }
      let from = pending.from;
      if (!from) {
        const r = addPoint(s, pending.x, pending.y);
        s = r.sketch;
        from = r.ids[0];
      }
      const chainStart = pending.chainStart ?? from;
      const end = pointAt(s, x, y);
      if (end.id === from) return;
      s = end.sketch;
      const line = addLineBetween(s, from, end.id);
      s = line.sketch;
      // Auto horizontal / vertical when nearly axis-aligned.
      const m = entityMap(s);
      const a = pointOf(m, from), b = pointOf(m, end.id);
      const ang = Math.abs((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI);
      if (Math.min(ang, 180 - ang) < AXIS_SNAP_DEG) s = addConstraint(s, { kind: "horizontal", line: line.ids[0] }).sketch;
      else if (Math.abs(ang - 90) < AXIS_SNAP_DEG) s = addConstraint(s, { kind: "vertical", line: line.ids[0] }).sketch;
      if (apply(s, "line")) {
        const ep = pointOf(s, end.id);
        if (end.id === chainStart) setPending(null);
        else setPending({ tool: "line", from: end.id, x: ep.x, y: ep.y, chainStart });
      }
      return;
    }

    if (tool === "rect") {
      if (!pending || pending.tool !== "rect") {
        setPending({ tool: "rect", x: gridSnap(x), y: gridSnap(y) });
        return;
      }
      const x1 = gridSnap(x), y1 = gridSnap(y);
      if (Math.abs(x1 - pending.x) > 1e-6 && Math.abs(y1 - pending.y) > 1e-6) {
        const r = addRectangle(sketch, Math.min(pending.x, x1), Math.min(pending.y, y1), Math.max(pending.x, x1), Math.max(pending.y, y1));
        apply(r.sketch, "rectangle");
      }
      setPending(null);
      return;
    }

    if (tool === "arc") {
      const snap = snapPoint(x, y);
      const at = snap ? pointOf(sketch, snap) : refSnap(x, y) ?? { x: gridSnap(x), y: gridSnap(y) };
      if (!pending || pending.tool !== "arc") {
        setPending({ tool: "arc", start: snap, sx: at.x, sy: at.y });
        return;
      }
      if (!pending.end) {
        if (Math.hypot(at.x - pending.sx, at.y - pending.sy) < 1e-6) return;
        setPending({ ...pending, end: { id: snap, x: at.x, y: at.y } });
        return;
      }
      const r = addArcThrough(sketch, pending.start ?? { x: pending.sx, y: pending.sy }, pending.end.id ?? { x: pending.end.x, y: pending.end.y }, { x, y });
      if (r) apply(r.sketch, "arc");
      else setMessage("The three points are in line: move the cursor off the chord.");
      setPending(null);
      return;
    }

    if (tool === "fillet") {
      const corner = snapPoint(x, y);
      if (!corner) {
        setMessage("Fillet: click the corner point where two lines meet.");
        return;
      }
      let r: number;
      try {
        r = evalExpr(filletText.trim().replace(",", "."), scope);
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e));
        return;
      }
      const res = filletCorner(sketch, corner, r);
      if ("error" in res) setMessage(res.error);
      else if (apply(res.sketch, "fillet") && res.dropped) setMessage(`Rounded. ${res.dropped} constraint${res.dropped > 1 ? "s" : ""} on the old corner removed.`);
      setHover(null);
      return;
    }

    if (tool === "slot") {
      const snap = snapPoint(x, y);
      const at = snap ? pointOf(sketch, snap) : refSnap(x, y) ?? { x: gridSnap(x), y: gridSnap(y) };
      if (!pending || pending.tool !== "slot") {
        setPending({ tool: "slot", a: { id: snap, x: at.x, y: at.y } });
        return;
      }
      if (!pending.b) {
        if (Math.hypot(at.x - pending.a.x, at.y - pending.a.y) < 1e-6) return;
        setPending({ ...pending, b: { id: snap, x: at.x, y: at.y } });
        return;
      }
      const r = slotWidth(pending.a, pending.b, x, y);
      const res = addSlot(sketch, [pending.a.x, pending.a.y], [pending.b.x, pending.b.y], r);
      if (res) {
        // Centres snapped onto existing points stay joined to them.
        let next = res.sketch;
        const caps = res.ids.map((id) => next.entities.find((e) => e.id === id)).filter((e): e is SkArc => e?.kind === "arc");
        const [capB, capA] = caps;
        if (pending.a.id) next = addConstraint(next, { kind: "coincident", a: capA.center, b: pending.a.id }).sketch;
        if (pending.b.id) next = addConstraint(next, { kind: "coincident", a: capB.center, b: pending.b.id }).sketch;
        apply(next, "slot");
      }
      setPending(null);
      return;
    }

    if (tool === "project") {
      const c = nearestProjectable(x, y);
      if (c) apply(addProjected(sketch, [c]).sketch, "the projection");
      else setMessage("Click an edge of the model (dashed purple) to bring it into the sketch");
      return;
    }

    if (tool === "trim") {
      const h = hitTest(sketch, x, y, SNAP_PX / view.scale);
      if (!h || h.kind === "point") return;
      const r = trimCurve(sketch, h.id, x, y);
      if ("error" in r) setMessage(r.error);
      else apply(r.sketch, "trim");
      setHover(null);
      return;
    }

    if (tool === "tarc") {
      const snap = snapPoint(x, y);
      if (!pending || pending.tool !== "tarc") {
        const curve = snap ? curveEndingAt(sketch, snap) : null;
        if (!snap || !curve) {
          setMessage("Tangent arc: start from the end of a line or arc.");
          return;
        }
        setMessage(null);
        setPending({ tool: "tarc", curve, from: snap });
        return;
      }
      const at = refSnap(x, y) ?? { x: gridSnap(x), y: gridSnap(y) };
      const r = addTangentArc(sketch, pending.curve, pending.from, snap ?? at);
      if (!r) {
        setMessage("The end is straight ahead: a tangent arc needs to turn.");
        return;
      }
      if (apply(r.sketch, "tangent arc")) {
        // Keep going from the new arc's far end, unless the chain closed on an existing point.
        const arc = r.sketch.entities.find((e) => e.id === r.ids[0]) as SkArc;
        const far = arc.start === pending.from ? arc.end : arc.start;
        setPending(snap ? null : { tool: "tarc", curve: arc.id, from: far });
      }
      return;
    }

    if (tool === "ellipse") {
      if (!pending || pending.tool !== "ellipse") {
        const c = snapPoint(x, y);
        const p = c ? pointOf(sketch, c) : { x: gridSnap(x), y: gridSnap(y) };
        setPending({ tool: "ellipse", cx: p.x, cy: p.y, center: c });
        return;
      }
      if (!pending.major) {
        const mx = gridSnap(x), my = gridSnap(y);
        if (Math.hypot(mx - pending.cx, my - pending.cy) < 1e-6) return;
        setPending({ ...pending, major: { x: mx, y: my } });
        return;
      }
      const b = ellipseMinor(pending.cx, pending.cy, pending.major, x, y);
      const r = addEllipse(sketch, pending.cx, pending.cy, pending.major.x, pending.major.y, b);
      if (r) {
        let next = r.sketch;
        // Reuse a snapped center point.
        if (pending.center) {
          const e = next.entities.find((x) => x.id === r.ids[0]) as SkEllipse;
          next = addConstraint(next, { kind: "coincident", a: e.center, b: pending.center }).sketch;
        }
        apply(next, "ellipse");
      }
      setPending(null);
      return;
    }

    if (tool === "spline") {
      const snap = snapPoint(x, y);
      const at = snap ? pointOf(sketch, snap) : refSnap(x, y) ?? { x: gridSnap(x), y: gridSnap(y) };
      const placed = pending?.tool === "spline" ? pending.points : [];
      const last = placed[placed.length - 1];
      // Clicking the last point again (or double clicking) finishes; the first point closes it.
      if (last && Math.hypot(at.x - last.x, at.y - last.y) * view.scale < 4) {
        finishSpline(placed, false);
        return;
      }
      if (placed.length >= 3 && Math.hypot(at.x - placed[0].x, at.y - placed[0].y) * view.scale < SNAP_PX) {
        finishSpline(placed, true);
        return;
      }
      setPending({ tool: "spline", points: [...placed, { id: snap, x: at.x, y: at.y }] });
      return;
    }

    if (tool === "circle") {
      if (!pending || pending.tool !== "circle") {
        const c = snapPoint(x, y);
        const p = c ? pointOf(sketch, c) : { x: gridSnap(x), y: gridSnap(y) };
        setPending({ tool: "circle", center: c, x: p.x, y: p.y });
        return;
      }
      const r = Math.hypot(x - pending.x, y - pending.y);
      if (r > 1e-3) {
        let s = sketch;
        let added;
        if (pending.center) {
          const id = skId("k");
          s = { ...s, entities: [...s.entities, { id, kind: "circle", center: pending.center, radius: r } as SkCircle] };
          added = s;
        } else {
          added = addCircle(s, pending.x, pending.y, r).sketch;
        }
        apply(added, "circle");
      }
      setPending(null);
    }
  };

  const onPointerMove = (ev: RPointerEvent) => {
    const w = eventWorld(ev);
    setCursor(w);
    if (pan.current) {
      const p = pan.current;
      setView((v) => ({ ...v, cx: p.cx - (ev.clientX - p.x) / v.scale, cy: p.cy + (ev.clientY - p.y) / v.scale }));
      return;
    }
    const g = imgDrag.current;
    if (g) {
      if (!g.moved && Math.hypot(w.x - g.sx, w.y - g.sy) * view.scale < 3) return;
      g.moved = true;
      setImages((list) => list.map((im) => (im.id === g.id ? { ...im, x: g.x0 + w.x - g.sx, y: g.y0 + w.y - g.sy } : im)));
      return;
    }
    const d = drag.current;
    if (d) {
      const dx = w.x - d.startX, dy = w.y - d.startY;
      if (!d.moved && Math.hypot(dx, dy) * view.scale < 3) return;
      d.moved = true;
      const targets: DragTarget[] = d.points.map((p) => ({ point: p.id, x: p.x0 + dx, y: p.y0 + dy }));
      const r = solve(d.base, targets);
      if (r.ok) setSketch(r.sketch);
      return;
    }
    setHover(hitTest(sketch, w.x, w.y, SNAP_PX / view.scale));
  };

  const onPointerUp = () => {
    pan.current = null;
    const g = imgDrag.current;
    imgDrag.current = null;
    if (g?.moved) onImages?.(images);
    const d = drag.current;
    drag.current = null;
    if (d?.moved) {
      // Settle without the temporary drag constraints, then commit.
      if (!apply(sketch, "drag")) setSketch(d.base);
    }
  };

  const onWheel = (ev: RWheelEvent) => {
    const before = eventWorld(ev);
    const factor = Math.exp(-ev.deltaY * 0.0015);
    setView((v) => {
      const scale = Math.min(200, Math.max(0.2, v.scale * factor));
      // Keep the point under the cursor fixed.
      return { scale, cx: before.x - (before.x - v.cx) * (v.scale / scale), cy: before.y - (before.y - v.cy) * (v.scale / scale) };
    });
  };

  // ---- commands --------------------------------------------------------------

  const deleteSelection = useCallback(() => {
    if (!selection.size) return;
    const constraintIds = sketch.constraints.filter((c) => selection.has(c.id)).map((c) => c.id);
    let s = removeConstraints(sketch, constraintIds);
    s = removeEntities(s, [...selection].filter((id) => !constraintIds.includes(id)));
    setSelection(new Set());
    apply(s, "delete");
  }, [selection, sketch, apply]);

  const addConstraints = (cs: NewConstraint[], label: string) => {
    let s = sketch;
    for (const c of cs) s = addConstraint(s, c).sketch;
    if (apply(s, label)) setSelection(new Set());
  };

  const actions = useMemo(() => constraintActions(sketch, selection), [sketch, selection]);
  const dimension = useMemo(() => dimensionFor(sketch, selection), [sketch, selection]);

  const addDimension = () => {
    if (!dimension) return;
    const r = addConstraint(sketch, dimension);
    if (apply(r.sketch, "dimension")) {
      setSelection(new Set());
      const id = r.ids[0];
      // Open the inline editor on the new dimension.
      requestAnimationFrame(() => startEdit(id));
    }
  };

  /** Copies the selected curves in a row or around the selected point (the origin when none is selected). */
  const applyPattern = () => {
    if (!patternForm) return;
    const num = (t: string) => {
      const v = t.trim().replace(",", ".");
      return isPlainNumber(v) ? Number(v) : evalExpr(v, scope);
    };
    let count: number, place: (x: number, y: number, k: number) => Pt;
    try {
      count = Math.round(num(patternForm.count));
      if (!(count >= 2 && count <= 100)) throw new Error("Count must be 2–100");
      if (patternForm.mode === "linear") place = linearPlace(num(patternForm.dx), num(patternForm.dy));
      else {
        const centre = [...selection].map((id) => m.get(id)).find((e) => e?.kind === "point");
        const c = centre?.kind === "point" ? centre : { x: 0, y: 0 };
        place = circularPlace(c.x, c.y, count, num(patternForm.angle));
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    const curves = [...selection].filter((id) => ["line", "circle", "arc", "ellipse", "spline"].includes(m.get(id)?.kind ?? ""));
    const r = patternCurves(sketch, curves, count, place);
    if (apply(r.sketch, "pattern")) {
      setPatternForm(null);
      setSelection(new Set(r.ids));
    }
  };

  /** Starting values for a linear pattern: copies side by side, a little apart. */
  const openPattern = () => {
    const curves = [...selection].filter((id) => m.get(id)?.kind !== "point");
    const pts = curves.flatMap((id) => {
      const e = m.get(id);
      if (!e || e.kind === "point") return [];
      const r = e.kind === "circle" || e.kind === "arc" ? e.radius : 0;
      return curvePoints(e).flatMap((p) => [{ x: pointOf(m, p).x - r }, { x: pointOf(m, p).x + r }]);
    });
    const xs = pts.map((p) => p.x);
    const w = pts.length ? Math.max(...xs) - Math.min(...xs) : 10;
    setPatternForm({ mode: "linear", count: "3", dx: fmt(Math.max(5, w + 5)), dy: "0", angle: "360" });
  };

  const applyOffset = () => {
    if (offsetText == null) return;
    const src = offsetText.trim().replace(",", ".");
    setOffsetText(null);
    let d: number;
    try {
      d = evalExpr(src, scope);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    const r = offsetCurves(sketch, selection, d);
    if ("error" in r) setMessage(r.error);
    else if (apply(r.sketch, "offset")) setSelection(new Set(r.ids));
  };

  const toggleConstruction = () => {
    const entities = sketch.entities.map((e) => (e.kind !== "point" && selection.has(e.id) ? { ...e, construction: !e.construction } : e));
    apply({ ...sketch, entities }, "construction");
  };

  const dimLabelPos = useRef(new Map<string, [number, number]>());
  const startEdit = (id: string) => {
    const c = sketch.constraints.find((x) => x.id === id) ?? null;
    const pos = dimLabelPos.current.get(id);
    if (!pos) return;
    const text = c && isDimension(c) ? (c.expr ?? fmt(c.value)) : "0";
    setEdit({ id, sx: pos[0], sy: pos[1], text });
  };

  const commitEdit = () => {
    if (!edit) return;
    const src = edit.text.trim().replace(",", ".");
    setEdit(null);
    let v: number;
    try {
      v = evalExpr(src, scope);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      return;
    }
    if (v <= 0) {
      setMessage("Dimensions must be positive.");
      return;
    }
    const expr = isPlainNumber(src) ? undefined : src;
    const constraints = sketch.constraints.map((c) => (c.id === edit.id && isDimension(c) ? { ...c, value: v, expr } : c));
    apply({ ...sketch, constraints }, "dimension");
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (edit || (e.target as HTMLElement).tagName === "INPUT") return;
      if (e.metaKey || e.ctrlKey) return;
      const k = e.key.toLowerCase();
      if ((k === "escape" || k === "enter") && pending?.tool === "spline") {
        finishSpline(pending.points, false);
        return;
      }
      if (k === "escape" && calib) {
        setCalib(null);
        return;
      }
      if ((k === "delete" || k === "backspace") && imageSel && !selection.size) {
        e.preventDefault();
        commitImages(images.filter((im) => im.id !== imageSel));
        setImageSel(null);
        return;
      }
      if (k === "escape") {
        if (pending) cancelPending();
        else if (imageSel) setImageSel(null);
        else if (selection.size) setSelection(new Set());
        else if (tool !== "select") setTool("select");
        else onExit();
        return;
      }
      if (k === "delete" || k === "backspace") {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (k === "d" && dimension) {
        addDimension();
        return;
      }
      if (k === "x" && selection.size) {
        toggleConstruction();
        return;
      }
      const act = actions.find((a) => a.shortcut === k);
      if (act) {
        addConstraints(act.build(), act.label);
        return;
      }
      if (TOOL_KEYS[k]) {
        setTool(TOOL_KEYS[k]);
        setPending(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---- rendering -------------------------------------------------------------

  const m = entityMap(sketch);
  const conflicting = new Set(status?.conflicting ?? []);
  const cls = (id: string, base: string) =>
    [base, selection.has(id) && "sel", hover?.id === id && "hover", conflicting.has(id) && "conflict"].filter(Boolean).join(" ");

  const grid = useMemo(() => {
    const step = view.scale > 20 ? 1 : view.scale > 4 ? 10 : 50;
    const tl = toWorld(0, 0), br = toWorld(size.w, size.h);
    const lines: ReactElement[] = [];
    for (let x = Math.ceil(tl.x / step) * step; x <= br.x; x += step) {
      const [sx] = toScreen(x, 0);
      lines.push(<line key={`gx${x}`} x1={sx} y1={0} x2={sx} y2={size.h} className={Math.abs(x) < 1e-9 ? "axis-y" : "grid"} />);
    }
    for (let y = Math.ceil(br.y / step) * step; y <= tl.y; y += step) {
      const [, sy] = toScreen(0, y);
      lines.push(<line key={`gy${y}`} x1={0} y1={sy} x2={size.w} y2={sy} className={Math.abs(y) < 1e-9 ? "axis-x" : "grid"} />);
    }
    return lines;
  }, [view, size, toScreen, toWorld]);

  // Glyph and dimension placement.
  const glyphs: ReactElement[] = [];
  const dims: ReactElement[] = [];
  const perLine = new Map<string, number>();
  dimLabelPos.current = new Map();

  /** SVG path for a counter-clockwise arc (screen y is flipped, so the sweep flag is 0). */
  function arcPath(a: SkArc): string {
    const c = pointOf(m, a.center), s0 = pointOf(m, a.start), s1 = pointOf(m, a.end);
    const r = Math.hypot(s0.x - c.x, s0.y - c.y);
    let span = Math.atan2(s1.y - c.y, s1.x - c.x) - Math.atan2(s0.y - c.y, s0.x - c.x);
    if (span <= 0) span += Math.PI * 2;
    const [x0, y0] = toScreen(s0.x, s0.y), [x1, y1] = toScreen(s1.x, s1.y);
    const R = r * view.scale;
    return `M ${x0} ${y0} A ${R} ${R} 0 ${span > Math.PI ? 1 : 0} 0 ${x1} ${y1}`;
  }

  /** SVG path of an ellipse or spline (Béziers map exactly under the screen transform). */
  function curvePath(e: Extract<SkCurve, { kind: "ellipse" | "spline" }>, mm = m): string {
    if (e.kind === "ellipse") {
      const g = ellipseGeom(mm, e);
      return ellipseSvg(g.cx, g.cy, g.a, g.b, g.angle);
    }
    return splineSvg(splinePoints(mm, e), !!e.closed);
  }
  const ellipseSvg = (cx: number, cy: number, a: number, b: number, angle: number) => {
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const [x0, y0] = toScreen(cx + a * ca, cy + a * sa), [x1, y1] = toScreen(cx - a * ca, cy - a * sa);
    const A = a * view.scale, B = b * view.scale, deg = (-angle * 180) / Math.PI;
    return `M ${x0} ${y0} A ${A} ${B} ${deg} 1 0 ${x1} ${y1} A ${A} ${B} ${deg} 1 0 ${x0} ${y0} Z`;
  };
  const splineSvg = (pts: Pt[], closed: boolean) => {
    if (pts.length < 2) return "";
    const sc = (p: Pt) => toScreen(p[0], p[1]).join(" ");
    return `M ${sc(pts[0])} ` + splineBeziers(pts, closed).map((b) => `C ${sc(b.c1)} ${sc(b.c2)} ${sc(b.to)}`).join(" ") + (closed ? " Z" : "");
  };

  // Annotations go on the outer side of each line, away from the sketch's center.
  const bb = bounds(sketch);
  const [ocx, ocy] = bb ? toScreen((bb.minX + bb.maxX) / 2, (bb.minY + bb.maxY) / 2) : [size.w / 2, size.h / 2];
  const lineFrame = (l: SkLine) => {
    const a = pointOf(m, l.p1), b = pointOf(m, l.p2);
    const [ax, ay] = toScreen(a.x, a.y), [bx, by] = toScreen(b.x, b.y);
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    let nx = -(by - ay) / len, ny = (bx - ax) / len;
    if ((mx - ocx) * nx + (my - ocy) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { mx, my, nx, ny };
  };

  const glyphAtLine = (c: SkConstraint, lineId: string, text: string) => {
    const l = m.get(lineId) as SkLine | undefined;
    if (!l) return;
    const k = perLine.get(lineId) ?? 0;
    perLine.set(lineId, k + 1);
    const f = lineFrame(l);
    // Stack multiple glyphs along the line direction.
    const gx = f.mx + f.nx * 14 + f.ny * k * 18;
    const gy = f.my + f.ny * 14 - f.nx * k * 18;
    glyphs.push(<Glyph key={`${c.id}-${lineId}`} id={c.id} x={gx} y={gy} text={text} cls={cls(c.id, "glyph")} onSelect={selectConstraint} />);
  };

  const glyphAtPoint = (c: SkConstraint, pointId: string, text: string) => {
    const p = m.get(pointId);
    if (!p || p.kind !== "point") return;
    const [sx, sy] = toScreen(p.x, p.y);
    glyphs.push(<Glyph key={`${c.id}-${pointId}`} id={c.id} x={sx + 12} y={sy - 12} text={text} cls={cls(c.id, "glyph")} onSelect={selectConstraint} />);
  };

  function selectConstraint(id: string, additive: boolean) {
    setSelection((sel) => {
      const n = new Set(additive ? sel : []);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }

  for (const c of sketch.constraints) {
    const g = CONSTRAINT_GLYPH[c.kind];
    switch (c.kind) {
      case "horizontal":
      case "vertical":
        glyphAtLine(c, c.line, g);
        break;
      case "parallel":
      case "perpendicular":
        glyphAtLine(c, c.a, g);
        glyphAtLine(c, c.b, g);
        break;
      case "equal":
        if (m.get(c.a)?.kind === "line") {
          glyphAtLine(c, c.a, g);
          glyphAtLine(c, c.b, g);
        } else {
          for (const id of [c.a, c.b]) {
            const k = m.get(id) as SkCircle;
            const ctr = pointOf(m, k.center);
            const [sx, sy] = toScreen(ctr.x, ctr.y - k.radius);
            glyphs.push(<Glyph key={`${c.id}-${id}`} id={c.id} x={sx} y={sy + 14} text={g} cls={cls(c.id, "glyph")} onSelect={selectConstraint} />);
          }
        }
        break;
      case "tangent":
        glyphAtLine(c, c.line, g);
        break;
      case "coincident":
      case "fixed":
        glyphAtPoint(c, c.kind === "fixed" ? c.point : c.a, g);
        break;
      case "pointOnLine":
      case "pointOnCircle":
      case "midpoint":
      case "tangentAt":
        glyphAtPoint(c, c.point, g);
        break;
      case "symmetric":
        glyphAtPoint(c, c.a, g);
        glyphAtPoint(c, c.b, g);
        break;
      case "length":
      case "distance":
      case "radius":
      case "pointLine":
      case "angle": {
        let sx = 0, sy = 0, text = c.expr ? `ƒ ${fmt(c.value)}` : fmt(c.value);
        let leader: ReactElement | null = null;
        if (c.kind === "length" || c.kind === "angle") {
          const l = m.get(c.kind === "length" ? c.line : c.b) as SkLine | undefined;
          if (!l) break;
          const f = lineFrame(l);
          sx = f.mx + f.nx * 38;
          sy = f.my + f.ny * 38;
          if (c.kind === "angle") text = `${text}°`;
        } else if (c.kind === "pointLine") {
          // From the point square onto the line (extended as needed).
          const l = m.get(c.line) as SkLine | undefined;
          if (!l) break;
          const p = pointOf(m, c.point), a = pointOf(m, l.p1), b = pointOf(m, l.p2);
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
          const t = (p.x - a.x) * ux + (p.y - a.y) * uy;
          const [px, py] = toScreen(p.x, p.y), [fx, fy] = toScreen(a.x + ux * t, a.y + uy * t);
          sx = (px + fx) / 2 + 12;
          sy = (py + fy) / 2 - 12;
          const [ex1, ey1] = toScreen(a.x + ux * Math.min(0, t), a.y + uy * Math.min(0, t)), [ex2, ey2] = toScreen(a.x + ux * Math.max(len, t), a.y + uy * Math.max(len, t));
          leader = (
            <>
              <line x1={px} y1={py} x2={fx} y2={fy} className="dim-line" />
              {(t < 0 || t > len) && <line x1={ex1} y1={ey1} x2={ex2} y2={ey2} className="dim-line extension" />}
            </>
          );
        } else if (c.kind === "distance") {
          const a = pointOf(m, c.a), b = pointOf(m, c.b);
          const [ax, ay] = toScreen(a.x, a.y), [bx, by] = toScreen(b.x, b.y);
          sx = (ax + bx) / 2;
          sy = (ay + by) / 2 - 14;
          leader = <line x1={ax} y1={ay} x2={bx} y2={by} className="dim-line" />;
        } else {
          const k = m.get(c.circle) as SkCircle | SkArc | undefined;
          if (!k) break;
          const ctr = pointOf(m, k.center);
          const [cx, cy] = toScreen(ctr.x, ctr.y);
          const onCurve = k.kind === "arc" ? arcMidpoint(m, k) : ([ctr.x + k.radius * Math.SQRT1_2, ctr.y + k.radius * Math.SQRT1_2] as const);
          const [ex, ey] = toScreen(onCurve[0], onCurve[1]);
          sx = ex + 14;
          sy = ey - 10;
          text = `R${text}`;
          leader = <line x1={cx} y1={cy} x2={ex} y2={ey} className="dim-line" />;
        }
        dimLabelPos.current.set(c.id, [sx, sy]);
        dims.push(
          <g key={c.id}>
            {leader}
            <g
              className={cls(c.id, c.expr ? "dim has-expr" : "dim")}
              transform={`translate(${sx},${sy})`}
              onPointerDown={(e) => {
                e.stopPropagation();
                selectConstraint(c.id, e.shiftKey || e.metaKey);
              }}
              onDoubleClick={(e) => {
                e.stopPropagation();
                startEdit(c.id);
              }}
            >
              <rect x={-text.length * 4 - 5} y={-10} width={text.length * 8 + 10} height={20} rx={4} />
              <text textAnchor="middle" dominantBaseline="central">
                {text}
              </text>
            </g>
          </g>,
        );
        break;
      }
    }
  }

  // Preview of the tool in progress.
  let preview: ReactElement | null = null;
  if (tool === "project") {
    const hot = cursor ? nearestProjectable(cursor.x, cursor.y) : null;
    preview = (
      <g>
        {projectable.map((c, i) => (
          <polyline key={`pj${i}`} points={projectedPoints(c)} className={`projectable${c === hot ? " hot" : ""}`} />
        ))}
      </g>
    );
  }
  if (tool === "trim" && hover && hover.kind !== "point" && cursor) {
    const r = trimCurve(sketch, hover.id, cursor.x, cursor.y);
    if (!("error" in r) && r.removed.length > 1) {
      preview = <polyline points={r.removed.map(([px, py]) => toScreen(px, py).join(",")).join(" ")} className="trim-preview" />;
    }
  }
  if (pending && cursor) {
    if (pending.tool === "line") {
      const a = { x: pending.x, y: pending.y };
      const [ax, ay] = toScreen(a.x, a.y);
      const snap = snapPoint(cursor.x, cursor.y);
      const b = snap ? pointOf(m, snap) : { x: gridSnap(cursor.x), y: gridSnap(cursor.y) };
      const [bx, by] = toScreen(b.x, b.y);
      preview = (
        <g>
          <line x1={ax} y1={ay} x2={bx} y2={by} className="preview" />
          <text x={bx + 10} y={by - 10} className="preview-label">
            {fmt(Math.hypot(b.x - a.x, b.y - a.y))}
          </text>
        </g>
      );
    } else if (pending.tool === "rect") {
      const [ax, ay] = toScreen(pending.x, pending.y);
      const [bx, by] = toScreen(gridSnap(cursor.x), gridSnap(cursor.y));
      preview = (
        <g>
          <rect x={Math.min(ax, bx)} y={Math.min(ay, by)} width={Math.abs(bx - ax)} height={Math.abs(by - ay)} className="preview" />
          <text x={bx + 10} y={by - 10} className="preview-label">
            {fmt(Math.abs(gridSnap(cursor.x) - pending.x))} × {fmt(Math.abs(gridSnap(cursor.y) - pending.y))}
          </text>
        </g>
      );
    } else if (pending.tool === "arc") {
      const [ax, ay] = toScreen(pending.sx, pending.sy);
      if (!pending.end) {
        const [bx, by] = toScreen(gridSnap(cursor.x), gridSnap(cursor.y));
        preview = <line x1={ax} y1={ay} x2={bx} y2={by} className="preview" />;
      } else {
        const r = addArcThrough(sketch, { x: pending.sx, y: pending.sy }, { x: pending.end.x, y: pending.end.y }, cursor);
        const arc = r?.sketch.entities.find((e) => e.id === r.ids[0]) as SkArc | undefined;
        if (r && arc) {
          const mm = entityMap(r.sketch);
          const c = pointOf(mm, arc.center), s0 = pointOf(mm, arc.start), s1 = pointOf(mm, arc.end);
          let span = Math.atan2(s1.y - c.y, s1.x - c.x) - Math.atan2(s0.y - c.y, s0.x - c.x);
          if (span <= 0) span += Math.PI * 2;
          const [x0, y0] = toScreen(s0.x, s0.y), [x1, y1] = toScreen(s1.x, s1.y);
          const R = arc.radius * view.scale;
          preview = (
            <g>
              <path d={`M ${x0} ${y0} A ${R} ${R} 0 ${span > Math.PI ? 1 : 0} 0 ${x1} ${y1}`} className="preview" />
              <text x={toScreen(cursor.x, cursor.y)[0] + 10} y={toScreen(cursor.x, cursor.y)[1] - 10} className="preview-label">
                R{fmt(arc.radius)}
              </text>
            </g>
          );
        }
      }
    } else if (pending.tool === "tarc") {
      const from = pointOf(m, pending.from);
      const dir = exitDirection(sketch, pending.curve, pending.from);
      const snap = snapPoint(cursor.x, cursor.y);
      const end = snap ? pointOf(m, snap) : { x: gridSnap(cursor.x), y: gridSnap(cursor.y) };
      const g = dir && tangentArcGeom(from, dir, end);
      const [ex, ey] = toScreen(end.x, end.y);
      if (g) {
        const [x0, y0] = toScreen(from.x, from.y);
        // Sweep from `from` to `end` turning the way the tangent goes.
        const a0 = Math.atan2(from.y - g.cy, from.x - g.cx), a1 = Math.atan2(end.y - g.cy, end.x - g.cx);
        let span = g.ccw ? a1 - a0 : a0 - a1;
        span = ((span % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const R = g.radius * view.scale;
        preview = (
          <g>
            <path d={`M ${x0} ${y0} A ${R} ${R} 0 ${span > Math.PI ? 1 : 0} ${g.ccw ? 0 : 1} ${ex} ${ey}`} className="preview" />
            <text x={ex + 10} y={ey - 10} className="preview-label">
              R{fmt(g.radius)}
            </text>
          </g>
        );
      }
    } else if (pending.tool === "ellipse") {
      const [cx, cy] = toScreen(pending.cx, pending.cy);
      if (!pending.major) {
        const [bx, by] = toScreen(gridSnap(cursor.x), gridSnap(cursor.y));
        preview = (
          <g>
            <line x1={cx} y1={cy} x2={bx} y2={by} className="preview" />
            <text x={bx + 10} y={by - 10} className="preview-label">
              {fmt(Math.hypot(gridSnap(cursor.x) - pending.cx, gridSnap(cursor.y) - pending.cy))}
            </text>
          </g>
        );
      } else {
        const a = Math.hypot(pending.major.x - pending.cx, pending.major.y - pending.cy);
        const b = ellipseMinor(pending.cx, pending.cy, pending.major, cursor.x, cursor.y);
        const angle = Math.atan2(pending.major.y - pending.cy, pending.major.x - pending.cx);
        const [qx, qy] = toScreen(cursor.x, cursor.y);
        preview =
          b > 1e-6 ? (
            <g>
              <path d={ellipseSvg(pending.cx, pending.cy, a, b, angle)} className="preview" />
              <text x={qx + 10} y={qy - 10} className="preview-label">
                {fmt(a)} × {fmt(b)}
              </text>
            </g>
          ) : null;
      }
    } else if (pending.tool === "spline") {
      const snap = snapPoint(cursor.x, cursor.y);
      const c = snap ? pointOf(m, snap) : { x: gridSnap(cursor.x), y: gridSnap(cursor.y) };
      const pts: Pt[] = [...pending.points.map((p) => [p.x, p.y] as Pt), [c.x, c.y]];
      preview = (
        <g>
          <path d={splineSvg(pts, false)} className="preview" />
          {pending.points.map((p, i) => {
            const [px, py] = toScreen(p.x, p.y);
            return <circle key={i} cx={px} cy={py} r={3.5} className="pt" />;
          })}
        </g>
      );
    } else if (pending.tool === "slot") {
      const [ax, ay] = toScreen(pending.a.x, pending.a.y);
      if (!pending.b) {
        const snap = snapPoint(cursor.x, cursor.y);
        const b = snap ? pointOf(m, snap) : { x: gridSnap(cursor.x), y: gridSnap(cursor.y) };
        const [bx, by] = toScreen(b.x, b.y);
        preview = (
          <g>
            <line x1={ax} y1={ay} x2={bx} y2={by} className="preview" />
            <text x={bx + 10} y={by - 10} className="preview-label">
              {fmt(Math.hypot(b.x - pending.a.x, b.y - pending.a.y))}
            </text>
          </g>
        );
      } else {
        const r = slotWidth(pending.a, pending.b, cursor.x, cursor.y);
        const { a, b } = pending;
        const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const nx = (-(b.y - a.y) / len) * r, ny = ((b.x - a.x) / len) * r;
        const P = (x: number, y: number) => toScreen(x, y).join(" ");
        const R = r * view.scale;
        const [qx, qy] = toScreen(cursor.x, cursor.y);
        preview =
          r > 1e-6 ? (
            <g>
              <path
                d={`M ${P(a.x - nx, a.y - ny)} L ${P(b.x - nx, b.y - ny)} A ${R} ${R} 0 0 0 ${P(b.x + nx, b.y + ny)} L ${P(a.x + nx, a.y + ny)} A ${R} ${R} 0 0 0 ${P(a.x - nx, a.y - ny)} Z`}
                className="preview"
              />
              <text x={qx + 10} y={qy - 10} className="preview-label">
                {fmt(len)} × {fmt(2 * r)}
              </text>
            </g>
          ) : null;
      }
    } else if (pending.tool === "circle") {
      const [cx, cy] = toScreen(pending.x, pending.y);
      const r = Math.hypot(cursor.x - pending.x, cursor.y - pending.y);
      preview = (
        <g>
          <circle cx={cx} cy={cy} r={r * view.scale} className="preview" />
          <text x={cx + r * view.scale + 8} y={cy} className="preview-label">
            R{fmt(r)}
          </text>
        </g>
      );
    }
  }

  const dofText = !status
    ? ""
    : sketch.entities.length === 0
      ? "Empty sketch: pick a tool to start drawing"
      : !status.ok
        ? "Solver failed"
        : status.dof === 0
          ? "Fully constrained"
          : `${status.dof} DOF remaining`;

  return (
    <div className="sketch-editor">
      <div className="sketch-bar">
        <strong>{feature.name}</strong>
        <span className="muted">
          {feature.face ? "on face" : `${feature.plane} plane`}
          {feature.offset ? ` @ ${feature.offset}` : ""}
        </span>
        <div className="group">
          {(
            [
              ["select", "↖ Select", "S"],
              ["line", "╱ Line", "L"],
              ["rect", "▭ Rectangle", "R"],
              ["circle", "◯ Circle", "C"],
              ["arc", "◠ Arc", "A"],
              ["tarc", "◡ Tangent arc", "G"],
              ["ellipse", "⬭ Ellipse", "O"],
              ["spline", "∿ Spline", "P"],
              ["slot", "⊂⊃ Slot", "B"],
              ["fillet", "◜ Fillet", "U"],
              ["trim", "✂ Trim", "K"],
              ["project", "⤓ Project", "J"],
            ] as const
          ).map(([t, label, key]) => (
            <button key={t} className={tool === t ? "active" : ""} title={`${label} (${key})`} onClick={() => (setTool(t), setPending(null))}>
              {label}
            </button>
          ))}
        </div>
        <div className="group">
          <button title="Add a picture to trace over (it stays under the sketch and never becomes geometry)" onClick={() => fileInput.current?.click()}>
            🖼 Image
          </button>
          <button title="Add the curves of a DXF file (lines, arcs, circles, polylines, ellipses, splines), at their coordinates" onClick={() => dxfInput.current?.click()}>
            ⤓ DXF
          </button>
          <input
            ref={dxfInput}
            type="file"
            accept=".dxf"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importDXF(f);
            }}
          />
          <button
            title="Save the sketch as DXF (R12, mm): for laser cutters, CNC and other CAD programs"
            disabled={!sketch.entities.some((x) => x.kind !== "point")}
            onClick={exportDXF}
          >
            ⤒ DXF
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void importImage(f);
            }}
          />
          {imageSel && !calib && (
            <>
              <label className="offset-field" title="Opacity of the picture">
                Opacity
                <input
                  type="range"
                  min={0.1}
                  max={1}
                  step={0.05}
                  value={images.find((im) => im.id === imageSel)?.opacity ?? 0.6}
                  onChange={(e) => setImages(images.map((im) => (im.id === imageSel ? { ...im, opacity: Number(e.target.value) } : im)))}
                  onPointerUp={() => onImages?.(images)}
                  onKeyUp={() => onImages?.(images)}
                  aria-label="Image opacity"
                />
              </label>
              <button title="Set the real size: click two points on the picture, then type how far apart they are" onClick={() => setCalib({ id: imageSel, pts: [], text: "" })}>
                📏 Scale
              </button>
              <button
                title="Remove the picture (⌫)"
                onClick={() => {
                  commitImages(images.filter((im) => im.id !== imageSel));
                  setImageSel(null);
                }}
              >
                ✕ Image
              </button>
            </>
          )}
          {calib && calib.pts.length < 2 && <span className="muted">Click {calib.pts.length ? "the second" : "the first"} of two points a known distance apart (Esc cancels)</span>}
          {calib && calib.pts.length === 2 && (
            <label className="offset-field" title="Real distance between the two points (mm)">
              Distance
              <input
                autoFocus
                value={calib.text}
                placeholder="mm"
                onChange={(e) => setCalib({ ...calib, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyCalibration();
                  if (e.key === "Escape") setCalib(null);
                }}
                aria-label="Real distance"
              />
              <button onClick={applyCalibration}>✓</button>
            </label>
          )}
        </div>
        {tool === "fillet" && (
          <label className="offset-field" title="Radius of the rounded corner (mm). Click a corner where two lines meet">
            Radius
            <input value={filletText} onChange={(e) => setFilletText(e.target.value)} onFocus={(e) => e.target.select()} aria-label="Fillet radius" />
          </label>
        )}
        {tool === "project" && (
          <div className="group">
            <button
              disabled={!projectable.length}
              title="Bring every edge of the model, seen through this plane, into the sketch"
              onClick={() => apply(addProjected(sketch, projectable).sketch, "the projection")}
            >
              ⤓ Project all ({projectable.length})
            </button>
          </div>
        )}
        <div className="group">
          {actions.map((a) => (
            <button key={a.key} title={a.shortcut ? `${a.label} (${a.shortcut.toUpperCase()})` : a.label} onClick={() => addConstraints(a.build(), a.label)}>
              <span className="glyph-icon">{a.glyph}</span> {a.label}
            </button>
          ))}
          {dimension && (
            <button title="Dimension (D)" onClick={addDimension}>
              ↔ Dimension
            </button>
          )}
          {[...selection].some((id) => ["line", "circle", "arc", "ellipse", "spline"].includes(m.get(id)?.kind ?? "")) && (
            <button title="Construction (X)" onClick={toggleConstruction}>
              ┄ Construction
            </button>
          )}
          {[...selection].some((id) => ["line", "circle", "arc"].includes(m.get(id)?.kind ?? "")) &&
            (offsetText == null ? (
              <button title="Offset the selected curves" onClick={() => setOffsetText("5")}>
                ⇉ Offset
              </button>
            ) : (
              <label className="offset-field" title="Positive grows closed shapes, negative shrinks them">
                Offset
                <input
                  autoFocus
                  value={offsetText}
                  onChange={(e) => setOffsetText(e.target.value)}
                  onFocus={(e) => e.target.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyOffset();
                    if (e.key === "Escape") setOffsetText(null);
                  }}
                />
                <button onClick={applyOffset}>✓</button>
              </label>
            ))}
          {[...selection].some((id) => ["line", "circle", "arc", "ellipse", "spline"].includes(m.get(id)?.kind ?? "")) &&
            (patternForm == null ? (
              <button title="Copies of the selected curves in a row, or around the selected point" onClick={openPattern}>
                ⁙ Pattern
              </button>
            ) : (
              <span
                className="offset-field pattern-field"
                onKeyDown={(e) => {
                  if (e.key === "Enter") applyPattern();
                  if (e.key === "Escape") setPatternForm(null);
                }}
              >
                <select value={patternForm.mode} onChange={(e) => setPatternForm({ ...patternForm, mode: e.target.value as "linear" | "circular" })} aria-label="Pattern type">
                  <option value="linear">Linear</option>
                  <option value="circular">Circular</option>
                </select>
                <label title="Total number, the originals included">
                  ×<input autoFocus value={patternForm.count} onChange={(e) => setPatternForm({ ...patternForm, count: e.target.value })} aria-label="Count" />
                </label>
                {patternForm.mode === "linear" ? (
                  <>
                    <label title="Step along X between copies (mm)">
                      X<input value={patternForm.dx} onChange={(e) => setPatternForm({ ...patternForm, dx: e.target.value })} aria-label="Step X" />
                    </label>
                    <label title="Step along Y between copies (mm)">
                      Y<input value={patternForm.dy} onChange={(e) => setPatternForm({ ...patternForm, dy: e.target.value })} aria-label="Step Y" />
                    </label>
                  </>
                ) : (
                  <label title="Total angle; 360 spaces the copies evenly all round. Centre: the selected point, or the origin">
                    ∠<input value={patternForm.angle} onChange={(e) => setPatternForm({ ...patternForm, angle: e.target.value })} aria-label="Angle" />°
                  </label>
                )}
                <button onClick={applyPattern}>✓</button>
              </span>
            ))}
          {selection.size > 0 && (
            <button title="Delete (⌫)" onClick={deleteSelection}>
              ✕ Delete
            </button>
          )}
        </div>
        <button className="primary right" onClick={onExit}>
          ✓ Finish sketch
        </button>
      </div>

      <svg
        ref={svgRef}
        className={`sketch-canvas tool-${tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHover(null)}
        onWheel={onWheel}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={() => {
          if (pending?.tool === "line") setPending(null);
        }}
      >
        {grid}
        {images.map((im) => {
          const [x0, y0] = toScreen(im.x - im.width / 2, im.y + im.height / 2);
          const w = im.width * view.scale, h = im.height * view.scale;
          return (
            <g key={im.id}>
              <image href={im.src} x={x0} y={y0} width={w} height={h} opacity={im.opacity} preserveAspectRatio="none" />
              {imageSel === im.id && <rect x={x0} y={y0} width={w} height={h} className="image-sel" />}
            </g>
          );
        })}
        {calib &&
          (() => {
            const pts = calib.pts.length < 2 && cursor ? [...calib.pts, cursor] : calib.pts;
            const sc = pts.map((p) => toScreen(p.x, p.y));
            return (
              <g>
                {sc.length === 2 && <line x1={sc[0][0]} y1={sc[0][1]} x2={sc[1][0]} y2={sc[1][1]} className="calib-line" />}
                {sc.map(([px, py], i) => (
                  <circle key={i} cx={px} cy={py} r={4} className="calib-pt" />
                ))}
              </g>
            );
          })()}
        {reference &&
          Array.from({ length: reference.length / 4 }, (_, i) => {
            const [ax, ay] = toScreen(reference[i * 4], reference[i * 4 + 1]);
            const [bx, by] = toScreen(reference[i * 4 + 2], reference[i * 4 + 3]);
            return <line key={`ref${i}`} x1={ax} y1={ay} x2={bx} y2={by} className="reference" />;
          })}
        {sketch.entities.map((e) => {
          if (e.kind === "line") {
            const a = pointOf(m, e.p1), b = pointOf(m, e.p2);
            const [ax, ay] = toScreen(a.x, a.y), [bx, by] = toScreen(b.x, b.y);
            return <line key={e.id} x1={ax} y1={ay} x2={bx} y2={by} className={cls(e.id, e.construction ? "curve construction" : "curve")} />;
          }
          if (e.kind === "circle") {
            const c = pointOf(m, e.center);
            const [cx, cy] = toScreen(c.x, c.y);
            return <circle key={e.id} cx={cx} cy={cy} r={e.radius * view.scale} className={cls(e.id, e.construction ? "curve construction" : "curve")} />;
          }
          if (e.kind === "arc") {
            return <path key={e.id} d={arcPath(e)} className={cls(e.id, e.construction ? "curve construction" : "curve")} />;
          }
          if (e.kind === "ellipse" || e.kind === "spline") {
            return <path key={e.id} d={curvePath(e)} className={cls(e.id, e.construction ? "curve construction" : "curve")} />;
          }
          return null;
        })}
        {dims}
        {glyphs}
        {sketch.entities.map((e) => {
          if (e.kind !== "point") return null;
          const [sx, sy] = toScreen(e.x, e.y);
          return <circle key={e.id} cx={sx} cy={sy} r={selection.has(e.id) || hover?.id === e.id ? 5 : 3.5} className={cls(e.id, "pt")} />;
        })}
        {preview}
      </svg>

      {edit && (
        <input
          className="dim-input"
          style={{ left: edit.sx, top: edit.sy }}
          autoFocus
          value={edit.text}
          onChange={(e) => setEdit({ ...edit, text: e.target.value })}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitEdit();
            if (e.key === "Escape") setEdit(null);
          }}
          onBlur={commitEdit}
        />
      )}

      <div className="sketch-status">
        <span className={status?.dof === 0 && sketch.entities.length ? "ok" : ""}>{dofText}</span>
        {conflicting.size > 0 && <span className="error-msg">{conflicting.size} conflicting</span>}
        {message && <span className="error-msg">{message}</span>}
        {notice && !message && <span className="muted">{notice}</span>}
        {cursor && (
          <span className="muted right">
            x {fmt(Math.round(cursor.x * 10) / 10)} · y {fmt(Math.round(cursor.y * 10) / 10)}
          </span>
        )}
      </div>
    </div>
  );
}

function Glyph({ id, x, y, text, cls, onSelect }: { id: string; x: number; y: number; text: string; cls: string; onSelect: (id: string, additive: boolean) => void }) {
  return (
    <g
      className={cls}
      transform={`translate(${x},${y})`}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect(id, e.shiftKey || e.metaKey);
      }}
    >
      <rect x={-8} y={-8} width={16} height={16} rx={3} />
      <text textAnchor="middle" dominantBaseline="central">
        {text}
      </text>
    </g>
  );
}

/** Slot half width from the cursor: its distance to the line through the two centres. */
function slotWidth(a: { x: number; y: number }, b: { x: number; y: number }, x: number, y: number): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return Math.abs((x - a.x) * (b.y - a.y) - (y - a.y) * (b.x - a.x)) / len;
}

/** Minor radius from the cursor: its distance to the major axis line. */
function ellipseMinor(cx: number, cy: number, major: { x: number; y: number }, x: number, y: number): number {
  const a = Math.hypot(major.x - cx, major.y - cy) || 1;
  const ux = (major.x - cx) / a, uy = (major.y - cy) / a;
  return Math.abs(-(x - cx) * uy + (y - cy) * ux);
}
